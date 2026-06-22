# Индекс документации

Документация развивается вместе с кодом. Изменение архитектуры считается завершенным только после обновления соответствующего документа или ADR.

| Документ | Назначение | Владелец | Статус |
|---|---|---|---|
| [TRD](TRD.md) | Требования, границы и критерии качества | Product + Architecture | Draft |
| [Brand](BRAND.md) | Рабочее имя, позиционирование и философия | Product | Active |
| [Engineering handoff](HANDOFF.md) | Продолжение разработки Codex, Claude или другим инженером | Architecture | Active |
| [Decision log](decisions.md) | Краткий реестр продуктовых и технических решений | Product + Architecture | Active |
| [Development log](development-log.md) | Хронология версий, реализации и проверок | Engineering | Active |
| [AI-assisted development](ai-assisted-development.md) | Provenance, контроль и правила AI-разработки | Product + Engineering | Active |
| [Архитектура](ARCHITECTURE.md) | Контексты, компоненты, данные и эволюция | Architecture | Proposed |
| [Надежность](RELIABILITY.md) | SLO, отказоустойчивость, DR и деградация | Platform/SRE | Proposed |
| [Безопасность](SECURITY.md) | Модель угроз, IAM, защита данных | Security | Proposed |
| [Эксплуатация](OPERATIONS.md) | Наблюдаемость, инциденты, релизы | Platform/SRE | Proposed |
| [Roadmap](ROADMAP.md) | Этапы поставки и quality gates | Product + Engineering | Active |
| [Local API](API.md) | Контракт foundation API и ограничения | Platform | Active |
| [Mobile baseline](MOBILE.md) | Responsive и mobile sync acceptance criteria | Web | Testing |
| [ADR template](adr/000-template.md) | Шаблон архитектурного решения | Architecture | Active |
| [ADR-001](adr/001-local-foundation-persistence.md) | Локальное API, SQLite и offline cache | Architecture | Accepted |
| [ADR-002](adr/002-versioned-api-and-migrations.md) | API v1, OpenAPI и checksum-миграции | Architecture | Accepted |
| [ADR-003](adr/003-tenant-context.md) | Organization и tenant data boundary | Architecture | Accepted |

## Стандарты ведения

- Версионирование: SemVer для продукта, дата + номер для ADR.
- Термины SHOULD/MUST/MAY трактуются в смысле RFC 2119.
- Диаграммы хранятся как Mermaid рядом с текстом.
- Каждый функциональный epic должен иметь требования, владельца, риски, зависимости и проверяемые acceptance criteria.
- Решения с долгосрочными последствиями фиксируются ADR до реализации.
- Каждая поставленная версия добавляется в development log; существенное решение — в decision log и при необходимости в отдельный ADR.
