# AI collaboration protocol

Repository code, tests, migrations, documentation and Git history are the source of truth for parallel AI-assisted development.

## Ownership

- Product owner: Valeri Sergeev.
- Lead developer and integration reviewer: Codex.
- Parallel implementation agent: Claude Code.

Current allocation:

- Claude finishes the in-progress diagram editor work and provides a commit-level handoff. Existing uncommitted `overview.js` work must be explicitly included or handed back; it must not be discarded.
- Codex owns FastAPI migration, security review, integration tests, Agent Coordinator and acceptance before changes enter `main`.

## Parallel workflow

1. Agents never work in the same working tree.
2. Each write task uses a dedicated Git worktree and branch.
3. `main` is an integration branch, not an agent workspace.
4. Agents do not stage, overwrite or clean another agent's files.
5. Shared API, migration, authentication, RBAC, core frontend and planning contracts require coordination.
6. Tests use isolated databases. User attachments and secrets never enter Git.

## Handoff contract

Every handoff states the branch and commit, behavior implemented, files and migrations changed, commands and results, known limitations, untested paths and security/data impact.

Codex reviews the diff and relevant quality gates. A task is not complete merely because a UI exists or its Kanban status says `Done`.

## Primary objective

Migrate every active feature to the Vite and FastAPI stack, enforce authenticated tenant-aware RBAC, split the legacy store by domain, verify parity and backups, and only then archive or remove the legacy stack.
