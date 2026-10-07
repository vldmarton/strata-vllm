"""Uvicorn entrypoint for the verify toolchain and `uvicorn main:app`.

The real app lives in server.py; this re-exports it so the standard
FastAPI recipe (uvicorn main:app) works. Run the full server directly
with `python server.py` instead.
"""
from server import app  # noqa: F401
