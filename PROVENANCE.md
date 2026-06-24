# RackPilot — Development Provenance

## AI-Assisted Development Policy

This project is developed with AI assistance (Claude Sonnet / Codex). All commits are
Co-authored by Claude and signed with the repository owner's git identity.

### Authorship model

| Layer | Author |
|---|---|
| Product decisions, acceptance, direction | Valeri Sergeev (@valerisergeev) |
| Architecture, code generation, implementation | Claude (Anthropic) + Valeri Sergeev |
| Security review, final merge | Valeri Sergeev |

### What AI may propose

- New features, migrations, endpoints, UI components
- Test coverage, refactoring, performance improvements
- Documentation, comments, configuration

### What requires human approval before merging

- Schema migrations that destroy or rewrite data
- Permission model changes (RBAC, session, API auth)
- Secrets management changes
- CI/CD pipeline modifications
- External integrations that transmit user data

### What AI never does

- Commits secrets, credentials, or tokens
- Pushes to protected branches directly
- Bypasses pre-commit hooks (`--no-verify`)
- Modifies audit trail tables
- Makes purchasing or billing decisions

## Runtime secrets policy

Secrets live in:
- `data/.master_key` — encryption master key (generated locally, never committed)
- Environment variables — `RACKPILOT_AGENT_TOKEN`, `ANTHROPIC_API_KEY`, etc.

The `.gitignore` excludes `data/`, `*.env`, `*.pem`, `*.key`.

## Reproducibility

Every schema change is a numbered, SHA-256 checksum-verified migration in
`server/migrations/`. The migration runner enforces monotonic ordering.
The CI gate (`npm run check`) must pass before any merge.

## AI session log

Sessions are tracked via `Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>`
trailer in each commit. The git log is the authoritative record of AI involvement.
