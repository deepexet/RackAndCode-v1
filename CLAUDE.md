# RackPilot — Agent Instructions (CLAUDE.md)

This file is read by Claude Code and Codex at the start of every session.
Keep it current as the codebase evolves.

Before making changes, read `docs/AI_COLLABORATION.md` and follow its ownership,
worktree, shared-boundary and handoff rules.

## Project

**RackPilot by Valeronix** — Field Operations Platform.
Manages Projects, Inventory, Field Operations, Assets, and AI-assisted workflows.
Designed to grow large — think scalability and modularity in every decision.

## Stack (current as of 2026-06-27)

| Layer | Technology |
|-------|-----------|
| Backend | **FastAPI** + Uvicorn (async, type-safe) |
| Database | **SQLite** with WAL mode (migration path to PostgreSQL) |
| Migrations | Numbered SQL files in `server/migrations/NNN_description.sql` |
| Frontend | **Vanilla JS + ES modules**, built with **Vite** |
| Containers | Docker + docker-compose |
| Auth | Session tokens (cookie + Bearer), TOTP MFA (no external libs) |

## Directory layout

```
backend/          ← FastAPI app (NEW — canonical backend)
  app/
    main.py       ← FastAPI entry point, lifespan, middleware
    core/         ← config.py, database.py, security.py
    middleware/   ← auth.py (Auth dependency, session resolution)
    store/        ← __init__.py imports WorkspaceStore (Phase 1 adapter)
    routes/       ← one .py per domain: auth, projects, inventory, ...

frontend/         ← Vite SPA (NEW — canonical frontend)
  src/
    main.js       ← entry, auth bootstrap, router.on() registrations
    core/         ← api.js, router.js, store.js
    modules/      ← one .js per route (lazy-loaded), mount()/unmount()

server/           ← LEGACY monolith (DO NOT ADD NEW FEATURES HERE)
  app.py          ← WorkspaceStore class (being migrated to store/)
  migrations/     ← SQL files (canonical, used by both stacks)

web/              ← LEGACY frontend (DO NOT ADD NEW FEATURES HERE)
docs/             ← Architecture, migration plan, ADRs
```

## Development workflow

### Run locally (recommended)
```bash
# Backend
cd backend && python run.py        # FastAPI on :4173

# Frontend (separate terminal)
cd frontend && npm run dev         # Vite on :5173 (proxies /api to :4173)
```

### Run legacy (temporary, during migration)
```bash
HOST=0.0.0.0 PORT=4173 python3 server/app.py
```

### Docker
```bash
docker-compose up --build          # Production build
docker-compose --profile dev up    # Dev with Vite container
```

## Rules for agents (Claude + Codex)

### 1. Always add new features to the NEW stack
- New API endpoint → `backend/app/routes/<domain>.py`
- New UI → `frontend/src/modules/<domain>.js`  
- New DB table → `server/migrations/NNN_description.sql` (always new file, never edit existing)

### 2. Do NOT add features to legacy `server/app.py` or `web/app.js`
The legacy files are being phased out. Any new methods in `WorkspaceStore` are temporary until Phase 2 store split.

### 3. Store rules
- Every store method: first param is `org: str`
- Every mutation: call `self.audit(conn, org, "domain.action", entity_id, ...)`
- Use `self._connect()` context manager, never raw `sqlite3.connect()`

### 4. Migration rules
- File naming: `NNN_short_description.sql` (next sequential number)
- `CREATE TABLE IF NOT EXISTS` (always idempotent)
- `CREATE INDEX IF NOT EXISTS`
- Never `DROP`, never `ALTER TABLE` that loses data
- No foreign key changes that break existing data

### 5. Security invariants (never break)
- Organization isolation: every query filters by `organization_id`
- Session tokens never logged or committed to git
- `master_key` / `.env` never committed
- `X-RackPilot-Role` is dev-only preview, never trusted as auth
- AI never writes to production data without human approval flow

### 6. API conventions
- GET — read, no side effects
- POST — create or update (we use POST for updates for simplicity, no PUT/PATCH)
- POST `/{id}/delete` — soft or hard delete
- Responses: always JSON with camelCase keys
- Errors: `{"error": {"message": "...", "type": "..."}}`

## Phase status

See `docs/MIGRATION.md` for current migration phase status.

**Current Phase: 1** — FastAPI routes are live, store still uses legacy WorkspaceStore import.

## Schema version

Current migration number: **089** (next: 090)
File: `server/migrations/089_wi_dependencies.sql`

## Tests

```bash
python3 -m unittest discover -s tests -v   # legacy tests
cd backend && pytest                        # new FastAPI tests (coming in Phase 2)
```

## Contact

Platform owner: Valeri Sergeev
Lead developer and integration reviewer: Codex
Parallel implementation agent: Claude Code
