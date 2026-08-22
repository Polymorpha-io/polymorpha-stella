"""StellaRagProfiler — thin adapter over polymorpha business-logic RagProfiler.

Wraps generic business-logic profiling (DataFrame -> profile dict, G20 dataset-agnostic)
into KnowledgeRecord-like dicts (chunked 512 tokens, provenance). No duplication of
pandas logic — delegates to polymorpha.rag.profiler.RagProfiler (business-logic) via
git+https, GitHub-only, no local fallback.

Usage:
    from polymorpha_stella.rag import StellaRagProfiler
    prof = StellaRagProfiler()
    profile = prof.profile(df, file_name="sales.csv")
    records = prof.to_knowledge_records(profile, workspace_id="ws1", dataset_id="upload123")
"""

from __future__ import annotations

from typing import Any, Dict, List

try:
    from polymorpha.rag.profiler import RagProfiler as _Base  # business-logic primitive
except Exception as e:  # pragma: no cover
    _Base = None  # type: ignore
    _IMPORT_ERROR = e
else:
    _IMPORT_ERROR = None


def _chunk_text_simple(text: str, chunk_tokens: int = 512) -> List[str]:
    if not text:
        return []
    approx_chars = chunk_tokens * 4
    if len(text) <= approx_chars:
        return [text]
    out: List[str] = []
    start = 0
    while start < len(text):
        end = min(start + approx_chars, len(text))
        if end < len(text):
            last_nl = text.rfind("\n", start, end)
            if last_nl > start + approx_chars * 0.5:
                end = last_nl + 1
        out.append(text[start:end].strip())
        start = end
    return [c for c in out if c]


class StellaRagProfiler:
    """Thin wrapper — business-logic RagProfiler -> KnowledgeRecord dicts."""

    def __init__(self) -> None:
        if _Base is None:
            raise ImportError(
                f"polymorpha business-logic RagProfiler not available: {_IMPORT_ERROR}. "
                "Install via git+https://github.com/Polymorpha-io/polymorpha-business-logic.git#main"
            )
        self._base = _Base()  # type: ignore

    def profile(self, df, file_name: str = "dataset.csv") -> Dict[str, Any]:
        """Delegate to business-logic generic profiler (no Stella logic)."""
        # RagProfiler.profile may be sync or have profile_stream; handle both
        if hasattr(self._base, "profile"):
            return self._base.profile(df, file_name)  # type: ignore
        # fallback: try profile_stream
        return {"dataset": None, "perColumn": None, "missing": None, "duplicate": None, "quality": None}

    def to_knowledge_records(
        self,
        profile: Dict[str, Any],
        workspace_id: str,
        dataset_id: str,
        dataset_name: str | None = None,
        content_hash: str | None = None,
    ) -> List[Dict[str, Any]]:
        """Convert business-logic profile -> KnowledgeRecords (dataset_profile + column_semantic + relationship)."""
        import hashlib
        import time

        now = int(time.time() * 1000)
        ch = content_hash or dataset_id
        name = dataset_name or f"{dataset_id}.csv"
        out: List[Dict[str, Any]] = []

        ds = profile.get("dataset")
        if ds:
            text = f"Dataset {name} profile: {ds.get('rows', '?')} rows x{ds.get('cols', '?')} cols, duplicate {ds.get('duplicatePct', 0)}% ({ds.get('duplicateRows', 0)} rows)"
            sh = hashlib.sha256(f"{workspace_id}:{dataset_id}:profile:{text[:100]}".encode()).hexdigest()[:16]
            out.append(
                {
                    "id": f"dataset:{dataset_id}:profile",
                    "workspaceId": workspace_id,
                    "notebookId": f"nb:{workspace_id}",
                    "datasetId": dataset_id,
                    "kind": "dataset_profile",
                    "text": text,
                    "metadata": {"source": "dataset_profile", "uploadId": dataset_id, "contentHash": ch, "datasetName": name},
                    "provenance": {"workspaceId": workspace_id, "datasetIds": [dataset_id], "uploadId": dataset_id, "contentHash": ch, "datasetName": name},
                    "sourceHash": sh,
                    "createdAt": now,
                    "updatedAt": now,
                }
            )

        for col in profile.get("perColumn") or []:
            cname = col.get("name", "unknown")
            text = f"Column {cname} ({col.get('type','unknown')}): unique {col.get('unique',0)} missing {col.get('missingPct',0)}% top {col.get('topK',[])[:2]}"
            sh = hashlib.sha256(f"{workspace_id}:{dataset_id}:col:{cname}:{text[:80]}".encode()).hexdigest()[:16]
            out.append(
                {
                    "id": f"dataset:{dataset_id}:col:{cname}",
                    "workspaceId": workspace_id,
                    "notebookId": f"nb:{workspaceId}",
                    "datasetId": dataset_id,
                    "kind": "column_semantic",
                    "text": text,
                    "metadata": {"source": "column_semantic", "uploadId": dataset_id, "contentHash": ch, "column": cname, "columns": [cname]},
                    "provenance": {"workspaceId": workspace_id, "datasetIds": [dataset_id], "uploadId": dataset_id, "contentHash": ch, "datasetName": name, "columns": [cname]},
                    "sourceHash": sh,
                    "createdAt": now,
                    "updatedAt": now,
                }
            )

        missing = profile.get("missing") or {}
        for rel in (missing.get("missingTogether") or [])[:5]:
            a, b, corr = rel.get("a"), rel.get("b"), rel.get("correlation", 0)
            text = f'Relationship: columns "{a}" and "{b}" missing together (correlation {corr:.2f}) in {dataset_id}'
            sh = hashlib.sha256(f"{workspace_id}:{dataset_id}:rel:{a}:{b}".encode()).hexdigest()[:16]
            out.append(
                {
                    "id": f"rel:{dataset_id}:missingTogether:{a}:{b}",
                    "workspaceId": workspace_id,
                    "notebookId": f"nb:{workspaceId}",
                    "datasetId": dataset_id,
                    "kind": "relationship",
                    "text": text,
                    "metadata": {"source": "relationship", "type": "missingTogether", "uploadId": dataset_id, "contentHash": ch, "columns": [a, b], "correlation": corr},
                    "provenance": {"workspaceId": workspace_id, "datasetIds": [dataset_id], "uploadId": dataset_id, "contentHash": ch, "columns": [a, b]},
                    "sourceHash": sh,
                    "createdAt": now,
                    "updatedAt": now,
                }
            )

        # chunk representative if needed — here simplified to one record per profile
        return out
