"""Transactional, checksum-validated SQLite migrations."""

from __future__ import annotations

import hashlib
import re
import sqlite3
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterator


class MigrationChecksumError(RuntimeError):
    pass


@dataclass(frozen=True)
class MigrationResult:
    applied: tuple[str, ...]
    current_version: str | None


class MigrationRunner:
    def __init__(self, db_path: Path, migrations_dir: Path):
        self.db_path = db_path
        self.migrations_dir = migrations_dir

    @contextmanager
    def _connect(self) -> Iterator[sqlite3.Connection]:
        connection = sqlite3.connect(self.db_path, timeout=10)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA journal_mode=WAL")
        connection.execute("PRAGMA foreign_keys=ON")
        connection.execute("PRAGMA busy_timeout=5000")
        try:
            with connection:
                yield connection
        finally:
            connection.close()

    def apply(self) -> MigrationResult:
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        files = sorted(self.migrations_dir.glob("[0-9][0-9][0-9]_*.sql"))
        applied_now: list[str] = []
        with self._connect() as connection:
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS schema_migrations (
                    version TEXT PRIMARY KEY,
                    checksum TEXT NOT NULL,
                    applied_at TEXT NOT NULL
                )
                """
            )
            known = {
                row["version"]: row["checksum"]
                for row in connection.execute("SELECT version, checksum FROM schema_migrations")
            }
            for path in files:
                version = path.name.split("_", 1)[0]
                sql = path.read_text(encoding="utf-8")
                checksum = hashlib.sha256(sql.encode("utf-8")).hexdigest()
                if version in known:
                    if known[version] != checksum:
                        raise MigrationChecksumError(f"Migration {version} checksum mismatch")
                    continue
                try:
                    # Some historical installations received additive columns
                    # out-of-band.  Numbered migrations can declare an additive,
                    # idempotent repair without failing on those installations:
                    #   -- ensure-column table column SQL_TYPE DEFAULT ...
                    ensure_sql: list[str] = []
                    for table, column, declaration in re.findall(
                        r"^-- ensure-column ([A-Za-z_][A-Za-z0-9_]*) ([A-Za-z_][A-Za-z0-9_]*) (.+)$",
                        sql,
                        flags=re.MULTILINE,
                    ):
                        existing = {
                            row["name"]
                            for row in connection.execute(f'PRAGMA table_info("{table}")')
                        }
                        if column not in existing:
                            ensure_sql.append(
                                f'ALTER TABLE "{table}" ADD COLUMN "{column}" {declaration};'
                            )
                    connection.executescript(
                        "BEGIN IMMEDIATE;\n" + "\n".join(ensure_sql) + "\n" + sql + "\n"
                    )
                    connection.execute(
                        "INSERT INTO schema_migrations (version, checksum, applied_at) VALUES (?, ?, ?)",
                        (version, checksum, datetime.now(timezone.utc).isoformat()),
                    )
                    connection.commit()
                except Exception:
                    connection.rollback()
                    raise
                known[version] = checksum
                applied_now.append(version)
        return MigrationResult(tuple(applied_now), max(known, default=None))
