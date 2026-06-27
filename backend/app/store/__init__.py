"""
Store layer — wraps the existing WorkspaceStore during migration.

Migration path:
  Phase 1 (current): import WorkspaceStore from legacy server/app.py, expose it here.
  Phase 2: Extract domain mixins one-by-one into store/<domain>.py files.
  Phase 3: Remove dependency on legacy app.py entirely.

This module is the ONLY place backend code should import the store.
"""
from __future__ import annotations

import sys
from pathlib import Path

# Ensure the repo root is on the path so we can import server.*
_ROOT = Path(__file__).resolve().parents[4]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from server.app import WorkspaceStore  # noqa: E402  (legacy import during migration)

__all__ = ["WorkspaceStore"]
