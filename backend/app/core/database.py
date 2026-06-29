"""SQLite connection management with WAL mode and migration runner."""
from __future__ import annotations

import sqlite3
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator

from app.core.config import settings


def _init_db(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(path) as conn:
        if settings.db_wal:
            conn.execute("PRAGMA journal_mode=WAL")
            conn.execute("PRAGMA synchronous=NORMAL")
        conn.execute("PRAGMA foreign_keys=ON")
        conn.execute("PRAGMA cache_size=-32000")  # 32 MB
        conn.execute("PRAGMA temp_store=MEMORY")


@contextmanager
def get_connection() -> Iterator[sqlite3.Connection]:
    conn = sqlite3.connect(
        settings.db_path,
        check_same_thread=False,
        timeout=30,
        detect_types=sqlite3.PARSE_DECLTYPES,
    )
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys=ON")
    if settings.db_wal:
        conn.execute("PRAGMA journal_mode=WAL")
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def run_migrations() -> None:
    """Apply all pending SQL migrations in order."""
    from server.migrations import MigrationRunner  # reuse existing runner

    runner = MigrationRunner(settings.db_path, settings.migrations_dir)
    runner.apply()
