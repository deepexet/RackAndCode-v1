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
- Codex runs with `workspace-write`; Claude runs with `acceptEdits` inside its registered Git worktree. Neither agent receives unrestricted permission bypass.
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

Execution remains disabled in this basic configuration. The isolated preview stack may enable it with
`RACKPILOT_COORDINATOR_EXECUTION=true` after both services receive the same server-side control token.

## Job lifecycle

```text
queued -> running -> review -> waiting_approval -> completed
                  -> completed
                  -> failed | cancelled | rate_limited
```

The Administrator-only FastAPI proxy exposes agents, worktrees, queue and execution state. Status-aware Start, Retry, Cancel, Approve and Reject controls are available when execution and the server-side token are configured. Retry is limited to failed, cancelled and rate-limited jobs and starts a fresh run in the same validated worktree. The coordinator token never reaches browser code, and every successful action is written to the workspace audit log.

## Live activity

Coordinator stores bounded, line-oriented agent output while a process is running. Admin → Agents → Live polls incrementally and presents elapsed time, status transitions, commands, file changes, agent messages, errors and the retained console stream. Each job keeps its latest 2,000 log records; older runs created before this capability retain only their final result summary.

Every start or retry increments the job attempt number. Live activity defaults to the current attempt so output from an earlier failed run cannot be confused with the active run; retained records remain queryable by attempt. Claude `allowed_warning` usage events are informational and do not become `rate_limited`. Only an actual rejected limit or an error result with a rate-limit reason changes the job to that state.

Claude session identifiers are retained per job. If a job reaches its turn budget, Continue resumes that same Claude session with the existing context and increases the budget by four turns, capped at 20. This avoids paying the time and context cost of repeating a completed audit. A resumed job remains in the same registered worktree and still stops for Codex review.
