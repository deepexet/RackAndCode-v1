"""Run the local-only RackPilot Agent Coordinator."""

from __future__ import annotations

import os

import uvicorn


if __name__ == "__main__":
    uvicorn.run(
        "coordinator.app:app",
        host=os.getenv("RACKPILOT_COORDINATOR_HOST", "127.0.0.1"),
        port=int(os.getenv("RACKPILOT_COORDINATOR_PORT", "4180")),
        reload=False,
    )
