# AI-assisted development record

## Project control

Valeronix is directed by Valerii Sergeev. Codex is the primary AI development system responsible for implementation, technical planning, testing and documentation under user direction. Other AI systems or human engineers may contribute, but contributions must follow the same repository controls and review gates.

Copyright © 2026 Valerii Sergeev. All rights reserved, subject to any applicable employment, client or third-party agreements. This repository record documents development provenance; it is not a legal determination of ownership or trademark availability.

## Contribution provenance

AI-assisted changes MUST be represented as normal repository changes with:

- a user request or approved roadmap task;
- reviewable source changes rather than opaque generated binaries;
- automated tests proportional to risk;
- updated architecture, API or decision documentation when behavior changes;
- a Git commit identifying the scope and verification performed;
- disclosure of any copied or adapted third-party material and its license.

Chat history is supporting context, not the source of truth. The repository, its Git history, requirements, ADRs, tests and development log form the durable project record.

## Human and AI responsibilities

- Product intent, commercial decisions and final acceptance remain under user control.
- Codex reviews generated code, runs verification and records known limitations.
- AI output is never accepted solely because it compiles; security boundaries, tenant isolation, audit integrity and migration safety require explicit tests.
- AI-generated project changes require preview and human approval before being applied to production data.
- Secrets, private customer data and runtime tokens must not enter prompts, commits or logs.

## Third-party and model policy

Contributors must not insert code, media, documents or datasets with unknown provenance. Dependencies and generated assets must be recorded with their license and source where applicable. Model-generated output should be original to the requested implementation and reviewed for suspicious similarity before release.

## Commit attribution

The Git author identifies the person or organization controlling the repository change. When useful, commit bodies may include `AI-assisted-by: Codex` or another tool name. AI systems are recorded as tools/contributors, not substituted for the repository owner or accountable reviewer.

## Legal follow-up

Before commercial launch, obtain professional review of employment/IP agreements, contributor assignments, privacy obligations, product licensing and trademark clearance for Valeronix in target jurisdictions. Documentation and Git history provide evidence of provenance but do not replace those steps.
