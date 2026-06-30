# AI collaboration protocol

Repository code, tests, migrations, documentation and Git history are the source of truth for parallel AI-assisted development. Agent conversations are not authoritative project state.

## Team roles

- **Product Owner — Valeri:** product direction, priorities, commercial decisions and final acceptance of material scope changes.
- **Architecture Lead — Claude:** architecture proposals, ADRs, module boundaries, data contracts, dependency plans and architectural risk analysis.
- **Engineering & Integration Lead — Codex:** repository validation, security constraints, implementation planning, code and test review, conflict resolution and controlled integration.
- **Local AI Helper:** bounded text-only triage, summaries, classification and extraction without file or command access.

Architecture becomes actionable only after Claude records the proposal in an ADR and Codex records its technical review. Material product tradeoffs remain subject to Product Owner approval. No agent merges to the integration branch automatically.

## Parallel Git workflow

1. Agents never write in the same working tree.
2. Every write task uses a dedicated branch and Git worktree.
3. `main` is an integration branch, not an agent workspace.
4. Commit one completed, testable unit at a time; do not mix unrelated features or generated runtime data.
5. Agents never stage, overwrite, clean or discard another agent's files.
6. Rebase or merge the current integration base before requesting review.
7. Successful implementation jobs stop for Codex and human review.

## Shared boundaries

Coordinate before modifying:

- `server/migrations/` and schema versions;
- API paths, request and response contracts;
- authentication, sessions, RBAC and organization isolation;
- `frontend/src/core/`, shared navigation and global styles;
- `planning/project-tasks.json`;
- architecture, migration and handoff documentation.

If work crosses its assigned boundary, stop and record the dependency instead of silently expanding scope.

## Data isolation

- Automated tests use temporary databases, never the owner's working database.
- `data/attachments/` is user data: preserve it, exclude it from Git and include it in backup design.
- Secrets, session tokens, private attachments, runtime databases and agent session files never enter commits, fixtures or logs.

## Required handoff

Every handoff states:

- branch and commit hashes;
- implemented behavior and remaining limitations;
- files and migrations changed;
- verification commands and results;
- known failures and untested paths;
- UI/manual verification notes where relevant;
- security, tenant-isolation and data-migration impact.

Codex reviews the diff and quality gates. A feature is not complete merely because its UI exists or its Kanban status says `Done`.

## Delivery loop

```text
Product priority -> Claude architecture/ADR -> Codex technical review and task split
                 -> isolated implementation jobs -> Codex integration review
                 -> tests and preview -> Product Owner acceptance
```

## Current engineering priority

1. Make FastAPI reproducibly runnable and tested.
2. Preserve API behavior while replacing legacy HTTP routing.
3. Enforce authenticated identity, organization membership and role permissions server-side.
4. Extract the monolithic `WorkspaceStore` into domain stores.
5. Move active features to the Vite and FastAPI stack.
6. Validate feature parity, migrations, backups and offline behavior.
7. Archive or remove the legacy stack only after an explicit parity and rollback review.
