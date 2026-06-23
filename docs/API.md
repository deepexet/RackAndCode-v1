# Local Foundation API

Base URL: `http://127.0.0.1:4173` или LAN-адрес, показанный при запуске. Формат ошибок и успешных ответов — JSON UTF-8. API v0.2 предназначен для single-user development workspace.

Workspace requests используют явный tenant context в заголовке `X-Organization-ID`. Локальный клиент работает в организации `local-dev`. Неизвестная или inactive организация получает `404 organization_not_found` до чтения или изменения workspace.

Локальный MVP также поддерживает development-only заголовок `X-RackPilot-Role` со значениями `Technician`, `Supervisor`, `ProjectManager`, `Administrator`. Он нужен для проверки route-level RBAC во время разработки. Это не production authentication: клиентский заголовок должен быть заменен signed session + persisted memberships перед коммерческим multi-company режимом.

## GET /api/v1/organizations

Возвращает организации локального foundation runtime. После реализации authentication этот endpoint будет фильтроваться memberships текущего пользователя.

Полный machine-readable контракт: `GET /api/v1/openapi.yaml`.

## GET /api/v1/health

Возвращает `status`, `service` и серверное UTC-время. Не проверяет внешние зависимости, поскольку foundation slice использует только локальную SQLite.

## GET /api/v1/audit/integrity

Проверяет cryptographic hash chain append-only журнала текущей организации. Опциональный query parameter `projectId` ограничивает проверку одним проектом. Ответ содержит `valid`, `eventCount`, `failureCount` и `verifiedAt`; содержимое событий наружу не раскрывается.

## Compute node telemetry

`POST /api/v1/telemetry/nodes/{nodeId}` принимает heartbeat только с `X-Agent-Token`. `GET /api/v1/admin/compute-nodes` возвращает узлы и последние метрики для Admin UI. `PATCH /api/v1/admin/compute-nodes/{nodeId}/enabled` управляет допуском к вычислениям; включение невозможно, пока сам agent не передал opt-in.

## GET /api/v1/workspace

Возвращает `initialized`, `revision`, `tasks`, `audit`, `updatedAt`.

## PUT /api/v1/workspace

Тело:

```json
{
  "expectedRevision": 4,
  "tasks": [],
  "audit": []
}
```

Сохранение выполняется атомарно. При несовпадении `expectedRevision` сервер отвечает стандартным `409 revision_conflict`. Заголовок `Idempotency-Key` позволяет безопасно повторить тот же PUT; повторное использование ключа с другим телом возвращает `409 idempotency_key_reused`. Максимальный размер запроса — 2 MiB.

Каждый ответ содержит `X-API-Version` и `X-Request-ID`. Клиент может передать собственный безопасный `X-Request-ID` длиной до 64 символов. Ошибки имеют единый envelope: `error.code`, `error.message`, `error.details`, `requestId`.

Legacy paths без `/v1` временно остаются compatibility aliases.

## Security boundary

Штатный `serve.sh` слушает все локальные интерфейсы для доступа с устройств в доверенной LAN; прямой запуск Python-модуля остается loopback-only. Production authentication еще не реализован, поэтому публикация порта в интернет запрещена. Текущий route-level RBAC защищает MVP-потоки от случайных действий при выбранной роли, но не заменяет настоящую identity/session модель. Loopback-only режим запускается через `HOST=127.0.0.1 ./scripts/serve.sh`.
