# Valeronix — Operational Intelligence for the Built World

AI-native операционная платформа для security, low-voltage и field service компаний.

Рабочая философия продукта: **Systems in context. Work in motion. Decisions with evidence.**

Интерфейс разделен на `#overview` для разработки платформы и `#projects` для операционных проектов компании.

## Быстрый запуск

```bash
./scripts/serve.sh
```

При запуске сервер выводит два адреса: `127.0.0.1` для этого компьютера и LAN-адрес вида `http://192.168.x.x:4173` для других устройств в той же сети.

По умолчанию `serve.sh` слушает локальную сеть. Чтобы ограничить доступ только текущим компьютером:

```bash
HOST=127.0.0.1 ./scripts/serve.sh
```

LAN-режим пока не имеет аутентификации и предназначен только для доверенной сети. Не настраивайте port forwarding и не публикуйте порт 4173 в интернет.

Сборка не требуется. Нужен только Python 3. Данные Kanban сохраняются в SQLite (`data/fieldos.db`) и локальном offline-кэше браузера; JSON-экспорт доступен из интерфейса.

## Структура

- `docs/` — техническая документация, handoff для разработчиков и шаблоны архитектурных решений.
- `web/` — локальная панель роста проекта и Kanban.
- `server/` — dependency-free HTTP API, SQLite persistence и static hosting.
- `tests/` — unit tests хранилища и validation boundary.
- `scripts/serve.sh` — локальный HTTP-сервер.

## Локальный API

- `GET /api/v1/health` — состояние процесса и версия схемы.
- `GET /api/v1/workspace` — актуальное состояние Kanban.
- `PUT /api/v1/workspace` — сохранение с optimistic revision и optional idempotency key.
- `GET /api/v1/projects` — tenant-scoped портфель проектов с рассчитанным прогрессом.
- `POST /api/v1/projects` — создание проекта и стандартных полевых этапов.
- `GET /api/v1/projects/{projectId}` — проект, этапы, здания и полевые задачи.
- `POST /api/v1/projects/{projectId}/buildings` — добавление здания в проект.
- `POST /api/v1/projects/{projectId}/work-items` — создание нормализованной полевой задачи.
- `PATCH /api/v1/projects/{projectId}/work-items/{workItemId}` — versioned update с проверкой workflow.
- `POST /api/v1/projects/{projectId}/work-items/{workItemId}/dependencies` — зависимость с cycle detection.
- `GET /api/v1/openapi.yaml` — OpenAPI 3.1 contract.

Старые `/api/health` и `/api/workspace` временно сохранены как compatibility aliases.

Проверка проекта: `npm run check`.

## Текущий статус

Это foundation/MVP с Project Detail и unit-level progress. Unit taps работают мгновенно и сохраняются в offline outbox до появления сети; система формирует текст дневного отчета для Jobber. Следующий шаг — фото, исполнители и редактирование unit metadata.
