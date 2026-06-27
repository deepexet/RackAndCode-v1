# Migration Plan: Monolith → Modular Stack

## Статус

| Phase | Статус | Описание |
|-------|--------|---------|
| Phase 0 | ✅ Done | Snapshot legacy codebase, push to git |
| Phase 1 | ✅ Done | FastAPI scaffold + route files, Vite setup, Docker |
| Phase 2 | 🔲 Todo | Extract WorkspaceStore into domain store files |
| Phase 3 | 🔲 Todo | Fill frontend modules from web/app.js |
| Phase 4 | 🔲 Todo | Remove legacy server/ и web/ |
| Phase 5 | 🔲 Todo | Production hardening (rate limiting, metrics, CI/CD) |

## Phase 2: Store split plan

WorkspaceStore (~8000 lines) разбивается на domain-specific mixin классы.
Финальный Store = StoreBase + все domain mixins через множественное наследование.

```python
# backend/app/store/base.py
class StoreBase:
    def __init__(self, db_path: str): ...
    def _connect(self): ...

# backend/app/store/projects.py
class ProjectStoreMixin(StoreBase):
    def list_projects(self, org): ...
    def create_project(self, org, payload, actor=None): ...
    ...

# backend/app/store/__init__.py (Phase 2)
from .base import StoreBase
from .auth import AuthStoreMixin
from .projects import ProjectStoreMixin
from .inventory import InventoryStoreMixin
from .assets import AssetStoreMixin
from .admin import AdminStoreMixin
from .notifications import NotificationStoreMixin

class Store(
    AuthStoreMixin,
    ProjectStoreMixin,
    InventoryStoreMixin,
    AssetStoreMixin,
    AdminStoreMixin,
    NotificationStoreMixin,
    StoreBase,
): pass
```

### Порядок извлечения (по приоритету)

1. `store/auth.py` — Users, sessions, MFA (строки ~2199–2284, 8361–8479)
2. `store/projects.py` — Projects, work items, milestones (строки ~917–2051)
3. `store/inventory.py` — Warehouses, SKUs, stock, suppliers (строки ~4195–5517)
4. `store/assets.py` — Assets, relationships, digital twin (строки ~7905–8142)
5. `store/admin.py` — Platform settings, compute nodes, AI gateway (строки ~639–744)
6. `store/notifications.py` — Notifications, alerts (строки ~7107–7143)

## Phase 3: Frontend modules

Наполнить заготовки `frontend/src/modules/*.js` логикой из `web/app.js`:

| Модуль | Функции из app.js |
|--------|-------------------|
| `overview.js` | `hydrateOverviewKpi`, `hydrateOverviewSla`, `hydrateGrowthChart` |
| `projects.js` | `hydrateProjects`, `renderProjectDetail`, `hydrateMilestones`, `hydrateRisks` |
| `inventory.js` | `hydrateInventory`, `hydrateWarehouses`, `hydrateSKUs` |
| `work_orders.js` | `hydrateWorkOrders` |
| `tech.js` | `hydrateTechView`, `hydrateTechHome`, `hydrateTechTasks` |
| `admin.js` | `hydrateComputeNodes`, `hydrateSecretsVault`, `hydrateAIGateway`, ... |
| `logs.js` | `hydrateLogs` |
| `api_metrics.js` | `hydrateApiMetrics` |

## Rollback план

До Phase 4 legacy код остаётся нетронутым.
При необходимости откатиться: `python3 server/app.py` продолжает работать.
