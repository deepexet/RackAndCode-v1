# Development log

Append-only summary of material product development. Git commits are the detailed change record; this log explains intent, scope and verification at release level.

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
