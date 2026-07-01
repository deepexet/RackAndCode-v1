#!/usr/bin/env python3
"""Manage the persistent local RackPilot development/coordinator stack."""

from __future__ import annotations

import json
import os
import secrets
import signal
import subprocess
import sys
import time
import urllib.request
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"
PID_PATH = DATA / "coordinator-stack.pid"
TOKEN_PATH = DATA / "coordinator.token"
LOG_PATH = DATA / "coordinator-stack.log"
PYTHON = ROOT / ".venv-coordinator312" / "bin" / "python"
CANONICAL_APP_DB = ROOT.parent / "ValProjects" / "data" / "rackpilot.db"
CANONICAL_COORDINATOR_DB = ROOT.parent / "ValProjects-codex-coordinator" / "data" / "coordinator.db"


def _pid() -> int | None:
    try:
        value = int(PID_PATH.read_text(encoding="utf-8").strip())
        os.kill(value, 0)
        return value
    except (ValueError, OSError, FileNotFoundError):
        return None


def _token() -> str:
    DATA.mkdir(parents=True, exist_ok=True)
    if not TOKEN_PATH.exists():
        TOKEN_PATH.write_text(secrets.token_urlsafe(48), encoding="utf-8")
        TOKEN_PATH.chmod(0o600)
    return TOKEN_PATH.read_text(encoding="utf-8").strip()


def _health() -> dict[str, object] | None:
    coordinator_port = os.getenv("RACKPILOT_COORDINATOR_PORT", "4180")
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{coordinator_port}/health", timeout=2) as response:
            return json.loads(response.read().decode("utf-8"))
    except (OSError, ValueError):
        return None


def status() -> int:
    pid = _pid()
    health = _health()
    print(json.dumps({"running": bool(pid), "pid": pid, "health": health}, indent=2))
    return 0 if pid and health else 1


def start() -> int:
    if _pid():
        return status()
    if not PYTHON.exists():
        print(f"Missing coordinator runtime: {PYTHON}", file=sys.stderr)
        return 2
    DATA.mkdir(parents=True, exist_ok=True)
    with LOG_PATH.open("ab", buffering=0) as log:
        process = subprocess.Popen(
            [str(PYTHON), str(Path(__file__).resolve()), "run"],
            cwd=ROOT,
            stdin=subprocess.DEVNULL,
            stdout=log,
            stderr=subprocess.STDOUT,
            start_new_session=True,
        )
    PID_PATH.write_text(str(process.pid), encoding="utf-8")
    for _ in range(30):
        time.sleep(0.25)
        if _pid() and _health():
            print(f"Coordinator stack started (pid {process.pid})")
            return 0
    print(f"Stack did not become healthy; inspect {LOG_PATH}", file=sys.stderr)
    return 1


def stop() -> int:
    pid = _pid()
    if not pid:
        PID_PATH.unlink(missing_ok=True)
        print("Coordinator stack is not running")
        return 0
    try:
        os.killpg(pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    for _ in range(30):
        time.sleep(0.1)
        if not _pid():
            break
    PID_PATH.unlink(missing_ok=True)
    print("Coordinator stack stopped")
    return 0


def run() -> int:
    token = _token()
    coordinator_port = os.getenv("RACKPILOT_COORDINATOR_PORT", "4180")
    api_port = os.getenv("RACKPILOT_API_PORT", "4176")
    frontend_port = os.getenv("RACKPILOT_FRONTEND_PORT", "5176")
    deployment_mode = os.getenv("RACKPILOT_DEPLOYMENT_MODE", "development").lower().strip()
    stop_requested = False

    def request_stop(*_: object) -> None:
        nonlocal stop_requested
        stop_requested = True

    signal.signal(signal.SIGTERM, request_stop)
    signal.signal(signal.SIGINT, request_stop)
    base_env = os.environ.copy()
    base_env.update(
        {
            "RACKPILOT_COORDINATOR_TOKEN": token,
            "RACKPILOT_COORDINATOR_EXECUTION": "true",
            "RACKPILOT_COORDINATOR_SCHEDULER": "true",
            "RACKPILOT_COORDINATOR_MAX_CONCURRENT": base_env.get(
                "RACKPILOT_COORDINATOR_MAX_CONCURRENT", "2"
            ),
            "RACKPILOT_COORDINATOR_MAX_PER_AGENT": base_env.get(
                "RACKPILOT_COORDINATOR_MAX_PER_AGENT", "1"
            ),
            "RACKPILOT_DEPLOYMENT_MODE": deployment_mode,
            "RACKPILOT_AUTO_INTEGRATE": base_env.get("RACKPILOT_AUTO_INTEGRATE", "true"),
            "COORDINATOR_TOKEN": token,
            "COORDINATOR_URL": f"http://127.0.0.1:{coordinator_port}",
            "DB_PATH": base_env.get(
                "DB_PATH", str(CANONICAL_APP_DB if CANONICAL_APP_DB.exists() else DATA / "rackpilot.db")
            ),
            "RACKPILOT_COORDINATOR_DB": base_env.get(
                "RACKPILOT_COORDINATOR_DB",
                str(CANONICAL_COORDINATOR_DB if CANONICAL_COORDINATOR_DB.exists() else DATA / "coordinator.db"),
            ),
            "PORT": coordinator_port,
        }
    )
    specs = {
        "coordinator": ([str(PYTHON), "-m", "coordinator.run"], ROOT, base_env),
        "api": (
            [str(PYTHON), "run.py"],
            ROOT / "backend",
            {**base_env, "PORT": api_port, "STATIC_DEV_PROXY": f"http://127.0.0.1:{frontend_port}"},
        ),
        "frontend": (
            ["npm", "run", "dev", "--", "--host", "0.0.0.0", "--port", frontend_port],
            ROOT / "frontend",
            {**base_env, "VITE_API_PROXY_TARGET": f"http://127.0.0.1:{api_port}"},
        ),
    }
    processes: dict[str, subprocess.Popen[bytes]] = {}
    head_result = subprocess.run(
        ["git", "-C", str(ROOT), "rev-parse", "HEAD"], capture_output=True, text=True, check=False
    )
    applied_head = head_result.stdout.strip()
    pending_head = ""

    def restart_children_for_applied_code() -> None:
        for child in processes.values():
            if child.poll() is None:
                child.terminate()
        for child in processes.values():
            try:
                child.wait(timeout=5)
            except subprocess.TimeoutExpired:
                child.kill()
        processes.clear()

    try:
        while not stop_requested:
            for name, (command, cwd, env) in specs.items():
                process = processes.get(name)
                if process is None or process.poll() is not None:
                    print(f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] starting {name}", flush=True)
                    processes[name] = subprocess.Popen(command, cwd=cwd, env=env)
            if deployment_mode == "development":
                current = subprocess.run(
                    ["git", "-C", str(ROOT), "rev-parse", "HEAD"],
                    capture_output=True, text=True, check=False,
                ).stdout.strip()
                if current and current != applied_head:
                    pending_head = current
                health = _health() or {}
                scheduler_state = health.get("scheduler", {}) if isinstance(health, dict) else {}
                idle = not any(int(scheduler_state.get(key, 0) or 0) for key in ("running", "integrating"))
                if pending_head and idle:
                    print(
                        f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] applying integrated code {pending_head[:12]}",
                        flush=True,
                    )
                    restart_children_for_applied_code()
                    applied_head = pending_head
                    pending_head = ""
            time.sleep(1)
    finally:
        for process in processes.values():
            if process.poll() is None:
                process.terminate()
        for process in processes.values():
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
        PID_PATH.unlink(missing_ok=True)
    return 0


def main() -> int:
    command = sys.argv[1] if len(sys.argv) > 1 else "status"
    if command == "start":
        return start()
    if command == "stop":
        return stop()
    if command == "status":
        return status()
    if command == "restart":
        stop()
        return start()
    if command == "run":
        return run()
    print("Usage: coordinator_stack.py start|stop|restart|status", file=sys.stderr)
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
