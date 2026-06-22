# ADR-001: Локальное foundation-хранилище

- **Статус:** Accepted
- **Дата:** 2026-06-22
- **Владельцы:** Platform Architecture
- **Связанные задачи:** FS-002, FS-004, FS-005

## Контекст

Development Workspace должен запускаться локально без установки зависимостей, сохранять Kanban после перезапуска процесса и оставаться доступным при кратком отсутствии сервера.

## Decision drivers

- Один launch command и стандартный Python runtime.
- Durable persistence и атомарные обновления.
- Проверяемая граница UI/API/storage.
- Возможность последующей замены storage без переписывания UI.

## Рассмотренные варианты

- Только `localStorage`: просто, но данные привязаны к профилю браузера и не имеют серверной durability.
- Node framework + embedded database: удобнее для расширения, но требует dependency lifecycle уже на foundation-этапе.
- Python standard library + SQLite: минимальная поверхность зависимостей, транзакционность и достаточная локальная надежность.

## Решение

Использовать dependency-free Python HTTP server и SQLite WAL. Клиент немедленно пишет изменения в `localStorage`, затем синхронизирует workspace через revision-checked API.

## Последствия

Решение подходит для single-user foundation, но full-state writes и local-wins retry не подходят для совместной работы. До multi-user запуска необходимы entity-level API, версии, tombstones, authentication и tenant policies.

## Проверка

Unit tests подтверждают сохранение и revision conflict. Browser smoke test подтверждает UI → API → SQLite и восстановление после полного перезапуска сервера.

