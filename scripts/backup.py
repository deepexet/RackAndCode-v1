#!/usr/bin/env python3
"""Verified online backup and safe restore tooling for FieldOS SQLite."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_SOURCE = ROOT / "data" / "fieldos.db"
DEFAULT_OUTPUT = ROOT / "backups"


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def inspect_database(path: Path) -> dict[str, Any]:
    if not path.is_file():
        raise FileNotFoundError(path)
    connection = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=10)
    try:
        integrity = connection.execute("PRAGMA integrity_check").fetchone()[0]
        if integrity != "ok":
            raise RuntimeError(f"SQLite integrity check failed: {integrity}")
        tables = {row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        schema_version = connection.execute("SELECT MAX(version) FROM schema_migrations").fetchone()[0] if "schema_migrations" in tables else None
        organizations = connection.execute("SELECT COUNT(*) FROM organizations").fetchone()[0] if "organizations" in tables else 0
        workspaces = connection.execute("SELECT COUNT(*) FROM workspace_states").fetchone()[0] if "workspace_states" in tables else 0
        return {"integrity": integrity, "schemaVersion": schema_version, "organizationCount": organizations, "workspaceCount": workspaces}
    finally:
        connection.close()


def manifest_path(backup: Path) -> Path:
    return backup.with_name(f"{backup.name}.manifest.json")


def atomic_json_write(path: Path, payload: dict[str, Any]) -> None:
    temporary = path.with_name(f".{path.name}.tmp")
    temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    with temporary.open("rb") as stream:
        os.fsync(stream.fileno())
    os.replace(temporary, path)


def create_backup(source: Path, output_dir: Path, keep: int = 14) -> Path:
    if keep < 0:
        raise ValueError("keep must be zero or greater")
    source = source.resolve()
    inspect_database(source)
    output_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    backup = output_dir / f"fieldos-{stamp}.db"
    temporary = output_dir / f".{backup.name}.tmp"
    source_connection = sqlite3.connect(f"file:{source}?mode=ro", uri=True, timeout=10)
    target_connection = sqlite3.connect(temporary)
    try:
        source_connection.backup(target_connection)
    finally:
        target_connection.close()
        source_connection.close()
    inspect_database(temporary)
    with temporary.open("rb") as stream:
        os.fsync(stream.fileno())
    os.replace(temporary, backup)
    metadata = inspect_database(backup)
    manifest = {
        "formatVersion": 1,
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "database": backup.name,
        "size": backup.stat().st_size,
        "sha256": sha256_file(backup),
        **metadata,
    }
    atomic_json_write(manifest_path(backup), manifest)
    if keep:
        prune_backups(output_dir, keep)
    return backup


def verify_backup(backup: Path) -> dict[str, Any]:
    backup = backup.resolve()
    manifest_file = manifest_path(backup)
    if not manifest_file.is_file():
        raise FileNotFoundError(manifest_file)
    manifest = json.loads(manifest_file.read_text(encoding="utf-8"))
    if manifest.get("database") != backup.name:
        raise RuntimeError("Manifest database name mismatch")
    if manifest.get("size") != backup.stat().st_size:
        raise RuntimeError("Backup size mismatch")
    if manifest.get("sha256") != sha256_file(backup):
        raise RuntimeError("Backup checksum mismatch")
    metadata = inspect_database(backup)
    for key in ("schemaVersion", "organizationCount", "workspaceCount"):
        if manifest.get(key) != metadata[key]:
            raise RuntimeError(f"Backup metadata mismatch: {key}")
    return {**manifest, "verified": True}


def restore_backup(backup: Path, target: Path) -> Path:
    verify_backup(backup)
    if target.exists():
        raise FileExistsError(f"Restore target already exists: {target}")
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_name(f".{target.name}.restore.tmp")
    source_connection = sqlite3.connect(f"file:{backup.resolve()}?mode=ro", uri=True, timeout=10)
    target_connection = sqlite3.connect(temporary)
    try:
        source_connection.backup(target_connection)
    finally:
        target_connection.close()
        source_connection.close()
    inspect_database(temporary)
    os.replace(temporary, target)
    return target


def prune_backups(output_dir: Path, keep: int) -> list[Path]:
    if keep < 1:
        raise ValueError("keep must be at least one when pruning")
    backups = sorted(output_dir.glob("fieldos-*.db"), key=lambda path: path.stat().st_mtime, reverse=True)
    removed: list[Path] = []
    for backup in backups[keep:]:
        backup.unlink()
        manifest = manifest_path(backup)
        if manifest.exists():
            manifest.unlink()
        removed.append(backup)
    return removed


def main() -> int:
    parser = argparse.ArgumentParser(description="FieldOS verified SQLite backup tooling")
    subparsers = parser.add_subparsers(dest="command", required=True)
    create = subparsers.add_parser("create")
    create.add_argument("--source", type=Path, default=DEFAULT_SOURCE)
    create.add_argument("--output-dir", type=Path, default=DEFAULT_OUTPUT)
    create.add_argument("--keep", type=int, default=14)
    verify = subparsers.add_parser("verify")
    verify.add_argument("backup", type=Path)
    restore = subparsers.add_parser("restore")
    restore.add_argument("backup", type=Path)
    restore.add_argument("--target", type=Path, required=True)
    prune = subparsers.add_parser("prune")
    prune.add_argument("--output-dir", type=Path, default=DEFAULT_OUTPUT)
    prune.add_argument("--keep", type=int, required=True)
    args = parser.parse_args()
    try:
        if args.command == "create":
            result: Any = {"backup": str(create_backup(args.source, args.output_dir, args.keep))}
        elif args.command == "verify":
            result = verify_backup(args.backup)
        elif args.command == "restore":
            result = {"restored": str(restore_backup(args.backup, args.target))}
        else:
            result = {"removed": [str(path) for path in prune_backups(args.output_dir, args.keep)]}
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    except Exception as error:
        print(json.dumps({"error": type(error).__name__, "message": str(error)}, ensure_ascii=False), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())

