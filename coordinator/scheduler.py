"""Persistent queue scheduler with per-agent and per-worktree isolation."""

from __future__ import annotations

import threading
from collections.abc import Callable
from typing import Any

from .core import AGENTS, CoordinatorStore


class CoordinatorScheduler:
    def __init__(
        self,
        store: CoordinatorStore,
        launch: Callable[[str], None],
        *,
        enabled: bool,
        max_concurrent: int = 2,
        max_per_agent: int = 1,
        poll_seconds: float = 0.5,
    ):
        self.store = store
        self.launch = launch
        self.enabled = enabled
        self.max_concurrent = max(1, min(max_concurrent, 8))
        self.max_per_agent = max(1, min(max_per_agent, self.max_concurrent))
        self.poll_seconds = max(0.1, poll_seconds)
        self._lock = threading.RLock()
        self._stop = threading.Event()
        self._wake = threading.Event()
        self._thread: threading.Thread | None = None

    def start(self) -> None:
        if not self.enabled or (self._thread is not None and self._thread.is_alive()):
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._loop, daemon=True, name="coordinator-scheduler")
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        self._wake.set()
        if self._thread and self._thread.is_alive():
            self._thread.join(timeout=3)

    def wake(self) -> None:
        self._wake.set()

    def snapshot(self) -> dict[str, Any]:
        running = self.store.list_jobs("running", limit=500)
        integrating = self.store.list_jobs("integrating", limit=500)
        protected = running + integrating + self.store.list_jobs("review", limit=500) + self.store.list_jobs("waiting_approval", limit=500)
        queued = self.store.list_jobs("queued", limit=500)
        by_agent = {agent: 0 for agent in sorted(AGENTS)}
        for job in running:
            by_agent[job["assignedAgent"]] = by_agent.get(job["assignedAgent"], 0) + 1
        return {
            "enabled": self.enabled,
            "running": len(running),
            "integrating": len(integrating),
            "queued": len(queued),
            "maxConcurrent": self.max_concurrent,
            "maxPerAgent": self.max_per_agent,
            "runningByAgent": by_agent,
            "lockedWorktrees": sorted({job["worktreePath"] for job in protected}),
        }

    def claim(self, job_id: str, *, actor: str = "scheduler") -> dict[str, Any]:
        with self._lock:
            job = self.store.get_job(job_id)
            if job["status"] != "queued":
                raise ValueError("Only queued jobs can start")
            running = self.store.list_jobs("running", limit=500)
            integrating = self.store.list_jobs("integrating", limit=500)
            protected = running + integrating + self.store.list_jobs("review", limit=500) + self.store.list_jobs("waiting_approval", limit=500)
            if len(running) + len(integrating) >= self.max_concurrent:
                raise ValueError("Coordinator concurrency limit reached")
            if any(item["worktreePath"] == job["worktreePath"] for item in protected):
                raise ValueError("Worktree is already locked by another running job")
            for item in protected:
                if item["id"] == job["id"]:
                    continue
                overlaps = self._scope_overlaps(job.get("scopePaths", []), item.get("scopePaths", []))
                if overlaps:
                    raise ValueError(f"Task scope overlaps running job {item['id']}: {', '.join(overlaps[:5])}")
            agent_running = sum(item["assignedAgent"] == job["assignedAgent"] for item in running)
            if agent_running >= self.max_per_agent:
                raise ValueError(f"{job['assignedAgent']} concurrency limit reached")
            claimed = self.store.transition_job(job_id, "running", actor=actor)
            self.launch(job_id)
            return claimed

    @staticmethod
    def _scope_overlaps(left: list[str], right: list[str]) -> list[str]:
        overlaps: set[str] = set()
        for a in left:
            a = a.strip("/")
            for b in right:
                b = b.strip("/")
                if a and b and (a == b or a.startswith(f"{b}/") or b.startswith(f"{a}/")):
                    overlaps.add(a if len(a) >= len(b) else b)
        return sorted(overlaps)

    def tick(self) -> list[str]:
        if not self.enabled:
            return []
        started: list[str] = []
        # list_jobs is newest-first; scheduler must preserve FIFO order.
        for job in reversed(self.store.list_jobs("queued", limit=500)):
            try:
                self.claim(job["id"])
            except ValueError:
                continue
            started.append(job["id"])
        return started

    def _loop(self) -> None:
        while not self._stop.is_set():
            self.tick()
            self._wake.wait(self.poll_seconds)
            self._wake.clear()
