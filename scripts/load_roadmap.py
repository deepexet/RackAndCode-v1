#!/usr/bin/env python3
"""Idempotently add planned work to the local FieldOS Kanban."""

from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_PLAN = ROOT / "planning" / "project-tasks.json"


def request_json(url: str, method: str = "GET", payload: dict | None = None, organization: str = "local-dev") -> dict:
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8") if payload is not None else None
    request = Request(url, data=body, method=method, headers={"Content-Type": "application/json", "Accept": "application/json", "X-Organization-ID": organization})
    with urlopen(request, timeout=10) as response:
        return json.load(response)


def main() -> None:
    parser = argparse.ArgumentParser(description="Load the TRD roadmap into FieldOS")
    parser.add_argument("--url", default="http://127.0.0.1:4173")
    parser.add_argument("--plan", type=Path, default=DEFAULT_PLAN)
    parser.add_argument("--organization", default="local-dev")
    args = parser.parse_args()

    plan = json.loads(args.plan.read_text(encoding="utf-8"))
    workspace = request_json(f"{args.url}/api/v1/workspace", organization=args.organization)
    existing_by_id = {task["id"]: task for task in workspace["tasks"]}
    added = 0
    enriched = 0

    for planned in plan["tasks"]:
        current = existing_by_id.get(planned["id"])
        if current is None:
            workspace["tasks"].append(planned)
            existing_by_id[planned["id"]] = planned
            added += 1
            continue
        # Descriptive planning metadata may evolve; manual workflow choices always win.
        for field in ("description", "risk", "parentId", "dependsOn", "priorityReason", "unblocks"):
            if field in planned:
                current[field] = planned[field]
        enriched += 1

    event = {
        "at": datetime.now(timezone.utc).isoformat(),
        "text": f"TRD roadmap: добавлено {added}, обновлено {enriched}; ручные статусы и приоритеты сохранены",
    }
    workspace["audit"].insert(0, event)
    result = request_json(
        f"{args.url}/api/v1/workspace",
        method="PUT",
        payload={
            "expectedRevision": workspace["revision"],
            "tasks": workspace["tasks"],
            "audit": workspace["audit"][:30],
        },
        organization=args.organization,
    )
    print(json.dumps({"added": added, "enriched": enriched, "total": len(workspace["tasks"]), **result}, ensure_ascii=False))


if __name__ == "__main__":
    main()
