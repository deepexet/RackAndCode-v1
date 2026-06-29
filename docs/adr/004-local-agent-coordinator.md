# ADR-004: Local control plane for AI development agents

- **Status:** Accepted
- **Date:** 2026-06-28
- **Owners:** Product Owner, Platform Architecture

## Context

RackPilot development uses Codex and Claude Code in parallel. Directly allowing both agents to edit one checkout creates race conditions, unclear ownership and unsafe approval behavior. Coupling orchestration to the customer-facing API would also make development automation part of the product failure domain.

## Decision

- Run Agent Coordinator as a separate local-only FastAPI process.
- Expose its controls later through an Administrator-only RackPilot proxy and UI.
- Give each write job a registered Git worktree and non-integration branch.
- Keep coordinator state in a separate SQLite database.
- Require a local control token for mutations and an explicit environment flag for process execution.
- Stop successful implementation jobs at review when review is required.
- Never allow agents to merge to `main`, change protected policy or transmit secrets without an external approval decision.

## Consequences

Agent crashes and coordinator upgrades do not take down the RackPilot product API. Parallel work consumes additional disk and test resources, but Git ownership remains explicit. A small local proxy is required before remote Admin clients can observe or control the coordinator.

## Verification

Unit tests cover queue creation, integration-branch rejection, lifecycle validation, review approval and shell-free command construction. Live health checks verify both installed agent CLIs while execution remains disabled.
