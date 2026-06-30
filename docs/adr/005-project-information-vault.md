# ADR-005: Защищённое хранилище проектных данных (Project Information Vault)

- **Статус:** Proposed
- **Дата:** 2026-06-30
- **Владельцы:** Platform Architecture, Security
- **Связанные задачи:** ed852213-333e-4fc7-b95f-aaa7b941e3bc
- **Связанные ADR:** ADR-003 (tenant-context), ADR-004 (local-agent-coordinator)

---

## Контекст

RackPilot хранит чувствительные операционные данные: коды доступа к объектам, учётные данные VPN, пароли к оборудованию, токены интеграций, сертификаты и конфигурации клиентов. В текущей реализации эти данные рассредоточены по полям проектов, комментариям и attachment-ам.

**Выявленные проблемы:**

1. `secrets_vault` (миграция 027) не содержит `organization_id` — secrets не изолированы по tenant.
2. TOTP-секреты в `mfa_credentials` хранятся без шифрования.
3. Нет project-scoped хранилища: глобальный vault не позволяет давать доступ к секретам на уровне проекта.
4. Нет явных правил исключения секретов из AI-контекста на уровне API.
5. Retention и backup policy для секретов не определены.

**Область:** только backend-контракты, схема БД и документация. Имплементация кода — следующий шаг после Codex/owner review.

---

## Decision drivers

- Tenant isolation: каждый запрос к vault фильтруется по `organization_id` до `project_id`.
- Encrypt-then-MAC: целостность и конфиденциальность каждой записи независимо.
- Least privilege: роль по умолчанию (Technician) не имеет доступа к vault.
- AI exclusion: ни одно значение из vault не попадает в AI-промпты или agent tool results.
- Immutable audit: каждое чтение и запись значения логируются в `audit_log`.
- Offline-first: шифрование на стороне сервера без зависимости от внешних KMS.
- Non-repudiation: soft-delete, no hard deletes; версионирование записей.

---

## Рассмотренные варианты

### Вариант A — Расширить существующий `secrets_vault`

Добавить `organization_id` и `project_id` в текущую таблицу.

**Плюсы:** минимальная миграция, одна таблица.  
**Минусы:** нарушит существующий уникальный индекс `idx_secrets_name`; смешает org-level и project-level семантику; потребует breaking-change в API, который уже используется.  
**Решение:** отклонено.

### Вариант B — Отдельная таблица `project_vault` + исправить `secrets_vault`

Создать `project_vault` для project-scoped секретов; отдельной миграцией добавить `organization_id` в `secrets_vault` (исправить критический баг изоляции).

**Плюсы:** чистое разделение семантик; org-level и project-level vault независимы; не ломает существующий API.  
**Минусы:** две таблицы требуют двух путей шифрования.  
**Решение:** принято.

### Вариант C — Внешний KMS (HashiCorp Vault, AWS Secrets Manager)

**Плюсы:** enterprise-grade rotation, HSM.  
**Минусы:** противоречит offline-first требованию; внешняя зависимость; усложняет dev-workflow.  
**Решение:** отложено до Phase 3 (cloud deployment).

---

## Решение

### 1. Иерархия ключей

```
master_key  (32 байта, ~/.rackpilot/.master_key, chmod 600)
    └── org_key     = HMAC-SHA256(master_key, "org-vault:{org_id}")
            └── project_key = HMAC-SHA256(org_key, "project:{project_id}")
                    └── entry_key   = HMAC-SHA256(project_key, "entry:{entry_id}")
```

Каждая запись зашифрована уникальным `entry_key`. Компрометация одной записи не раскрывает другие.

**Алгоритм шифрования:** HMAC-CTR (existing) с encrypt-then-MAC:
- `enc_key = HMAC-SHA256(entry_key, "enc")`
- `mac_key = HMAC-SHA256(entry_key, "mac")`
- Nonce = 16 случайных байт per encryption
- Ciphertext = XOR(plaintext, HMAC-keystream(enc_key, nonce))
- MAC = HMAC-SHA256(mac_key, nonce || ciphertext)
- Stored: `hex(nonce):hex(ciphertext):hex(mac)`

> Миграционный путь к AES-256-GCM: отдельный ADR-006 после Phase 2.

### 2. Схема таблиц (см. миграции 099, 100)

```
project_vault          — проектные секреты (org+project scoped, encrypted)
project_vault_history  — append-only история изменений (immutable)
secrets_vault          — исправлен: добавлен organization_id (миграция 100)
```

### 3. RBAC расширение

Новые permissions добавляются к `ROLE_POLICIES` в `server/app.py` (code change, не миграция):

| Разрешение      | Technician | Supervisor | ProjectManager | Administrator |
|-----------------|:----------:|:----------:|:--------------:|:-------------:|
| `vaultList`     | —          | ✓          | ✓              | ✓             |
| `vaultManage`   | —          | —          | ✓              | ✓             |
| `vaultAudit`    | —          | —          | —              | ✓             |
| `secretsManage` | —          | —          | —              | ✓             |

`vaultList` — видеть имена/категории записей (не значения).  
`vaultManage` — CRUD значений внутри проектов, назначенных пользователю.  
`vaultAudit` — читать журнал доступа к vault.  
`secretsManage` — управление org-level `secrets_vault` (уже существует, только Administrator).

Оба `vaultManage` и `secretsManage` попадают в `SESSION_REQUIRED_PERMISSIONS` — LAN-mode header их не разблокирует.

### 4. API эндпоинты (контракт, реализация — следующий спринт)

```
GET  /api/v1/projects/{project_id}/vault            — список записей (имена, категории)
POST /api/v1/projects/{project_id}/vault            — создать запись
GET  /api/v1/projects/{project_id}/vault/{id}       — метаданные записи (без значения)
POST /api/v1/projects/{project_id}/vault/{id}/reveal — получить расшифрованное значение*
POST /api/v1/projects/{project_id}/vault/{id}       — обновить запись
POST /api/v1/projects/{project_id}/vault/{id}/delete — soft-delete
GET  /api/v1/projects/{project_id}/vault/{id}/history — история версий
```

`*` `/reveal` требует `vaultManage` + запись в audit_log с outcome и ip.

**Формат ответа reveal:**
```json
{
  "id": "...",
  "value": "...",
  "expires_in_seconds": 30,
  "audit_ref": "..."
}
```
Значение передаётся единоразово; клиент не должен кэшировать.

### 5. AI exclusion rules

- Backend middleware при сборке agent context фильтрует source == `project_vault`.
- Tool results не могут содержать поля `encrypted_value` или расшифрованные значения.
- AI agents получают только placeholder: `{{vault:entry_name}}` — reference, не значение.
- Endpoint `/reveal` недоступен agent-сессиям (проверяется `ctx.is_agent_session`).
- Правило документируется в `docs/ai-assisted-development.md`.

### 6. Retention и backup

- Записи vault: soft-delete (поле `deleted_at`), хранятся минимум 90 дней до физического удаления.
- `project_vault_history`: immutable, никогда не удаляется физически.
- Backup: SQLite WAL-checkpoint перед backup; backup включает `data/.master_key` в отдельном зашифрованном архиве (Operator responsibility).
- Retention policy регулируется через существующую таблицу `privacy_controls`.

### 7. Исправление критических багов (миграции 099, 100)

- **100:** добавить `organization_id` в `secrets_vault`, перестроить уникальный индекс как `(organization_id, name)`.
- **099:** создать `project_vault` и `project_vault_history`.
- TOTP encryption: отдельная задача Phase 2 (требует runtime re-encryption, не только schema change).

---

## Последствия

**Положительные:**
- Устранён critical bug tenant isolation в `secrets_vault`.
- Project-level секреты изолированы per-entry ключами.
- Полный audit trail каждого reveal.
- AI не может получить vault values даже при prompt injection.

**Отрицательные / риски:**
- Потеря `master_key` = невозможность восстановить зашифрованные данные — Operator обязан хранить резервную копию ключа.
- Нет ротации ключей в текущей схеме — добавить в ADR-006.
- HMAC-CTR не является стандартным AEAD — техдолг до AES-256-GCM.

**Обратимость:** миграции 099 и 100 идемпотентны (`CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`). Rollback потребует ручного удаления таблиц (не автоматизирован).

---

## Проверка

1. Интеграционный тест: создать запись vault для org A, убедиться что org B не видит её в list.
2. Тест AI exclusion: agent tool call не содержит поле `encrypted_value` или raw value.
3. Audit test: каждый `/reveal` вызов создаёт запись в `audit_log` с `action="vault.reveal"`.
4. Tamper test: изменить `encrypted_value` в БД напрямую → decrypt возвращает ошибку MAC.
5. Migration smoke: применить 099 + 100 на пустой БД и на существующей — оба случая без ошибок.
