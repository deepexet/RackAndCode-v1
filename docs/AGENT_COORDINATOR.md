# RackPilot Agent Coordinator

## Purpose

Agent Coordinator is a local-only control plane for reviewable collaboration between Codex, Claude Code and a constrained on-device helper. It is an internal development tool, not a customer-facing RackPilot service.

The coordinator does not let agents freely share one working directory. It assigns bounded jobs to registered Git worktrees, captures append-only events and returns successful implementation jobs to review instead of merging them automatically.

## Team roles and decision contract

- **Product Owner — Valeri:** owns product direction, priorities, commercial decisions and final acceptance of material scope changes.
- **Architecture Lead — Claude:** proposes system architecture, module boundaries, data contracts, ADRs, dependency plans and architectural risk assessments.
- **Engineering & Integration Lead — Codex:** validates architecture against the repository, security and operational constraints; plans implementation; reviews code and tests; resolves integration conflicts and controls what enters the integration branch.
- **Local AI Helper:** performs bounded text-only triage, summaries, classification and extraction without repository or command access.

Architecture becomes actionable only after Claude records the proposal in an ADR and Codex records its technical review. Product-impacting tradeoffs remain subject to Product Owner approval. Neither agent merges to the integration branch automatically.

The normal delivery loop is:

```text
Product priority -> Claude architecture/ADR -> Codex technical review and task split
                 -> isolated Claude/Codex implementation jobs -> Codex integration review
                 -> tests and preview -> Product Owner acceptance
```

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
- The `local` agent has no file or command tools. It can only return text and is capped to a small context and response budget.

## Local AI helper

The optional `local` agent uses Ollama on `127.0.0.1:11434` and defaults to
`qwen3:1.7b`. It is intended for inexpensive, private tasks such as summarizing
field notes and logs, classifying work, extracting action items and drafting
short checklists. It is not a coding-agent replacement and cannot inspect the
repository, modify files or execute commands.

On Apple Silicon, install and start Ollama, then fetch the model:

```bash
brew install ollama
brew services start ollama
ollama pull qwen3:1.7b
```

Override the defaults with `RACKPILOT_LOCAL_MODEL` and
`RACKPILOT_LOCAL_AI_URL`. A model is reported as available only when the local
Ollama API is reachable and the configured model is already installed. Admin →
Agents → Local quick task provides templates for the supported workload. Local
text jobs use a fixed read-only Coordinator workspace and do not create Git
branches or worktrees. Prompts and responses remain on the Mac; no paid model
API is used.

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

Approve is an integration gate, not a status-only action. It validates every changed path against the declared scope, rejects edits to existing numbered migrations, runs bounded syntax/migration checks, creates an attributed agent commit, requires a clean integration worktree, and performs a controlled cherry-pick. Conflicts or failed checks leave the agent worktree intact and move the job to Failed with a concise integration error. A failed agent that preserved useful files can use Review preserved changes instead of repeating completed work.

Administrators can create a bounded job from Admin → Agents by selecting an installed agent, defining instructions, repository scope and a 1–20 turn budget, and choosing whether review is required. The scheduler starts it when compatible capacity is available.

By default New job creates a unique managed worktree from the selected base revision. The optional repository-relative scope list is also a scheduler lock: paths such as `backend/app/routes` and `backend/app/routes/projects.py` overlap and cannot run concurrently. Scope locks remain active through Review and Integrating, preventing another agent from starting overlapping work before the result is accepted. Managed worktrees can be removed only after the job is terminal and the worktree is clean; their Git branches are preserved.

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

The supervised ports can be selected with `RACKPILOT_COORDINATOR_PORT`, `RACKPILOT_API_PORT` and `RACKPILOT_FRONTEND_PORT`. Set `DB_PATH` to the canonical RackPilot database when the supervisor runs from an integration worktree.

## Development Kanban integration

Administrator task cards expose the live agent recommendation, available agents, repository scope, current job status and review controls. `Delegate and start` creates an isolated managed worktree linked to that Work Item and moves the task to In Progress. Approval moves it to Testing; completion remains subject to owner acceptance.

`Start AI team` dispatches up to the currently free scheduler capacity from the highest-priority unblocked Ready tasks. Agent selection follows the team contract: Claude for architecture and data contracts, Codex for implementation/integration, and Local AI for bounded text analysis. The scheduler still enforces per-agent, worktree and path-scope locks.

## Autonomous Shift

An Administrator can start a bounded autonomous development shift from **Admin → Agent Coordinator**. The platform selects dependency-ready Kanban items in priority order, creates isolated worktrees, and queues up to the configured daily task budget.

- Reviews pass through the normal scope, syntax, migration, and Git integration gate.
- Overlapping repository scopes remain serialized.
- A subscription limit moves a job to `rate_limited`; the shift waits for the configured cooldown and resumes it automatically.
- Integration conflicts and quality failures stop only the affected job and remain visible in the report.
- The shift stops at its configured end time or when an Administrator presses Stop. Running jobs finish safely.
- The report records completed commits, checks, limit waits, and jobs requiring attention.

The host Mac must remain powered on, online, and signed in to the agent CLIs. On macOS the coordinator runs `caffeinate` for the lifetime of an active shift and releases it when the shift stops. Autonomous Shift does not bypass provider limits, shutdown, logout, or loss of network connectivity.

### Utilization and failover

While a shift is active, FastAPI runs a maintenance cycle every 30 seconds. It synchronizes completed work, fills free agent slots from dependency-ready Kanban items, and gives the local model a bounded hourly triage pass when no text task is ready. If Codex is blocked by a subscription limit and Claude is free, Claude continues the same registered worktree and scope; the old Codex run is cancelled only after the Claude handoff job is created successfully. The coordinator does not invent product changes merely to keep an agent busy, and overlapping scopes remain locked.

### Coordinator Chat

Administrators have a global Coordinator Chat launcher on every platform page. It acts as the owner's single development interface rather than requiring separate conversations with Codex and Claude. Normal questions are answered by the on-device model with bounded live context containing agent availability, queue state, current shift and recent job outcomes. Conversation history is stored in the canonical database and scoped by organization plus user ID, so the same account sees one history across devices without exposing it to another tenant or account. Explicit mutations require slash commands: `/start 10`, `/stop`, `/retry JOB_ID`, and `/priority WORK_ITEM_ID high`. The browser never receives the coordinator control token, and every chat/action is audited.

## Live activity

Coordinator stores bounded, line-oriented agent output while a process is running. Admin → Agents → Live polls incrementally and presents elapsed time, status transitions, commands, file changes, agent messages, errors and the retained console stream. Each job keeps its latest 2,000 log records; older runs created before this capability retain only their final result summary.

Every start or retry increments the job attempt number. Live activity defaults to the current attempt so output from an earlier failed run cannot be confused with the active run; retained records remain queryable by attempt. Claude `allowed_warning` usage events are informational and do not become `rate_limited`. Only an actual rejected limit or an error result with a rate-limit reason changes the job to that state.

Claude session identifiers are retained per job. If a job reaches its turn budget, Continue resumes that same Claude session with the existing context and increases the budget by four turns, capped at 20. This avoids paying the time and context cost of repeating a completed audit. A resumed job remains in the same registered worktree and still stops for Codex review.

The Live review view independently inspects the registered Git worktree and shows bounded file status plus staged and unstaged diff statistics. It never returns file contents. Agent narration is therefore not the only evidence available before Approve.

Request changes records Codex review feedback, resumes the same agent session in the same worktree, and returns the job to Review after correction. Reject remains available for work that should not continue.

## Acceptance evidence

On 2026-06-29 the live scheduler created separate managed branches/worktrees and claimed Codex and Claude jobs within the same scheduling interval. Claude wrote only in its assigned worktree. Codex reached the external ChatGPT usage limit after isolation and process launch; this is reported as `rate_limited` by v1.0 and does not indicate a coordinator failure. Both temporary worktrees were removed safely after inspection.
