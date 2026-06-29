# RackPilot Agent Coordinator

## Purpose

Agent Coordinator is a local-only control plane for reviewable collaboration between Codex and Claude Code. It is an internal development tool, not a customer-facing RackPilot service.

The coordinator does not let agents freely share one working directory. It assigns bounded jobs to registered Git worktrees, captures append-only events and returns successful implementation jobs to review instead of merging them automatically.

## v1.0 readiness contract

The coordinator is ready for continuous local parallel development when:

- every automatically created job receives a unique branch and managed worktree;
- the persistent scheduler runs at most two jobs, at most one per agent;
- one worktree can never be owned by two running jobs;
- declared file/module scopes block potentially conflicting parallel jobs;
- a restart converts orphaned `running` records into an explicit recoverable failure;
- Codex and Claude output, attempts, limits, sessions, review feedback and Git changes remain observable;
- no branch is merged automatically; Codex/human review remains the integration gate.

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

Administrators can create a bounded job from Admin → Agents by selecting an installed agent, defining instructions, repository scope and a 1–20 turn budget, and choosing whether review is required. The scheduler starts it when compatible capacity is available.

By default New job creates a unique managed worktree from the selected base revision. The optional repository-relative scope list is also a scheduler lock: paths such as `backend/app/routes` and `backend/app/routes/projects.py` overlap and cannot run concurrently. Managed worktrees can be removed only after the job is terminal and the worktree is clean; their Git branches are preserved.

## Persistent local stack

The supervisor keeps Coordinator, FastAPI and Vite alive outside an interactive Codex turn and restarts an individual component if it exits:

```bash
.venv-coordinator312/bin/python scripts/coordinator_stack.py start
.venv-coordinator312/bin/python scripts/coordinator_stack.py status
.venv-coordinator312/bin/python scripts/coordinator_stack.py restart
.venv-coordinator312/bin/python scripts/coordinator_stack.py stop
```

Runtime PID, token and log files stay under ignored `data/` paths. The token is created with owner-only permissions and is shared only by the local Coordinator and FastAPI processes.

Scheduler defaults are two parallel jobs and one job per agent. They can be overridden with `RACKPILOT_COORDINATOR_MAX_CONCURRENT` and `RACKPILOT_COORDINATOR_MAX_PER_AGENT`.

## Live activity

Coordinator stores bounded, line-oriented agent output while a process is running. Admin → Agents → Live polls incrementally and presents elapsed time, status transitions, commands, file changes, agent messages, errors and the retained console stream. Each job keeps its latest 2,000 log records; older runs created before this capability retain only their final result summary.

Every start or retry increments the job attempt number. Live activity defaults to the current attempt so output from an earlier failed run cannot be confused with the active run; retained records remain queryable by attempt. Claude `allowed_warning` usage events are informational and do not become `rate_limited`. Only an actual rejected limit or an error result with a rate-limit reason changes the job to that state.

Claude session identifiers are retained per job. If a job reaches its turn budget, Continue resumes that same Claude session with the existing context and increases the budget by four turns, capped at 20. This avoids paying the time and context cost of repeating a completed audit. A resumed job remains in the same registered worktree and still stops for Codex review.

The Live review view independently inspects the registered Git worktree and shows bounded file status plus staged and unstaged diff statistics. It never returns file contents. Agent narration is therefore not the only evidence available before Approve.

Request changes records Codex review feedback, resumes the same agent session in the same worktree, and returns the job to Review after correction. Reject remains available for work that should not continue.

## Acceptance evidence

On 2026-06-29 the live scheduler created separate managed branches/worktrees and claimed Codex and Claude jobs within the same scheduling interval. Claude wrote only in its assigned worktree. Codex reached the external ChatGPT usage limit after isolation and process launch; this is reported as `rate_limited` by v1.0 and does not indicate a coordinator failure. Both temporary worktrees were removed safely after inspection.
