/**
 * OpenCode chat transport (`ts/src/stella/brain/OpenCodeTransport.ts`).
 * Pure fetch-router mocks — no server, no LLM cost. Shapes mirror the live
 * 1.18.31 API verified during implementation (probe 2026-09-16).
 */
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  openCodeComplete,
  openCodeHealth,
  foldHistoryForOpenCode,
} from "@/stella/brain/OpenCodeTransport";

const BASE = "http://127.0.0.1:4096";
const MODEL = {
  providerID: "opencode-go",
  modelID: "muse-spark-1.2-contributor",
};

interface Route {
  match: (url: string, init?: RequestInit) => boolean;
  respond: (url: string, init?: RequestInit) => Response | Promise<Response>;
}

let routes: Route[] = [];
const seen: Array<{ url: string; init?: RequestInit }> = [];

function jsonBody(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function assistantReply(text: string): unknown {
  return {
    info: { role: "assistant" },
    parts: [
      { type: "step-start" },
      { type: "text", text },
      { type: "step-finish" },
    ],
  };
}

beforeEach(() => {
  routes = [];
  seen.length = 0;
  global.fetch = vi.fn(async (url: unknown, init?: RequestInit) => {
    const u = String(url);
    seen.push({ url: u, init });
    for (const r of routes) {
      if (r.match(u, init)) return r.respond(u, init);
    }
    throw new Error(`unexpected fetch: ${u}`);
  }) as unknown as typeof fetch;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function okSessionRoutes(replyText: string): void {
  routes = [
    {
      match: (u) => u === `${BASE}/session`,
      respond: () => jsonBody({ id: "ses_test" }),
    },
    {
      match: (u) => u === `${BASE}/session/ses_test/message`,
      respond: () => jsonBody(assistantReply(replyText)),
    },
    {
      match: (u) => u === `${BASE}/session/ses_test`,
      respond: () => jsonBody(true),
    },
  ];
}

describe("foldHistoryForOpenCode", () => {
  it("folds prior turns and skips empties", () => {
    expect(
      foldHistoryForOpenCode(
        [
          { role: "user", content: "first q" },
          { role: "assistant", content: "first a" },
          { role: "user", content: "   " },
        ],
        "second q",
      ),
    ).toBe("User: first q\n\nAssistant: first a\n\nUser: second q");
  });
});

describe("openCodeHealth", () => {
  it("returns version on healthy, null otherwise", async () => {
    routes = [
      {
        match: (u) => u === `${BASE}/global/health`,
        respond: () => jsonBody({ healthy: true, version: "1.18.31" }),
      },
    ];
    await expect(openCodeHealth(BASE)).resolves.toEqual({
      healthy: true,
      version: "1.18.31",
    });
    global.fetch = vi.fn(async () =>
      jsonBody({}, 503),
    ) as unknown as typeof fetch;
    await expect(openCodeHealth(BASE)).resolves.toBeNull();
    global.fetch = vi.fn(async () => {
      throw new Error("down");
    }) as unknown as typeof fetch;
    await expect(openCodeHealth(BASE)).resolves.toBeNull();
  });
});

describe("openCodeComplete", () => {
  it("creates, sends without tools, parses text parts, deletes", async () => {
    okSessionRoutes("```python\nprint(1)\n```");
    const text = await openCodeComplete({
      baseUrl: BASE,
      model: MODEL,
      system: "sys",
      history: [{ role: "user", content: "hi" }],
      content: "fix it",
    });
    expect(text).toBe("```python\nprint(1)\n```");
    const msg = seen.find((s) => s.url.endsWith("/message"));
    const body = JSON.parse(String(msg?.init?.body)) as Record<string, unknown>;
    expect(body["agent"]).toBe("general");
    expect(body["tools"]).toEqual({});
    expect(body["system"]).toBe("sys");
    expect(body["model"]).toEqual(MODEL);
    const parts = body["parts"] as Array<{ type: string; text: string }>;
    expect(parts[0].text).toContain("User: hi");
    expect(parts[0].text).toContain("User: fix it");
    expect(seen.some((s) => s.url === `${BASE}/session/ses_test`)).toBe(true);
  });

  it("sends basic auth when a password is configured", async () => {
    okSessionRoutes("ok");
    await openCodeComplete({
      baseUrl: BASE,
      model: MODEL,
      password: "s3cret",
      system: "sys",
      history: [],
      content: "hi",
    });
    const msg = seen.find((s) => s.url.endsWith("/message"));
    const auth = (msg?.init?.headers as Record<string, string>)[
      "Authorization"
    ];
    expect(auth).toBe(
      `Basic ${Buffer.from("opencode:s3cret").toString("base64")}`,
    );
  });

  it("throws provider errors embedded with HTTP 200", async () => {
    routes = [
      {
        match: (u) => u === `${BASE}/session`,
        respond: () => jsonBody({ id: "ses_test" }),
      },
      {
        match: (u) => u.endsWith("/message"),
        respond: () =>
          jsonBody({
            info: {
              role: "assistant",
              error: {
                name: "APIError",
                data: { message: "Insufficient balance", statusCode: 401 },
              },
            },
            parts: [],
          }),
      },
      {
        match: () => true,
        respond: () => jsonBody(true),
      },
    ];
    await expect(
      openCodeComplete({
        baseUrl: BASE,
        model: MODEL,
        system: "sys",
        history: [],
        content: "hi",
      }),
    ).rejects.toThrow("OpenCode provider error: Insufficient balance");
  });

  it("rejects empty and prose-thin replies", async () => {
    okSessionRoutes("   ");
    await expect(
      openCodeComplete({
        baseUrl: BASE,
        model: MODEL,
        system: "sys",
        history: [],
        content: "hi",
      }),
    ).rejects.toThrow("Empty response from Stella");
  });

  it("reports an unreachable server actionably", async () => {
    global.fetch = vi.fn(async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    await expect(
      openCodeComplete({
        baseUrl: BASE,
        model: MODEL,
        system: "sys",
        history: [],
        content: "hi",
      }),
    ).rejects.toThrow("OpenCode server unreachable");
  });

  it("propagates caller aborts unchanged", async () => {
    global.fetch = vi.fn(async (_u: unknown, init?: RequestInit) => {
      init?.signal?.throwIfAborted();
      return jsonBody({});
    }) as unknown as typeof fetch;
    const c = new AbortController();
    c.abort();
    await expect(
      openCodeComplete({
        baseUrl: BASE,
        model: MODEL,
        system: "sys",
        history: [],
        content: "hi",
        signal: c.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});
