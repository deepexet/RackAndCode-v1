# Threat Model — Project Information Vault

**Версия:** 1.0  
**Дата:** 2026-06-30  
**Методология:** STRIDE  
**Область:** `project_vault`, `secrets_vault`, `/reveal` endpoint, AI agent integration  
**Связан с:** ADR-005

---

## 1. Границы системы (Trust Boundaries)

```
┌─────────────────────────────────────────────────────────────┐
│  Internet / LAN                                             │
│                                                             │
│   Browser ──HTTPS──► [FastAPI :4173]                        │
│   AI Agent ──────────► [FastAPI :4173]                      │
│                              │                              │
│                        [Auth Middleware]                    │
│                              │                              │
│              ┌───────────────┼───────────────┐             │
│              │               │               │             │
│         [project_vault]  [secrets_vault]  [audit_log]      │
│              │                                              │
│         [SQLite WAL] ── [.master_key] (chmod 600)          │
└─────────────────────────────────────────────────────────────┘
```

**Trust boundaries:**
- TB-1: Интернет/LAN → FastAPI (TLS терминация)
- TB-2: FastAPI → SQLite (локальный процесс; защита = OS file permissions)
- TB-3: FastAPI → `.master_key` (локальный файл; защита = chmod 600 + OS user)
- TB-4: FastAPI → AI Agent (внутренняя шина агентов; защита = is_agent_session flag)

---

## 2. Активы и их ценность

| Актив | Конфиденциальность | Целостность | Доступность |
|-------|:-----------------:|:-----------:|:-----------:|
| Зашифрованные значения vault | Критическая | Высокая | Средняя |
| `master_key` | Критическая | Критическая | Высокая |
| Имена/категории записей vault | Средняя | Средняя | Высокая |
| `audit_log` vault events | Низкая | Критическая | Высокая |
| Сессионные токены | Высокая | Высокая | Средняя |

---

## 3. Threat Matrix (STRIDE)

### S — Spoofing (Подмена личности)

| ID | Угроза | Вектор | Вероятность | Воздействие | Митигации |
|----|--------|--------|:-----------:|:-----------:|-----------|
| S-1 | Атакующий использует украденный session token для `/reveal` | XSS, network sniff | Средняя | Критическая | HTTPS-only; session TTL 8ч; token как SHA-256 hash в БД (не plaintext); HttpOnly cookie |
| S-2 | Злоумышленник передаёт `X-RackPilot-Role: Administrator` в prod | Header injection | Низкая | Критическая | `SESSION_REQUIRED_PERMISSIONS` включает `vaultManage`; LAN-mode header отклоняется для vault endpoints |
| S-3 | AI agent выдаёт себя за аутентифицированного пользователя | Agent prompt injection | Средняя | Высокая | `is_agent_session` flag в SessionContext; `/reveal` отклоняет agent сессии; agent identity не наследует user permissions |

### T — Tampering (Подмена данных)

| ID | Угроза | Вектор | Вероятность | Воздействие | Митигации |
|----|--------|--------|:-----------:|:-----------:|-----------|
| T-1 | Прямое изменение `encrypted_value` в SQLite файле | Физический доступ к серверу | Низкая | Высокая | MAC verification до decrypt; tamper → HMAC mismatch → error, не corruption |
| T-2 | Подмена `entry_key` деривации (изменение `entry_id`) | SQL injection в параметрах | Очень низкая | Критическая | Параметризованные запросы; `entry_id` фиксируется при создании; key включает `entry_id` в derivation |
| T-3 | Удаление записи из `audit_log` | Прямой DB доступ | Низкая | Высокая | Hash-chain в `project_audit` (migration 013); `audit_log` — append-only trigger |

### R — Repudiation (Отречение)

| ID | Угроза | Вектор | Вероятность | Воздействие | Митигации |
|----|--------|--------|:-----------:|:-----------:|-----------|
| R-1 | Пользователь отрицает факт reveal значения | — | Средняя | Высокая | Каждый `/reveal` → `audit_log` запись с `actor_id`, `ip`, `created_at`, `outcome`; запись неудаляема |
| R-2 | Администратор отрицает создание/удаление записи vault | — | Низкая | Средняя | `created_by` + audit event `vault.create` / `vault.delete` с actor |

### I — Information Disclosure (Утечка данных)

| ID | Угроза | Вектор | Вероятность | Воздействие | Митигации |
|----|--------|--------|:-----------:|:-----------:|-----------|
| I-1 | Vault value попадает в AI-промпт (prompt injection) | Вредоносный project document | Высокая | Критическая | Backend middleware фильтрует `project_vault` source из agent context; `/reveal` отклоняет agent сессии |
| I-2 | Vault value появляется в application логах | Неаккуратное логирование | Средняя | Критическая | Logging policy: `encrypted_value` и plaintext после decrypt никогда не логируются; только `vault_id` и `outcome` |
| I-3 | Cross-tenant чтение vault записей | Отсутствие `organization_id` фильтра | Высокая | Критическая | **Текущий баг в `secrets_vault`** — исправляется миграцией 100; `project_vault` создаётся с обязательным `organization_id` |
| I-4 | Утечка через HTTP response (другой tenant) | Баг в query без org filter | Средняя | Критическая | Все queries: `WHERE organization_id = ? AND project_id = ?` (org первый) |
| I-5 | `master_key` читается unprivileged процессом | Shared hosting, container escape | Низкая | Критическая | chmod 600; хранить вне document root; монтировать как secret в production |
| I-6 | Vault name/category попадает в AI-контекст | Неявное включение в project summary | Средняя | Средняя | Разрешено: только имена/категории (не значения) могут быть reference для AI; документировать в AI policy |

### D — Denial of Service (Отказ в обслуживании)

| ID | Угроза | Вектор | Вероятность | Воздействие | Митигации |
|----|--------|--------|:-----------:|:-----------:|-----------|
| D-1 | Флуд `/reveal` endpoint (brute-force или enumeration) | Аутентифицированный пользователь | Средняя | Средняя | Rate limiting на `/reveal`: 10 req/min per user (реализовать в Phase 2); аномальный audit burst → alert |
| D-2 | Создание огромного числа vault записей | ProjectManager роль | Низкая | Низкая | Лимит записей на проект: 500 (configurable, реализовать в Phase 2) |

### E — Elevation of Privilege (Повышение привилегий)

| ID | Угроза | Вектор | Вероятность | Воздействие | Митигации |
|----|--------|--------|:-----------:|:-----------:|-----------|
| E-1 | Technician видит vault значения через direct DB query | Shared DB access | Очень низкая | Высокая | Значения всегда зашифрованы в БД; Technician не имеет DB file access в production |
| E-2 | Supervisor вызывает `/reveal` | RBAC bypass | Низкая | Высокая | `require_permission("vaultManage")` на `/reveal`; Supervisor имеет только `vaultList` |
| E-3 | ProjectManager читает vault другого проекта | IDOR (Insecure Direct Object Reference) | Средняя | Высокая | Query включает `project_id` из URL + проверка, что PM назначен на проект; org filter первый |
| E-4 | AI agent получает `vaultManage` через tool call | Prompt injection | Высокая | Критическая | `is_agent_session=True` → `vaultManage` permission заблокирован; агент не может вызвать `/reveal` |

---

## 4. Риски без митигаций (остаточные)

| ID | Описание | Приоритет | Рекомендация |
|----|----------|:---------:|-------------|
| RR-1 | Нет ротации `master_key` | HIGH | ADR-006: key rotation with re-encryption during maintenance window |
| RR-2 | HMAC-CTR — нестандартный AEAD | MEDIUM | ADR-006: мигрировать на AES-256-GCM |
| RR-3 | TOTP-секреты хранятся незашифрованными | HIGH | Phase 2: runtime re-encryption при старте приложения |
| RR-4 | Backup `master_key` — ответственность Operator | HIGH | Документировать в OPERATIONS.md; добавить startup check |
| RR-5 | Нет rate-limiting на `/reveal` в MVP | MEDIUM | Phase 2 implementation |

---

## 5. Правила AI-безопасности (AI Security Policy)

Следующие правила обязательны для всех агентов и инструментов:

```
VAULT_AI_RULES:
  1. Никакой vault value не передаётся в system prompt, user prompt или tool result.
  2. Vault entries идентифицируются только по placeholder: {{vault:entry_name}}.
  3. Endpoint /reveal недоступен agent-сессиям (is_agent_session=True → 403).
  4. Agent context builder фильтрует любые данные с source="project_vault".
  5. Если агент запрашивает vault value → respond с: "vault values are restricted from agent context".
  6. Audit event "agent.vault_attempt" логируется при каждой попытке агента обратиться к vault.
```

---

## 6. Данные для Penetration Test

Следующие сценарии должны быть покрыты pen-тестом перед production:

1. **Cross-tenant IDOR:** GET `/api/v1/projects/{proj_org_B}/vault` с token org A → 403.
2. **Agent reveal:** POST `/api/v1/projects/{id}/vault/{vid}/reveal` с `is_agent_session` token → 403.
3. **LAN-header bypass:** `X-RackPilot-Role: Administrator` без Bearer token → vault endpoints → 401.
4. **MAC tamper:** изменить один байт `encrypted_value` → GET значения → ошибка, не plaintext.
5. **Supervisor reveal:** Supervisor token → `/reveal` → 403 (недостаточно прав).
6. **Audit immutability:** после vault.reveal → попытка DELETE из audit_log → rejected by trigger.
