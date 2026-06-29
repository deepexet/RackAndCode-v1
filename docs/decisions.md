# Decision log

Краткий хронологический реестр решений RackPilot by Valeronix. Архитектурные решения с долгосрочными последствиями дополнительно оформляются отдельными ADR в [`docs/adr`](adr/).

## 2026-06-22 — RackPilot by Valeronix selected as the working product name

- **Status:** Accepted as working identity; legal clearance pending.
- **Decision:** Public product name is RackPilot by Valeronix. Internal compatibility identifiers such as `fieldos-platform` and `fieldos.db` may remain until a controlled migration is justified.
- **Reason:** The name retains a founder connection while supporting a broader technology and operational-intelligence category.
- **Reference:** [`BRAND.md`](BRAND.md).

## 2026-06-22 — Codex is the primary developer without vendor lock-in

- **Status:** Accepted.
- **Decision:** Codex leads implementation, architecture and planning. Repository code, tests, requirements, ADRs and logs remain sufficient for another model or engineer to continue the work.
- **Reason:** Development continuity and ownership evidence must not depend on private chat history or a single AI provider.
- **Reference:** [`HANDOFF.md`](HANDOFF.md), [`ai-assisted-development.md`](ai-assisted-development.md).

## 2026-06-22 — Daily Log derives from immutable project activity

- **Status:** Implemented in v0.23.0.
- **Decision:** Project Daily Log is generated from append-only project changes and combined with versioned manual explanations. It is not maintained as a second independent progress source.
- **Reason:** Automatic reporting must remain traceable and avoid divergent records.
- **Reference:** [`ARCHITECTURE.md`](ARCHITECTURE.md#automatic-project-daily-log-v023).

## Architecture decisions

- [ADR-001 — Local foundation persistence](adr/001-local-foundation-persistence.md)
- [ADR-002 — Versioned API and migrations](adr/002-versioned-api-and-migrations.md)
- [ADR-003 — Tenant context](adr/003-tenant-context.md)
- [ADR-004 — Local AI agent coordinator](adr/004-local-agent-coordinator.md)
