# Development log

Append-only summary of material product development. Git commits are the detailed change record; this log explains intent, scope and verification at release level.

## 2026-06-28 — Agent Coordinator v0.1 foundation

- Added an isolated local FastAPI control plane for Codex and Claude Code collaboration.
- Added a separate SQLite job queue and append-only coordinator event history.
- Added registered-worktree and non-integration-branch validation.
- Added safe CLI discovery and shell-free command builders for both installed agents.
- Added explicit review, approval, cancellation, failure and rate-limit lifecycle states.
- Kept mutations token-protected and autonomous execution disabled by default.
- Added an authenticated Administrator-only FastAPI proxy and a read-only Agents tab for status, CLI versions, worktrees and recent jobs; control tokens never reach browser code.
- Documented AI ownership, handoff rules and ADR-004.
- Verification: five coordinator unit tests and proxy authorization checks passed; the Vite production build passed; live service detected Codex 0.142.3 and Claude Code 2.1.140 with execution disabled.

## 2026-06-23 — v0.33.0

- Added project-specific WorkType scope selection when creating customer projects.
- Added migration `025_project_work_type_scopes.sql` and backfilled existing projects with all active WorkTypes.
- Filtered project progress, technician forms and work item type choices to the selected project scope.
- Added server-side validation so Work Items, Daily Updates and Unit Progress cannot use WorkTypes outside the project scope.
- Verification: `npm run check`; 82 automated tests and quality gate passed.

## 2026-06-23 — v0.32.0

- Added backend role policy helpers and route-level permission checks for admin APIs, logs, workspace sync, project management and technician daily progress.
- Added `X-RackPilot-Role` as a local development role header, propagated from the browser role switcher through shared `apiHeaders()`.
- Added HTTP integration tests that verify Technician/Supervisor/Administrator access boundaries against a real temporary server.
- Removed blocking reverse DNS lookup during LAN server bind so `0.0.0.0:4173` starts immediately on local networks.
- Kept this as an MVP authorization foundation: production enforcement still requires identity, memberships and signed sessions.
- Verification: `npm run check`; 80 automated tests and quality gate passed.

## 2026-06-23 — v0.31.0

- Added the first centralized role-aware UI policy matrix for Technician, Supervisor, Project Manager and Administrator.
- Added a development role preview switcher in the header so access assumptions can be tested during MVP build-out.
- Applied route visibility to Logs, API and Admin tabs and action visibility to Development Workspace and Project Management controls.
- Kept this explicitly as a UI foundation only: server-side RBAC remains mandatory before role enforcement is considered secure.
- Moved `FS-073` to Testing for the UI-policy increment.
- Verification: `npm run check`; 76 automated tests and quality gate passed.

## 2026-06-23 — v0.30.0

- Completed the first controlled cleanup pass for legacy FieldOS public mentions.
- Changed browser storage/export names to `rackpilot.*` and `rackpilot-workspace-*` while preserving legacy localStorage fallback migration.
- Changed public health service contract to `rackpilot-local`.
- Added migration `024_rackpilot_public_cleanup.sql` to update seeded organization/user public names.
- Updated script descriptions, SBOM metadata and macOS agent defaults to RackPilot naming while retaining legacy env var fallbacks.
- Changed new backup filenames to `rackpilot-*.db`; retention still recognizes old `fieldos-*.db` backups.
- Verification: `npm run check`; 75 automated tests and quality gate passed.

## 2026-06-23 — v0.29.0

- Fixed desktop header layout so the Codex development status block cannot overlap the centered navigation tabs on wide screens.
- Added a `Graph` view beside the Development Kanban. It renders tasks as status-colored graph nodes and relationships from `dependsOn`, `parentId` and `unblocks`.
- Reused the existing search, priority, area and status filters for both Kanban and Graph views.
- Added planning tasks `FS-085` and `FS-086` in Testing.
- Verification: `npm run check`; 74 automated tests and quality gate passed.

## 2026-06-22 — v0.28.0

- Added separate `API` route for admin API monitoring.
- Added `GET /api/v1/admin/api-metrics` with runtime request count, average latency, p95 latency, error count, status codes, top routes and recent API request logs.
- Added in-memory API metrics recorder; no database migration because this is current-process telemetry, not long-term audit storage.
- Added planning tasks `FS-083` for controlled cleanup of legacy FieldOS mentions and `FS-084` for the API Monitoring Console.
- Access model: API Monitoring is marked Administrator-only and depends on `FS-073` for server-side RBAC enforcement.
- Verification: `npm run check`; 73 automated tests and quality gate passed.

## 2026-06-22 — v0.26.0

- Updated public product identity to `RackPilot by Valeronix`.
- Updated tagline to `Manage Projects, Inventory and Field Operations in One Place.`
- Added migration `022_rackpilot_brand.sql` to update the visible internal platform project.
- Updated default Git remote examples to `git@github.com:deepexet/RackAndCode-v1.git`.
- Verification: `npm run check`; 65 automated tests and quality gate passed.

## 2026-06-22 — FS-070 progress formula correction

- Fixed customer project progress so daily field updates and unit completions contribute to overall project progress.
- Kept `taskSummary` as a task count only, avoiding a mixed count of tasks, unit marks and daily reports.
- Added deterministic tests for daily field updates and unit completion progress.
- Live verification on the current customer project changed overall progress from an incorrect `0%` to evidence-based `62%`.
- Verification: `npm run check`; 67 automated tests and quality gate passed.

## 2026-06-22 — v0.27.0

- Added dedicated `Logs` route with source, project, entity and text filters.
- Added `GET /api/v1/logs` as a unified read model over project audit and workspace audit events.
- Added Admin Platform Settings for default language, timezone, role mode, telemetry privacy and log retention.
- Added migration `023_platform_settings.sql`.
- Moved `FS-068` and `FS-082` to Testing.
- Verification: `npm run check`; 71 automated tests and quality gate passed.

## 2026-06-22 — v0.25.0

- Added Admin GitHub sync settings for repository URL, branch, commit strategy, auto commit, auto push and docs inclusion.
- Added schema migration `021_git_sync_settings.sql`.
- Added API `GET/POST /api/v1/admin/git-sync`.
- Kept credentials outside RackPilot; SSH keys or local Git credential manager remain the supported access path.
- Verification: `npm run check`; 64 automated tests and quality gate passed.

## 2026-06-22 — v0.24.0

- Increased desktop typography density for project cards, Kanban cards, overview panels, admin cards, dialogs and development-agent status.
- Preserved mobile touch and iOS zoom contracts while adding a desktop readability contract.
- Linked the change to user-reported issues `FS-076` and `FS-077`.
- Added `FS-075`–`FS-077` to the durable planning file so they survive workspace reloads.
- Verification: `npm run check`; 62 automated tests and quality gate passed.

## 2026-06-22 — v0.23.0

- Selected RackPilot by Valeronix as the public working identity and documented brand philosophy.
- Added an engineering handoff independent of any single AI model or conversation.
- Implemented automatic project Daily Log from project audit events.
- Kept manual daily entries as editable explanations alongside immutable automatic events.
- Added migration `020_valeronix_brand.sql` for the visible internal project name.
- Added Kanban task `FS-078` at Critical priority and moved it to Testing.
- Hardened Git exclusions for databases, runtime tokens, keys and macOS metadata.
- Created the initial repository commit `3e774ca`; private GitHub remote is pending repository access details.
- Verification: `npm run check`; 62 automated tests and quality gate passed.

## Earlier foundation work — v0.1.0 through v0.22.0

- Established local/LAN web workspace, development Kanban and roadmap.
- Added SQLite persistence, versioned migrations, tenant context and optimistic updates.
- Added customer projects, buildings, locations, units and configurable work workflows.
- Added mobile-first unit progress, offline outbox, issues and Jobber-ready reporting.
- Added append-only audit chain, backup verification, macOS telemetry and development-agent presence.
- Detailed behavior and invariants are maintained in [`ARCHITECTURE.md`](ARCHITECTURE.md), [`TRD.md`](TRD.md) and accepted ADRs.

## Logging rule

For each material release, append a dated section containing product version, user-visible changes, migrations, security/reliability implications, linked tasks and executed verification. Existing entries are corrected only by a new explicit correction entry.

## 2026-06-28 — Agent Coordinator preview and FastAPI startup repair

- Added a configurable Vite API proxy target so isolated feature worktrees can be previewed without replacing the live development server.
- Added a LAN-only FastAPI development login for preview parity with the legacy server.
- Repaired FastAPI startup by using the current migration runner API and passing `Path` objects to the shared workspace store.
- Repaired FastAPI session resolution to consume explicit authorization/cookie dependencies and the existing camel-case session contract.
- Declared the missing `psutil` runtime dependency used by FastAPI system telemetry.
- Removed the remaining FieldOS database name from the environment template.
- Verified the authenticated Admin → Agents path against the local Coordinator while autonomous execution and write controls remained disabled.
- Verification: 6 focused FastAPI/Coordinator tests, Python compile check, production frontend build and browser smoke test passed.

## 2026-06-29 — Administrator controls for agent jobs

- Added status-aware Start, Cancel, Approve and Reject controls to Admin → Agents.
- Kept the Coordinator control token exclusively between the FastAPI backend and local Coordinator; browser clients never receive it.
- Restricted every action to an authenticated Administrator and added workspace audit events for successful job actions.
- Improved FastAPI error details displayed by the frontend.
- Enabled local execution for the isolated preview stack without automatically starting queued jobs.
- Verification: 7 focused FastAPI/Coordinator tests, Python compile check, production frontend build and authenticated live API smoke test passed.

## 2026-06-29 — Claude CLI retry repair

- Diagnosed the first Claude job failure from captured stderr: current Claude Code requires `--verbose` with print-mode `stream-json` output.
- Updated the shell-free Claude command contract and added an exact regression assertion.
- Added an audited Retry action for failed, cancelled and rate-limited jobs; Retry resets the prior run state and immediately starts a new isolated run.
- Verification: 8 focused Coordinator/FastAPI tests, Python compile check and production frontend build passed.

## 2026-06-29 — Live agent activity

- Replaced end-only process buffering with incremental, bounded agent output capture.
- Added an Administrator-only job detail endpoint for incremental logs and status events.
- Added a responsive Live activity modal with elapsed time, status timeline, interpreted commands, file changes, agent messages, errors and retained console output.
- Preserved final-result fallback for jobs completed before live capture was introduced.
- Verification: 11 focused Coordinator/FastAPI tests, including a real streamed subprocess test, Python compile check and production frontend build passed.

## 2026-06-29 — FastAPI Logs and Overview read slice

- Migrated unified logs, audit integrity, administrator audit log, Overview KPI and critical-task read endpoints to FastAPI while preserving legacy handlers.
- Reused the shared role policy but added fail-closed FastAPI guards for unauthenticated requests and unknown role names.
- Added tenant-isolation, filter, limit, audit-chain, dashboard and permission integration tests.
- Verification: 16 focused FastAPI/Coordinator tests, 4 legacy compatibility tests and production frontend build passed.

## 2026-06-29 — Coordinator retry attempts and Claude limit classification

- Verified a real Claude Code job through the user's Claude Pro login without an Anthropic API key or API-credit balance.
- Added durable attempt numbers to jobs and logs; Live activity now reads only the current attempt while preserving prior output in SQLite.
- Expanded human-readable Claude event rendering for sessions, tools, subtasks, progress, usage warnings and turn-limit failures.
- Corrected rate-limit detection so Claude's permitted `allowed_warning` event does not incorrectly mark a job as `rate_limited`.
- Replaced Claude's read-only-in-practice `dontAsk` mode with worktree-bounded `acceptEdits`, allowing implementation tasks to create and edit files without enabling unrestricted permission bypass.
- Added resumable Claude sessions and adaptive turn budgets: Continue reuses the last session after a max-turn failure and raises the budget by four, capped at 20.
- Added an Administrator job composer for selecting an available agent, registered worktree, instructions, turn budget, review requirement and immediate start behavior.
- Added server-side Git worktree inspection and a Live review summary with changed paths and staged/unstaged diff statistics; source contents remain excluded from the response.
- Added a review-feedback loop: Request changes persists Codex feedback, resumes the same Claude context and returns corrected work for another review cycle.
- Verification: 10 Coordinator tests, Python compile check and Vite production build passed.

## 2026-06-29 — Agent Coordinator v1.0 parallel development readiness

- Added automatic unique Git branches and managed worktrees for new agent jobs.
- Added a persistent FIFO scheduler with two total slots, one slot per agent, worktree locks and declared path-scope conflict locks.
- Added restart recovery for orphaned running jobs and process-group cancellation.
- Added safe managed-worktree removal that refuses active, unreviewed or dirty worktrees and preserves branches.
- Added a local supervisor for Coordinator, FastAPI and Vite with shared private token, health/status commands and component restart behavior.
- Updated Admin → Agents with scheduler capacity, queued count, automatic worktree creation, base revision, task scope and cleanup actions.
- Classified Codex ChatGPT usage-limit output as `rate_limited` rather than an implementation failure.
- Live acceptance created and launched Codex and Claude jobs concurrently in separate managed worktrees; temporary worktrees were inspected and removed without cross-write conflicts.
- Verification: 19 focused Coordinator/FastAPI tests, Python compile checks, Vite production build, supervisor restart/health check and live two-agent scheduler smoke test.

## 2026-06-29 — Local text-only AI worker

- Added `local` as a third Coordinator agent backed by an on-device Ollama model, defaulting to `qwen3:1.7b` on Apple Silicon.
- Restricted the worker to text-only classification, summarization, action extraction and short drafts; it has no repository, command or file-editing tools.
- Added runtime/model health detection, scheduler accounting, bounded inference settings and structured live logs with token/timing metadata.
- Added Admin → Agents local readiness status, a Local quick task action and reusable simple-task templates.
- Installed Ollama as a login service and downloaded the compact local model on the development Mac; no paid API is used.
- Verification: 16 focused Coordinator tests, Python compile check, frontend production build, two live local inference jobs, no-worktree isolation check and authenticated browser UI verification passed. The broader 171-test suite still has 5 unrelated baseline failures around migration version 094, legacy progress rules and a pre-existing CSS contract.

## 2026-06-29 — AI development team contract

- Assigned Claude the Architecture Lead role for ADRs, module boundaries, data contracts and architectural risk analysis.
- Assigned Codex the Engineering & Integration Lead role for repository validation, security, implementation planning, code review and controlled integration.
- Preserved the Product Owner's authority over priorities, product tradeoffs and final acceptance.
- Added the role contract and mandatory architecture-to-review delivery loop to Coordinator documentation and Admin → Agents.

## 2026-06-30 — Claude batch integration review

- Integrated the completed diagram editor, Overview critical-task, Work Order detail, notification and inventory-normalization commits into an isolated Codex integration branch.
- Reconciled the collaboration protocol with Claude as Architecture Lead and Codex as Engineering & Integration Lead.
- Removed an accidental Transport route reference from the notification commit; the partial Transport module and migration `096` remain deferred outside the integration branch.
- Kept the unfinished Work Order materials UI outside integration while preserving the independent Kanban initial-scroll fix.
- Removed duplicate unauthenticated FastAPI notification shims and enforced authenticated role permissions on notifications, inventory alerts and Work Orders.
- Added Work Order child tenant checks, organization-scoped queries and indexes, validated task/comment input and server-derived comment authors.
- Added focused FastAPI and store tests for notification authentication, Work Order RBAC and cross-tenant child isolation.

## 2026-06-30 — Transport, Work Order materials and real Kanban integration

- Integrated Claude's partial Transport module into the FastAPI/frontend stack and restored its router, breadcrumb and command-palette entry.
- Added role enforcement, tenant ownership validation, input validation and not-found behavior for vehicles, assignments, service records and vehicle inventory.
- Completed the unfinished Work Order materials scaffold with persistent SKU/quantity records, add/remove FastAPI endpoints, audit events, tenant-safe joins and responsive UI behavior.
- Preserved immutable migration `095`; moved tenant-leading indexes to migration `098` and introduced Work Order materials through migration `097`.
- Backed up and migrated the real workspace database, then added 14 linked Project Wiki tasks to the existing RackPilot Kanban with security-first priorities and explicit dependencies.
- Moved the existing Transport and Work Order migration tasks to Testing after implementation; final end-to-end product acceptance remains required.
- Verification: 34 legacy Transport/notification tests, 5 focused FastAPI integration tests and the Vite production build passed. The full 209-test suite retains the same five known baseline failures (stale schema-version assertions, legacy CSS contract, internal-project rule and project-progress expectation).

## 2026-06-30 — Development Kanban agent dispatch

- Linked Coordinator jobs to their source organization, project and Work Item while keeping the Kanban as the task source of truth.
- Added deterministic role-based agent recommendations, repository scope inference, isolated job creation and duplicate/blocked-task protection.
- Added Administrator controls in Work Item details for delegation, live state, cancel/retry and approval; approval advances the task to Testing.
- Added project-level Start AI team dispatch for the highest-priority unblocked Ready tasks, bounded by scheduler capacity and per-agent concurrency.
- Corrected FastAPI Work Item create/update contracts and added the missing PATCH route used by the new frontend.
- Made supervised Coordinator/API/frontend ports configurable so the integrated stack can run against the canonical database.
- Verification: 21 focused Coordinator/FastAPI tests, Python and JavaScript syntax checks, and Vite production build passed.

## 2026-06-30 — Agent integration gate

- Replaced status-only approval with an asynchronous Integrating lifecycle and controlled agent-commit cherry-pick.
- Added fail-closed repository-scope validation, immutable historical migration protection, Python/JavaScript syntax checks and clean migration replay.
- Persisted base, result and integrated commit identifiers plus quality summaries and integration errors for every job.
- Extended scope locks through Review and Integrating so overlapping jobs cannot run before reviewed work is integrated.
- Added Review preserved changes to recover useful output after an agent turn-limit or CLI failure.
- Verification includes isolated temporary-repository tests proving successful commit/cherry-pick and rejection of out-of-scope changes.
