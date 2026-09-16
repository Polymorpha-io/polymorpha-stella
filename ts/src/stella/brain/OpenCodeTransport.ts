/**
 * OpenCodeTransport — Stella chat via a local `opencode serve` instance.
 *
 * Verified live against opencode 1.18.31 (`GET /global/health`,
 * `POST /session`, `POST /session/:id/message`, `DELETE /session/:id`).
 * Same callback contract as the Groq path (full text → caller), so
 * `BrainService.answerStreaming` branches here with zero UI changes.
 *
 * Safety: every turn runs with `agent:"general"` + `tools:{}` — Stella only
 * needs generated text (the UI applies fenced code via its own diff flow),
 * so the server must never edit files or run shells on our behalf. The
 * session `directory` is the server cwd (often this repo).
 *
 * Stateless per turn: one OpenCode session is created, used once with the
 * already-windowed history folded into the message, then deleted
 * best-effort. No session map, no cross-turn leakage, no 404-retry logic.
 */
import { STELLA_REQUEST_TIMEOUT_MS } from "../../config/retrieval";
import type { OpenCodeModelRef } from "../../config/StellaConfig";
import type { IStellaMessage } from "../types";

export interface OpenCodeChatOptions {
  /** `opencode serve` base URL, no trailing slash. */
  baseUrl: string;
  /** Connected server-side model (e.g. opencode-go/gpt-5.6-luna). */
  model: OpenCodeModelRef;
  /** `OPENCODE_SERVER_PASSWORD` when the server requires basic auth. */
  password?: string;
  /** Per-turn deadline (default `STELLA_REQUEST_TIMEOUT_MS`). */
  timeoutMs?: number;
}

export interface OpenCodeHealth {
  healthy: boolean;
  version: string;
}

interface OpenCodePart {
  type?: string;
  text?: string;
}

interface OpenCodeMessageResponse {
  info?: {
    role?: string;
    error?: { name?: string; data?: { message?: string; statusCode?: number } };
  };
  parts?: OpenCodePart[];
}

function base64(input: string): string {
  if (typeof btoa !== "undefined") return btoa(input);
  // Node/vitest fallback (browser-first lib, `btoa` normally present).
  const buf = (
    globalThis as unknown as {
      Buffer?: { from(s: string): { toString(e: string): string } };
    }
  ).Buffer;
  if (buf) return buf.from(input).toString("base64");
  throw new Error("OpenCode basic auth needs btoa or Buffer");
}

function headers(password?: string): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (password) h["Authorization"] = `Basic ${base64(`opencode:${password}`)}`;
  return h;
}

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${path}`;
}

function isAbortError(err: unknown): boolean {
  return (
    (typeof DOMException !== "undefined" &&
      err instanceof DOMException &&
      err.name === "AbortError") ||
    (err instanceof Error && err.name === "AbortError")
  );
}

/** Availability probe — never throws (callers treat null as "no server"). */
export async function openCodeHealth(
  baseUrl: string,
  password?: string,
): Promise<OpenCodeHealth | null> {
  try {
    const res = await fetch(joinUrl(baseUrl, "/global/health"), {
      headers: headers(password),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as {
      healthy?: boolean;
      version?: string;
    };
    if (json.healthy !== true || typeof json.version !== "string") return null;
    return { healthy: true, version: json.version };
  } catch {
    return null;
  }
}

/** Fold windowed history into one user text (the per-turn session is fresh). */
export function foldHistoryForOpenCode(
  history: IStellaMessage[],
  content: string,
): string {
  const turns = history
    .filter((m) => (m.content ?? "").trim().length > 0)
    .map((m) =>
      m.role === "assistant" ? `Assistant: ${m.content}` : `User: ${m.content}`,
    );
  turns.push(`User: ${content}`);
  return turns.join("\n\n");
}

/** One stateless turn: create → send (no tools) → parse → delete. Throws. */
export async function openCodeComplete(
  opts: OpenCodeChatOptions & {
    system: string;
    history: IStellaMessage[];
    content: string;
    signal?: AbortSignal;
  },
): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? STELLA_REQUEST_TIMEOUT_MS;
  const timeoutSignal =
    typeof AbortSignal.timeout !== "undefined"
      ? AbortSignal.timeout(timeoutMs)
      : undefined;
  const signal =
    opts.signal && timeoutSignal && typeof AbortSignal.any !== "undefined"
      ? AbortSignal.any([opts.signal, timeoutSignal])
      : (opts.signal ?? timeoutSignal);
  const h = headers(opts.password);
  const post = async (path: string, body: unknown): Promise<Response> => {
    let res: Response;
    try {
      res = await fetch(joinUrl(opts.baseUrl, path), {
        method: "POST",
        headers: h,
        body: JSON.stringify(body),
        signal,
      });
    } catch (err) {
      if (isAbortError(err)) throw err;
      throw new Error(
        `OpenCode server unreachable at ${opts.baseUrl} (is \`opencode serve\` running?)`,
      );
    }
    return res;
  };

  const created = await post("/session", { title: "stella" });
  if (!created.ok) {
    throw new Error(
      `OpenCode session failed (${created.status}): ${await created.text().catch(() => "unknown error")}`,
    );
  }
  const session = (await created.json()) as { id?: string };
  if (!session.id) throw new Error("OpenCode session reply had no id");
  const sessionId = session.id;

  try {
    const sent = await post(`/session/${sessionId}/message`, {
      model: {
        providerID: opts.model.providerID,
        modelID: opts.model.modelID,
      },
      agent: "general",
      system: opts.system,
      tools: {},
      parts: [
        {
          type: "text",
          text: foldHistoryForOpenCode(opts.history, opts.content),
        },
      ],
    });
    // The API reports provider failures HTTP 200 with `info.error`.
    const json = (await sent.json()) as OpenCodeMessageResponse;
    const apiErr =
      json.info?.error?.data?.message ?? json.info?.error?.name ?? null;
    if (apiErr) throw new Error(`OpenCode provider error: ${apiErr}`);
    const text = (json.parts ?? [])
      .filter((p) => p.type === "text" && (p.text ?? "").trim().length > 0)
      .map((p) => (p.text as string).replace(/<\/?think>/g, ""))
      .join("");
    if (!text.trim()) throw new Error("Empty response from Stella");
    return text;
  } finally {
    // Best-effort cleanup: a failed delete must never fail the turn.
    try {
      await fetch(joinUrl(opts.baseUrl, `/session/${sessionId}`), {
        method: "DELETE",
        headers: h,
        signal: AbortSignal.timeout(5000),
      });
    } catch {
      /* session GC is server-side */
    }
  }
}
