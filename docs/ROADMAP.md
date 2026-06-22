# Roadmap

## Phase 0 — Foundation

Документация, Development Workspace, domain vocabulary, ADR, CI quality baseline. Exit: задачи и архитектурные решения управляются из единой среды.

Текущий инкремент: unit taps получили optimistic UI, сохранение выбранного scope и durable offline outbox. Следующий gate: редактирование имен units, фото проблем и исполнители.

Полная декомпозиция TRD хранится в `planning/project-tasks.json` и идемпотентно загружается командой `./scripts/load_roadmap.py`. Загрузчик добавляет отсутствующие work items и не перезаписывает вручную выбранные статусы и приоритеты существующих задач.

FS-053 выделяет responsive mobile Development Workspace из будущего native Epic FS-044. Web-версия должна оставаться полностью функциональной на телефонном viewport до начала упаковки iOS/Android приложений.

## Phase 1 — Platform Core

Identity/tenancy, RBAC/ABAC, Projects, task engine, audit, API contracts, observability. Exit: безопасный multi-tenant web workflow.

## Phase 2 — Field Operations

Digital Twin, assets, documents, PWA offline cache/outbox, photos/checklists/time. Exit: техник завершает базовый workflow без устойчивой сети.

## Phase 3 — Intelligence

Permission-aware knowledge, document processing, AI gateway, project/technical/reporting agents, evaluation harness. Exit: ответы с источниками и управляемые AI actions.

## Phase 4 — Scale & Ecosystem

Mobile/desktop packaging, integration SDK, optional connectors, DR validation, enterprise controls. Exit: production readiness по утвержденным SLO и security review.

## Definition of Done

- Acceptance criteria проверены автоматически или документированно.
- Tests, telemetry, accessibility и security impact учтены.
- Migration/rollback и operational ownership определены.
- Документация и ADR обновлены.
- Нет незадокументированных critical dependencies.
