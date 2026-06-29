# RackPilot Agent Coordinator

## Purpose

Agent Coordinator is a local-only control plane for reviewable collaboration between Codex and Claude Code. It is an internal development tool, not a customer-facing RackPilot service.

The coordinator does not let agents freely share one working directory. It assigns bounded jobs to registered Git worktrees, captures append-only events and returns successful implementation jobs to review instead of merging them automatically.

## Safety defaults

- Binds to `127.0.0.1:4180` by default.
- Mutations require `X-Coordinator-Token`.
- Agent execution is disabled unless `RACKPILOT_COORDINATOR_EXECUTION=true`.
- Jobs cannot target `main` or `master`.
- Worktree paths must be registered by Git for the configured repository.
- Agent commands use argv arrays and `shell=False`.
- Codex runs with `workspace-write`; Claude runs with `dontAsk`, so missing permissions fail instead of silently expanding access.
- Successful jobs requiring review stop in `review` status.
- Rate-limit output becomes the explicit `rate_limited` state.

## Local development

Use Python 3.11–3.13 and a dedicated virtual environment. The currently pinned
Pydantic release does not build on Python 3.14. The RackPilot container uses
Python 3.12. Never place the coordinator database or token in Git.

```bash
python3 -m venv .venv-coordinator
. .venv-coordinator/bin/activate
pip install -r coordinator/requirements.txt

export RACKPILOT_COORDINATOR_TOKEN="$(python3 -c 'import secrets; print(secrets.token_urlsafe(32))')"
python -m coordinator.run
```

Health and read-only discovery:

```bash
curl http://127.0.0.1:4180/health
curl http://127.0.0.1:4180/api/v1/agents
curl http://127.0.0.1:4180/api/v1/worktrees
```

Execution remains disabled in this configuration. Enabling it is a separate operator decision after the Admin control surface and approval policy are connected.

## Job lifecycle

```text
queued -> running -> review -> waiting_approval -> completed
                  -> completed
                  -> failed | cancelled | rate_limited
```

The first UI increment will expose agents, worktrees, queue, events, execution state and Stop controls in an Administrator-only RackPilot tab.
