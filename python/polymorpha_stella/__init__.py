"""polymorpha_stella — Knowledge/Stella library (Python)."""
try:
    from polymorpha_stella.rag import StellaRagProfiler
except Exception:
    StellaRagProfiler = None  # type: ignore

__all__ = ["StellaRagProfiler"]
