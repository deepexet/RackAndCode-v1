# Development log

Append-only summary of material product development. Git commits are the detailed change record; this log explains intent, scope and verification at release level.

## 2026-06-22 — v0.23.0

- Selected Valeronix as the public working identity and documented brand philosophy.
- Added an engineering handoff independent of any single AI model or conversation.
- Implemented automatic project Daily Log from project audit events.
- Kept manual daily entries as editable explanations alongside immutable automatic events.
- Added migration `020_valeronix_brand.sql` for the visible internal project name.
- Added Kanban task `FS-075` at Critical priority and moved it to Testing.
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
