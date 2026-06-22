# ADR-002: Версионируемый API и checksum-миграции

- **Статус:** Accepted
- **Дата:** 2026-06-22
- **Владельцы:** Platform Architecture
- **Связанные задачи:** FS-013, FS-014

## Контекст

Web, mobile, desktop и integration clients требуют стабильного контракта, а durable storage — воспроизводимой эволюции схемы без скрытых изменений.

## Решение

- Публичный foundation contract размещается под `/api/v1` и описывается OpenAPI 3.1.
- Legacy paths временно работают как compatibility aliases.
- Ответы содержат API version и correlation request ID; ошибки используют единый envelope.
- Повторяемые writes могут передавать `Idempotency-Key`.
- SQLite migrations являются нумерованными SQL-файлами, выполняются транзакционно и фиксируются с SHA-256 checksum.
- Изменение уже примененной миграции является startup error; исправления выпускаются новой миграцией.

## Последствия

Контракт можно генерировать и тестировать независимо от UI. Схема воспроизводима на новой базе и проверяема на существующей. До production API еще необходимы authentication, tenant authorization, pagination policy и entity-level resources.

## Проверка

Unit tests подтверждают idempotent migrations, checksum rejection и idempotency persistence. Integration smoke test подтверждает v1, legacy aliases, headers, OpenAPI и безопасный replay PUT.

