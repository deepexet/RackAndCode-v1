# RBAC Permission Matrix — Project Information Vault

**Версия:** 1.0  
**Дата:** 2026-06-30  
**Связан с:** ADR-005, Threat Model

---

## 1. Роли и новые разрешения

Две новые permission добавляются в `ROLE_POLICIES` (`server/app.py`):

| Permission | Описание |
|-----------|----------|
| `vaultList` | Видеть список записей vault (имя, категория, метаданные). Значения **не** раскрываются. |
| `vaultManage` | Создавать, читать значение (`/reveal`), обновлять и мягко удалять записи vault. |
| `vaultAudit` | Читать журнал доступа к vault (`audit_log` с action prefix `vault.*`). |
| `secretsManage` | Уже существует. Управление org-level `secrets_vault`. Только Administrator. |

`vaultManage` и `secretsManage` добавляются в `SESSION_REQUIRED_PERMISSIONS` — LAN-mode header их **не** разблокирует.

---

## 2. Матрица разрешений по ролям

| Действие | Endpoint | Требуемое разрешение | Technician | Supervisor | ProjectManager | Administrator |
|----------|----------|---------------------|:----------:|:----------:|:--------------:|:-------------:|
| Список записей vault (имена/категории) | `GET /vault` | `vaultList` | ✗ | ✓ | ✓ | ✓ |
| Метаданные записи (без значения) | `GET /vault/{id}` | `vaultList` | ✗ | ✓ | ✓ | ✓ |
| Создать запись | `POST /vault` | `vaultManage` | ✗ | ✗ | ✓ | ✓ |
| Получить расшифрованное значение | `POST /vault/{id}/reveal` | `vaultManage` | ✗ | ✗ | ✓* | ✓ |
| Обновить запись | `POST /vault/{id}` | `vaultManage` | ✗ | ✗ | ✓* | ✓ |
| Мягкое удаление | `POST /vault/{id}/delete` | `vaultManage` | ✗ | ✗ | ✓* | ✓ |
| История версий записи | `GET /vault/{id}/history` | `vaultManage` | ✗ | ✗ | ✓* | ✓ |
| Журнал доступа к vault | `GET /vault/audit` | `vaultAudit` | ✗ | ✗ | ✗ | ✓ |
| Org-level secrets (secrets_vault) | `/admin/secrets/*` | `secretsManage` | ✗ | ✗ | ✗ | ✓ |

`*` — ProjectManager дополнительно ограничен: только записи проектов, к которым он назначен (`project_assignments`).

---

## 3. Дополнительные ограничения (beyond RBAC)

### 3.1 AI-агент всегда исключён

Независимо от роли, если `ctx.is_agent_session = True`:

| Endpoint | Результат |
|----------|-----------|
| `GET /vault` | 403 — vault listing запрещён агентам |
| `POST /vault/{id}/reveal` | 403 — значения запрещены агентам |
| Все остальные vault endpoints | 403 |

Агенты могут получить только placeholder-ссылку `{{vault:entry_name}}` через явно разрешённый tool.

### 3.2 Session required (не dev-header)

`vaultManage` и `secretsManage` входят в `SESSION_REQUIRED_PERMISSIONS`. Запросы без валидного Bearer-токена или cookie `rp_session`:
- Возвращают **401**, даже если `LAN_MODE=True`.
- `X-RackPilot-Role` header полностью игнорируется для этих endpoints.

### 3.3 Project assignment check (ProjectManager)

ProjectManager видит и управляет только vault записями проектов из своей `project_assignments`:

```sql
SELECT pv.*
FROM project_vault pv
JOIN project_assignments pa
    ON pa.organization_id = pv.organization_id
    AND pa.project_id = pv.project_id
    AND pa.member_id = :user_id
WHERE pv.organization_id = :org_id
  AND pv.project_id = :project_id
  AND pv.deleted_at IS NULL;
```

Administrator обходит этот join — видит все проекты org.

### 3.4 Audit на каждый reveal

Каждый вызов `/reveal` — независимо от успеха — создаёт запись в `audit_log`:

```python
self.audit(
    conn, org,
    actor_id=ctx.user_id,
    actor_role=ctx.role,
    action="vault.reveal",
    target_type="project_vault",
    target_id=entry_id,
    outcome="ok" | "denied" | "error",
    ip=request.client.host,
)
```

---

## 4. Изменения в коде (не миграции)

Следующие code-изменения требуются в **Phase 2** (после Codex review ADR-005):

### `server/app.py` — ROLE_POLICIES

```python
ROLE_POLICIES = {
    "Technician":     frozenset({
        "projectRead", "fieldProgress",
    }),
    "Supervisor":     frozenset({
        "projectRead", "fieldProgress", "projectManage", "logsRead",
        "vaultList",                          # NEW
    }),
    "ProjectManager": frozenset({
        "projectRead", "fieldProgress", "projectManage", "logsRead",
        "developmentWorkspace",
        "vaultList", "vaultManage",           # NEW
    }),
    "Administrator":  frozenset({
        "projectRead", "fieldProgress", "projectManage", "logsRead",
        "apiMonitor", "adminPanel", "developmentWorkspace",
        "secretsManage", "agentContext",
        "vaultList", "vaultManage", "vaultAudit",  # NEW
    }),
}

SESSION_REQUIRED_PERMISSIONS = frozenset({
    "secretsManage", "agentContext",
    "vaultManage",   # NEW — no LAN-header bypass
})
```

### `backend/app/middleware/auth.py` — agent session flag

```python
@dataclass
class SessionContext:
    org: str
    user_id: str | None
    role: str
    token: str | None
    store: Any
    role_preview: bool = False
    is_agent_session: bool = False   # NEW — set True for agent-initiated requests
```

### `backend/app/routes/projects.py` (new vault sub-router)

```python
@router.post("/{project_id}/vault/{entry_id}/reveal")
async def reveal_vault_entry(project_id: str, entry_id: str, ctx: Auth):
    if ctx.is_agent_session:
        raise HTTPException(403, "vault reveal unavailable in agent context")
    require_permission(ctx, "vaultManage")
    # ... decrypt + audit
```

---

## 5. Матрица threat ↔ mitigation

Перекрёстная ссылка с threat model:

| Threat ID | Mitigation в permission matrix |
|-----------|-------------------------------|
| S-2 | `SESSION_REQUIRED_PERMISSIONS` включает `vaultManage` |
| S-3 | `is_agent_session` guard на `/reveal` |
| E-2 | Supervisor: только `vaultList`, нет `vaultManage` |
| E-3 | ProjectManager: project_assignments join check |
| E-4 | `is_agent_session=True` → все vault writes/reveal отклонены |
| I-1 | Agent context builder: source=project_vault отфильтрован |
