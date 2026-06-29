# FastAPI endpoint migration

This file tracks bounded endpoint migrations while `server/app.py` remains the
supported legacy API. Migrating an endpoint does not authorize deleting,
archiving, or redirecting its legacy implementation.

## Current implementation scope

Selected groups: **Logs and audit reads**, plus the read-only **Overview KPI** compatibility slice.

Priority rationale:

- The current Vite Logs and Admin modules call `/api/v1/logs` and
  `/api/v1/admin/audit-log`, but FastAPI did not expose either route.
- The group is read-only and tenant-scoped, so it restores an active UI path
  without introducing mutation or database-migration risk.
- Existing store and legacy-route tests define the response and RBAC contracts.

Endpoints:

| Endpoint | Permission | Contract |
|---|---|---|
| `GET /api/v1/logs` | `logsRead` | Unified project/workspace log with source, project, entity, text, and limit filters |
| `GET /api/v1/audit/integrity` | `logsRead` | Hash-chain verification, optionally scoped by `projectId` |
| `GET /api/v1/admin/audit-log` | `adminPanel` | Recent tenant security events, capped at 500 rows |
| `GET /api/v1/overview/kpi` | `projectRead` | Tenant-scoped dashboard counts for active projects, work orders and stock alerts |
| `GET /api/v1/critical-tasks` | `projectRead` | Tenant-scoped critical task read model |

Dependencies and boundaries:

- `backend/app/store` continues to wrap the legacy `WorkspaceStore` and shared
  role policy until the Phase 2 store split.
- Authentication and tenant resolution come from `app.middleware.auth.Auth`.
- Permission checks fail closed for unauthenticated requests and unknown roles;
  unauthenticated role preview is accepted only in explicit LAN development mode.
- No database schema or data migration is required.
- `server/app.py`, its handlers, and its compatibility behavior remain intact.
- User activity aggregation, API metrics, time tracking, search, and all write
  endpoints are outside this bounded group.

Verification is covered by focused FastAPI integration tests for filters,
tenant isolation, response limits, audit integrity, dashboard counts, and role separation.
