# Engineering handoff

This document makes RackPilot maintainable by Codex, Claude, another coding agent or a human engineer. Codex is the primary developer, but no critical knowledge may exist only in one model's conversation history.

## Source-of-truth order

1. Executable code, database migrations and automated tests.
2. `docs/TRD.md` for product requirements and boundaries.
3. `docs/ARCHITECTURE.md`, `SECURITY.md` and accepted ADRs for technical invariants.
4. `planning/project-tasks.json` and the live Kanban for delivery state.
5. `docs/ROADMAP.md` for sequencing and quality gates.

When these disagree, stop and reconcile them explicitly. Do not silently make documentation match an accidental implementation.

## Current architecture

- Dependency-free Python HTTP/API server with SQLite persistence.
- Browser application in plain HTML, CSS and JavaScript.
- Tenant context on project APIs; optimistic versions on mutable domain entities.
- Append-only audit and project change log.
- Offline browser outbox for field progress.
- Optional macOS telemetry agent; compute participation is opt-in and currently postponed.
- Current product version: `0.27.0`; current database schema: `023`.

## Non-negotiable invariants

- Preserve organization isolation on the server, not only in the UI.
- Every material domain mutation must be auditable.
- AI may propose changes, but permission checks, evidence preview and human approval precede application.
- Never destroy or rewrite user data to simplify a migration.
- Schema changes use numbered, checksum-verified migrations.
- Offline and partial-failure behavior must be explicit and testable.
- Role-aware UI never substitutes for server-side authorization.

## Safe development workflow

```bash
npm run check
./scripts/serve.sh
```

Before changing behavior, read the relevant TRD section, architecture section and ADR. After implementation, update tests, API/docs and Kanban task state in the same change. Preserve unrelated working-tree changes. Use a migration for persistent schema changes and verify an upgrade against existing data.

## Runtime and data

- Local/LAN web server defaults to port `4173`.
- SQLite data is stored in `data/fieldos.db`; the legacy filename is retained for compatibility.
- Agent enrollment/status secrets in `data/` must never be logged, committed or pasted into issue text.
- LAN mode is for a trusted network until authentication and transport security are complete.

## Current delivery focus

1. Correct statistics and progress formulas (`FS-070`).
2. Role-aware authorization and UI (`FS-073`).
3. Project work-type selection and field planning (`FS-064`, `FS-066`).
4. Employees, project presence and unified logs (`FS-067`, `FS-068`).
5. English-first localization with Russian profile option (`FS-069`).

Native applications and distributed compute remain lower priority until the web MVP and its domain contracts stabilize.

## Brand compatibility

The public working name is RackPilot by Valeronix. Legacy `FieldOS` identifiers may remain in filenames, database names and internal class/package names. Rename them only through an explicit compatibility plan; public UI and current documentation should use RackPilot by Valeronix.
