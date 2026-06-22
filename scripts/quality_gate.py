#!/usr/bin/env python3
"""Dependency-free repository quality and security gate."""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ALLOWED_STATUS = {"ideas", "backlog", "ready", "progress", "blocked", "review", "testing", "done"}
ALLOWED_PRIORITY = {"critical", "high", "medium", "low"}
SOURCE_SUFFIXES = {".py", ".js", ".html", ".css", ".md", ".json", ".yaml", ".yml", ".sql", ".sh"}
IGNORED_PARTS = {".git", "data", "__pycache__"}
SECRET_PATTERNS = {
    "private key": re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----"),
    "AWS access key": re.compile(r"AKIA[0-9A-Z]{16}"),
    "generic API token": re.compile(r"(?i)(?:api[_-]?key|secret|token)\s*[:=]\s*['\"][A-Za-z0-9_\-]{24,}['\"]"),
}


def fail(message: str, failures: list[str]) -> None:
    failures.append(message)


def check_roadmap(failures: list[str]) -> None:
    roadmap = json.loads((ROOT / "planning" / "project-tasks.json").read_text(encoding="utf-8"))
    tasks = roadmap["tasks"]
    ids = [task["id"] for task in tasks]
    if len(ids) != len(set(ids)):
        fail("Roadmap contains duplicate task IDs", failures)
    known = set(ids) | {f"FS-{number:03d}" for number in range(1, 13)}
    for task in tasks:
        if task["status"] not in ALLOWED_STATUS:
            fail(f"{task['id']}: invalid status", failures)
        if task["priority"] not in ALLOWED_PRIORITY:
            fail(f"{task['id']}: invalid priority", failures)
        if not task["title"].strip() or len(task["title"]) > 120:
            fail(f"{task['id']}: invalid title", failures)
        for dependency in task.get("dependsOn", []):
            if dependency not in known:
                fail(f"{task['id']}: unknown dependency {dependency}", failures)


def check_sbom(failures: list[str]) -> None:
    package = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
    sbom = json.loads((ROOT / "sbom.cdx.json").read_text(encoding="utf-8"))
    component = sbom["metadata"]["component"]
    if component["name"] != package["name"] or component["version"] != package["version"]:
        fail("SBOM component does not match package.json", failures)


def check_secrets(failures: list[str]) -> None:
    for path in ROOT.rglob("*"):
        if not path.is_file() or path.suffix not in SOURCE_SUFFIXES or any(part in IGNORED_PARTS for part in path.parts):
            continue
        if path.resolve() == Path(__file__).resolve():
            continue
        content = path.read_text(encoding="utf-8", errors="ignore")
        for label, pattern in SECRET_PATTERNS.items():
            if pattern.search(content):
                fail(f"Potential {label} in {path.relative_to(ROOT)}", failures)


def main() -> int:
    failures: list[str] = []
    check_roadmap(failures)
    check_sbom(failures)
    check_secrets(failures)
    if failures:
        print("Quality gate failed:")
        for item in failures:
            print(f"- {item}")
        return 1
    print("Quality gate passed: roadmap, SBOM, and secret scan")
    return 0


if __name__ == "__main__":
    sys.exit(main())
