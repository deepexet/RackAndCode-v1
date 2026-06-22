#!/usr/bin/env python3
"""Opt-in FieldOS telemetry agent for Apple Silicon Macs."""

from __future__ import annotations

import argparse
import json
import os
import platform
import re
import socket
import subprocess
import time
import uuid
from pathlib import Path
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parent.parent
AGENT_VERSION = "0.1.0"


def command(*args: str) -> str:
    try:
        return subprocess.run(args, check=True, capture_output=True, text=True, timeout=8).stdout
    except (OSError, subprocess.SubprocessError):
        return ""


def total_memory() -> int:
    value = command("sysctl", "-n", "hw.memsize").strip()
    return int(value) if value.isdigit() else 0


def memory_used(total: int) -> int:
    output = command("vm_stat")
    page_match = re.search(r"page size of (\d+) bytes", output)
    page_size = int(page_match.group(1)) if page_match else 4096
    values = {name: int(value.replace(".", "")) for name, value in re.findall(r"^([^:]+):\s+([\d.]+)", output, re.MULTILINE)}
    available_pages = sum(values.get(name, 0) for name in ("Pages free", "Pages inactive", "Pages speculative"))
    return max(0, min(total, total - available_pages * page_size))


def cpu_percent() -> float:
    output = command("ps", "-A", "-o", "%cpu=")
    used = sum(float(value) for value in output.split() if re.fullmatch(r"\d+(?:\.\d+)?", value))
    return round(max(0.0, min(100.0, used / max(1, os.cpu_count() or 1))), 1)


def battery() -> tuple[float | None, str, bool | None]:
    output = command("pmset", "-g", "batt")
    percent = re.search(r"(\d+)%", output)
    source = "ac" if "AC Power" in output else ("battery" if "Battery Power" in output else "unknown")
    charging = None if not output else ("charging" in output.lower() or "charged" in output.lower())
    return (float(percent.group(1)) if percent else None, source, charging)


def thermal_state() -> str:
    output = command("pmset", "-g", "therm")
    limit = re.search(r"CPU_Speed_Limit\s*=\s*(\d+)", output)
    if not limit:
        return "unknown"
    value = int(limit.group(1))
    return "serious" if value < 50 else ("fair" if value < 80 else "nominal")


def stable_node_id(path: Path) -> str:
    if path.exists():
        return path.read_text(encoding="utf-8").strip()
    path.parent.mkdir(parents=True, exist_ok=True)
    value = str(uuid.uuid4())
    path.write_text(value, encoding="utf-8")
    path.chmod(0o600)
    return value


def collect(name: str, compute_enabled: bool) -> dict:
    total = total_memory()
    battery_percent, power_source, charging = battery()
    return {
        "name": name,
        "hostname": socket.gethostname(),
        "platform": f"macOS {platform.mac_ver()[0]}",
        "architecture": platform.machine(),
        "agentVersion": AGENT_VERSION,
        "computeEnabled": compute_enabled,
        "metric": {
            "cpuPercent": cpu_percent(),
            "memoryUsedBytes": memory_used(total),
            "memoryTotalBytes": total,
            "batteryPercent": battery_percent,
            "powerSource": power_source,
            "charging": charging,
            "thermalState": thermal_state(),
            "loadAverage": round(os.getloadavg()[0], 2),
        },
    }


def send(server: str, organization: str, token: str, node_id: str, payload: dict) -> None:
    request = Request(
        f"{server.rstrip('/')}/api/v1/telemetry/nodes/{node_id}",
        data=json.dumps(payload).encode("utf-8"),
        method="POST",
        headers={"Content-Type": "application/json", "X-Organization-ID": organization, "X-Agent-Token": token},
    )
    with urlopen(request, timeout=10) as response:
        if response.status != 201:
            raise RuntimeError(f"Unexpected server response: {response.status}")


def main() -> None:
    parser = argparse.ArgumentParser(description="FieldOS macOS telemetry and compute opt-in agent")
    parser.add_argument("--server", default=os.getenv("FIELDOS_SERVER", "http://127.0.0.1:4173"))
    parser.add_argument("--organization", default=os.getenv("FIELDOS_ORGANIZATION", "local-dev"))
    parser.add_argument("--token", default=os.getenv("FIELDOS_AGENT_TOKEN", ""))
    parser.add_argument("--token-file", type=Path, default=ROOT / "data" / "agent.token")
    parser.add_argument("--node-id-file", type=Path, default=Path.home() / ".fieldos" / "node-id")
    parser.add_argument("--name", default=platform.node())
    parser.add_argument("--interval", type=int, default=5)
    parser.add_argument("--compute-enabled", action="store_true", help="Explicitly allow this node to receive compute jobs")
    parser.add_argument("--once", action="store_true")
    args = parser.parse_args()
    token = args.token or (args.token_file.read_text(encoding="utf-8").strip() if args.token_file.exists() else "")
    if not token:
        raise SystemExit("Agent token is required via --token, FIELDOS_AGENT_TOKEN, or --token-file")
    node_id = stable_node_id(args.node_id_file)
    while True:
        try:
            send(args.server, args.organization, token, node_id, collect(args.name, args.compute_enabled))
            print(json.dumps({"event": "heartbeat_sent", "nodeId": node_id, "server": args.server, "computeEnabled": args.compute_enabled}))
        except Exception as error:
            print(json.dumps({"event": "heartbeat_failed", "error": str(error)}))
        if args.once:
            break
        time.sleep(max(2, args.interval))


if __name__ == "__main__":
    main()
