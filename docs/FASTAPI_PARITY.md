# FastAPI Parity Audit — RackPilot Migration

**Audit date:** 2026-06-29  
**Auditor:** Claude Code (read-only; no product code changed)  
**Branch:** `codex/claude-fastapi-audit`  
**Audited commit:** `8cf9d7f` — feat: migrate FastAPI logs and overview reads  
**Scope:** Legacy `server/app.py` (BaseHTTPRequestHandler) ↔ `backend/app/` (FastAPI)  
**Next action:** Codex review before any implementation

### Revision history

| Date | Commit | Change |
|------|--------|--------|
| 2026-06-29 | initial | First-pass audit |
| 2026-06-29 | `8cf9d7f` | Delta re-audit: corrected `/logs`, `/audit/integrity`, `/admin/audit-log`, `/overview/kpi`, `/critical-tasks`; updated §1.2 and §1.3 to reflect `require_permission` guard and Technician fallback role |

---

## Legend

| Symbol | Meaning |
|--------|---------|
| ✅ | Parity — functionally equivalent |
| ⚠️ | Partial — endpoint exists but response shape or logic differs |
| ❌ | Missing — no FastAPI equivalent exists |
| 🔒 | Auth gap — exists in FastAPI but lacks permission enforcement that legacy has |
| 🔗 | Import shim — FastAPI delegates back to a legacy module import |

**Priority:**
- **P0** — Security invariant broken; must fix before any production traffic is routed to FastAPI
- **P1** — Actively used feature, data loss or breakage risk for current users
- **P2** — Functional gaps that break UI flows
- **P3** — Admin/observability/edge-case gaps
- **P4** — Technical-debt cleanup; low user impact

---

## 1. Authentication & Tenant-Contract Gaps (P0)

These are structural issues that span every route. They must be resolved before the FastAPI stack handles real traffic.

### 1.1 `StoreOnly` bypasses session auth entirely

**File:** `backend/app/middleware/auth.py:80`

```python
StoreOnly = Annotated[WorkspaceStore, Depends(get_store)]
```

`StoreOnly` resolves only the store singleton — no token, no session, no org check. It is used in **all 18 standalone routes in `main.py`** (labels, webhooks, wi-templates, digest, time/log, knowledge, notifications, work-item dependencies, workspace). Any caller — including unauthenticated browsers — can reach these endpoints.

**Legacy behaviour:** Every route goes through `_start_request()` → `_require_organization()` which validates the session token from `Authorization` or cookie.

**Fix needed:** All `StoreOnly` routes in `main.py` must be converted to use `Auth` (or at minimum `get_session`).

---

### 1.2 Role-based permission checks (RBAC) — partial coverage

Commit `8cf9d7f` added `require_permission(ctx, permission)` to `backend/app/middleware/auth.py:83`. It imports `ROLE_POLICIES` and `role_can` from the legacy store, so it mirrors the exact same RBAC table. It **fails closed**: unauthenticated requests (no token, no LAN role-preview) receive 401; roles absent from `ROLE_POLICIES` or lacking the permission receive 403.

The guard is currently applied to **five endpoints** in `logs.py` and `overview.py` (see §2.16 and §2.2 corrections below). All other FastAPI routes — projects, inventory, wiki, assets, admin, AI, notifications, work-orders, tech, dev-agent — still call `Auth` without invoking `require_permission`, so RBAC is absent on those routes.

**Corrected claim:** `require_permission` now exists and is used, but is not yet applied to the bulk of the route surface. The original statement "zero permission checks outside coordinator routes" is stale.

The full permission vocabulary that still needs to be applied across the remaining routes:

| Permission | Used for |
|------------|---------|
| `projectRead` | All read-only project/asset/wiki/inventory routes |
| `projectManage` | Create/update/delete project entities, bulk ops |
| `adminPanel` | All `/admin/*` routes (settings, secrets, email, sessions…) |
| `secretsManage` | Secrets vault read + write |
| `logsRead` | Audit log and integrity check |
| `apiMonitor` | API metrics endpoint |
| `adminRead` | Overdue sweep |
| `agentContext` | Agent context export |
| `fieldProgress` | Time logging |
| `developmentWorkspace` | PUT workspace (legacy workspace sync) |

**Fix needed:** Introduce a `require_permission(permission_name)` FastAPI dependency that mirrors the legacy RBAC table and apply it to every route that has a permission gate in legacy.

---

### 1.3 `get_session` unauthenticated-path fallback — partially resolved

**⚠️ Partially corrected by commit `8cf9d7f`.**

The unauthenticated fallback role was changed from `"Administrator"` to `"Technician"` (`auth.py:54`). Additionally, the new `require_permission` guard explicitly rejects requests where `user_id` is `None` **and** the request is not a LAN dev-mode role preview (`role_preview=True` requires the `X-RackPilot-Role` header to be present in `lan_mode`).

This means: for any route that calls `require_permission`, an unauthenticated caller in LAN mode without the header now receives 401. The original Administrator-escalation vulnerability is closed **for those routes**.

**Remaining exposure:** Routes that use `Auth` but do not call `require_permission` still grant a `Technician`-role session context to tokenless callers in LAN mode. `Technician` can pass `role_can` checks for `projectRead`-gated routes when a future caller adds `require_permission` — but currently those routes don't call it, so the gate is simply absent. The fix in §A2/A3 (Block A tasks) remains necessary.

---

### 1.4 Dev-agent `X-Agent-Token` HMAC check missing

Legacy (`do_POST`, line 11106) validates `X-Agent-Token` against a server-level secret before accepting `POST /api/v1/development-agent/status`. The FastAPI route at `dev_agent.py:17` has no such check — any authenticated session can push status updates.

Similarly, `POST /api/v1/telemetry/nodes/:id` (legacy line 11114) requires `X-Agent-Token` and has **no FastAPI equivalent at all**.

**Fix needed:** Add `X-Agent-Token` HMAC validation to dev-agent status POST; add telemetry nodes endpoint.

---

### 1.5 `GET /api/v1/auth/me` — response shape mismatch

| | Legacy | FastAPI |
|-|--------|---------|
| Path | `/api/v1/auth/me` | `/api/v1/auth/me` |
| Response | `{user: {userId,role,…}, mfa: {enabled,…}}` | `{userId, role, org}` |

The legacy response bundles live MFA status in the same call. The new frontend may depend on the MFA field.

**Fix needed:** Confirm frontend expectation; either include `mfa` in FastAPI response or update the frontend to call `/auth/mfa/status` separately.

---

### 1.6 Secrets: legacy `list_secrets()` called without org param

`backend/app/routes/admin.py:119` calls `ctx.store.list_secrets(ctx.org)` (with org).  
Legacy `app.py:9412` calls `self.store.list_secrets()` (no org — returns all org secrets).  
Behaviour depends on whether the store method's org param is optional. If it defaults to returning all rows, the FastAPI version is actually more correct, but this needs explicit verification.

---

## 2. Migration Matrix

### 2.1 Auth (`/api/v1/auth`)

| Legacy | FastAPI | Status | Notes | Priority |
|--------|---------|--------|-------|---------|
| POST `/auth/login` | POST `/auth/login` | ✅ | | — |
| POST `/auth/dev-login` | POST `/auth/dev-login` | ✅ | LAN-mode guard present | — |
| POST `/auth/logout` | POST `/auth/logout` | ✅ | | — |
| GET `/auth/me` | GET `/auth/me` | ⚠️ | Response missing `mfa` field | P2 |
| GET `/auth/mfa/status` | GET `/auth/mfa/status` | ✅ | | — |
| POST `/auth/mfa/verify` | POST `/auth/mfa/verify` | ✅ | | — |
| POST `/auth/mfa/enroll` | POST `/auth/mfa/enroll` | ⚠️ | `email` field hardcoded to `""` in FastAPI | P2 |
| POST `/auth/mfa/confirm` | POST `/auth/mfa/confirm` | ✅ | | — |
| POST `/auth/mfa/disable` | POST `/auth/mfa/disable` | ✅ | | — |
| GET `/organizations` | — | ❌ | Legacy: no auth required; lists all orgs | P3 |
| GET `/health` or `/api/health` | — | ❌ | Health-check endpoint | P2 |

---

### 2.2 Projects (`/api/v1/projects`)

| Legacy | FastAPI | Status | Notes | Priority |
|--------|---------|--------|-------|---------|
| GET `/projects` | GET `/projects` | 🔒 | Exists; no RBAC (`projectRead`) | P0 |
| POST `/projects` | POST `/projects` | 🔒 | Exists; no RBAC (`projectManage`) | P0 |
| GET `/projects/sla-report` | GET `/projects/sla-report` | 🔒 | No RBAC | P0 |
| GET `/projects/:id` | GET `/projects/:id` | 🔒 | No RBAC | P0 |
| POST `/projects/:id` | POST `/projects/:id` | 🔒 | No RBAC | P0 |
| GET `/projects/:id/work-items` | GET `/projects/:id/work-items` | 🔒 | No RBAC | P0 |
| POST `/projects/:id/work-items` | POST `/projects/:id/work-items` | 🔒 | No RBAC | P0 |
| POST `/projects/:id/work-items/:wi_id` | POST `/projects/:id/work-items/:wi_id` | 🔒 | No RBAC | P0 |
| GET `/projects/:id/milestones` | GET `/projects/:id/milestones` | 🔒 | No RBAC | P0 |
| POST `/projects/:id/milestones` | POST `/projects/:id/milestones` | 🔒 | No RBAC | P0 |
| POST `/projects/:id/milestones/:mid` | POST `/projects/:id/milestones/:mid` | 🔒 | No RBAC | P0 |
| GET `/projects/:id/budget` | GET `/projects/:id/budget` | 🔒 | No RBAC | P0 |
| POST `/projects/:id/budget` | POST `/projects/:id/budget` | 🔒 | No RBAC | P0 |
| GET `/projects/:id/budget/forecast` | GET `/projects/:id/budget/forecast` | 🔒 | No RBAC | P0 |
| POST `/projects/:id/budget/expense` | POST `/projects/:id/budget/expense` | 🔒 | No RBAC | P0 |
| GET `/projects/:id/risks` | GET `/projects/:id/risks` | 🔒 | No RBAC | P0 |
| POST `/projects/:id/risks` | POST `/projects/:id/risks` | 🔒 | No RBAC | P0 |
| POST `/projects/:id/risks/:rid` | POST `/projects/:id/risks/:rid` | 🔒 | No RBAC | P0 |
| POST `/projects/:id/risks/:rid/delete` | POST `/projects/:id/risks/:rid/delete` | 🔒 | No RBAC | P0 |
| GET `/projects/:id/activity` | GET `/projects/:id/activity` | ⚠️ | `ctx: Auth = None` default is a bug; param ordering issues | P1 |
| GET `/projects/:id/standup` | GET `/projects/:id/standup` | 🔒 | No RBAC | P0 |
| GET `/projects/:id/comments` | GET `/projects/:id/comments` | 🔒 | No RBAC | P0 |
| POST `/projects/:id/comments` | POST `/projects/:id/comments` | 🔒 | No RBAC | P0 |
| DELETE `/projects/:id/comments/:cid` | — | ❌ | Legacy uses DELETE method; FastAPI has no delete comment | P2 |
| GET `/projects/:id/twin` | GET `/projects/:id/twin` | 🔒 | No RBAC | P0 |
| GET `/projects/:id/locations` | GET `/projects/:id/locations` | 🔒 | No RBAC | P0 |
| POST `/projects/:id/locations` | POST `/projects/:id/locations` | 🔒 | No RBAC | P0 |
| GET `/projects/:id/daily-report` | — | ❌ | Field report generation | P2 |
| GET `/projects/:id/objects` | — | ❌ | Object storage; search+list | P2 |
| GET `/projects/:id/progress-history` | — | ❌ | Progress chart data | P2 |
| GET `/projects/:id/report.csv` | — | ❌ | CSV export with streaming | P2 |
| GET `/projects/:id/analytics` | — | ❌ | Project analytics | P2 |
| GET `/projects/:id/presence` | — | ❌ | Team presence calendar | P2 |
| POST `/projects/:id/presence` | — | ❌ | | P2 |
| GET `/projects/:id/team` | — | ❌ | Project team assignments | P1 |
| POST `/projects/:id/team` | — | ❌ | Assign member to project | P1 |
| POST `/projects/:id/team/:mid/remove` | — | ❌ | Remove assignment | P1 |
| POST `/projects/:id/work-items/bulk-status` | — | ❌ | Transition-validated bulk update | P1 |
| POST `/projects/:id/work-items/bulk-assign` | — | ❌ | Bulk assignee change | P1 |
| POST `/projects/:id/work-items/bulk-update` | — | ❌ | Multi-field bulk update | P1 |
| POST `/projects/:id/update` | POST `/projects/:id` | ⚠️ | Legacy uses `/update` suffix; FastAPI uses direct POST | P1 |

---

### 2.3 Work Items (standalone)

| Legacy | FastAPI | Status | Notes | Priority |
|--------|---------|--------|-------|---------|
| GET `/work-items/search` | — | ❌ | Cross-project full-text search | P1 |
| GET `/work-items/:id/dependencies` | GET `main.py:/work-items/:id/dependencies` | 🔒 | `StoreOnly` — no session auth | P0 |
| POST `/work-items/:id/dependencies/add` | POST `main.py:…/add` | 🔒 | `StoreOnly` | P0 |
| POST `/work-items/:id/dependencies/remove` | POST `main.py:…/remove` | 🔒 | `StoreOnly` | P0 |
| DELETE `/projects/:proj/work-items/:wi/dependencies` | — | ❌ | Legacy uses DELETE+query param for predecessor | P2 |

---

### 2.4 Assets (`/api/v1/assets`)

| Legacy | FastAPI | Status | Notes | Priority |
|--------|---------|--------|-------|---------|
| GET `/assets` | GET `/assets` | 🔒 | No RBAC | P0 |
| POST `/assets` | POST `/assets` | 🔒 | No RBAC | P0 |
| GET `/assets/:id` | GET `/assets/:id` | 🔒 | No RBAC | P0 |
| POST `/assets/:id` | POST `/assets/:id` | 🔒 | No RBAC | P0 |
| POST `/assets/:id/delete` | POST `/assets/:id/delete` | 🔒 | No RBAC | P0 |
| GET `/assets/:id/relationships` | GET `/assets/:id/relationships` | 🔒 | No RBAC | P0 |
| GET `/assets/:id/service` | GET `/assets/:id/service-events` | ⚠️ | URL suffix renamed: `service` → `service-events` | P1 |
| POST `/assets/:id/service` | POST `/assets/:id/service-events` | ⚠️ | URL suffix renamed | P1 |
| GET `/assets/:id/configs` | GET `/assets/:id/config-snapshots` | ⚠️ | URL suffix renamed: `configs` → `config-snapshots` | P1 |
| POST `/assets/:id/configs` | — | ❌ | Config snapshot create; FastAPI only has GET | P1 |
| GET `/assets/:id/label.svg` | — | ❌ | SVG label rendering | P3 |
| POST `/relationships` | — | ❌ | Create asset relationship | P2 |
| GET `/objects/:id/bindings` | — | ❌ | Object-document bindings | P2 |
| GET `/bindings/:type/:id` | — | ❌ | Bindings by target type/id | P2 |
| POST `/bindings` | — | ❌ | Create binding | P2 |
| POST `/bindings/:id/delete` | — | ❌ | Remove binding | P2 |

---

### 2.5 Inventory (`/api/v1/inventory`)

| Legacy | FastAPI | Status | Notes | Priority |
|--------|---------|--------|-------|---------|
| GET `/inventory/warehouses` | GET `/inventory/warehouses` | 🔒 | No RBAC | P0 |
| POST `/inventory/warehouses` | POST `/inventory/warehouses` | ⚠️ | Legacy: `adminPanel` perm; FastAPI: no RBAC | P0 |
| POST `/inventory/warehouses/:id/delete` | POST `/inventory/warehouses/:id/delete` | ⚠️ | Legacy: `adminPanel`; FastAPI: no RBAC | P0 |
| GET `/inventory/skus` | GET `/inventory/skus` | 🔒 | No RBAC | P0 |
| GET `/inventory/skus?q=` | GET `/inventory/skus` | ⚠️ | Legacy has `search_skus()` when `q` param present; FastAPI ignores `q` | P1 |
| POST `/inventory/skus` | POST `/inventory/skus` | 🔒 | No RBAC | P0 |
| POST `/inventory/skus/:id` | POST `/inventory/skus/:id` | 🔒 | No RBAC | P0 |
| POST `/inventory/skus/:id/delete` | POST `/inventory/skus/:id/delete` | 🔒 | No RBAC | P0 |
| POST `/inventory/skus/import-csv` | POST `/inventory/skus/import-csv` | ⚠️ | Legacy reads raw bytes; FastAPI expects `{csv: string}` | P2 |
| GET `/inventory/stock` | GET `/inventory/stock` | 🔒 | No RBAC | P0 |
| GET `/inventory/stock-settings` | GET `/inventory/stock-settings` | ⚠️ | FastAPI returns `{"settings": []}` stub (TODO) | P2 |
| POST `/inventory/stock-settings` | — | ❌ | Update per-SKU/warehouse min quantity + bin location | P2 |
| POST `/inventory/receive` | POST `/inventory/receive` | 🔒 | No RBAC | P0 |
| POST `/inventory/transfer` | POST `/inventory/transfer` | ⚠️ | Legacy passes `reference`, `note`, `recorded_by`; FastAPI drops these | P2 |
| GET `/inventory/movements` | GET `/inventory/movements` | 🔒 | No RBAC; legacy also accepts `type` filter param | P0 |
| GET `/inventory/movements-summary` | — | ❌ | Aggregated movement chart data by day | P2 |
| POST `/inventory/movements/batch` | POST `/inventory/movements/batch` | ⚠️ | FastAPI stub (`{"ok": True}` TODO) | P2 |
| GET `/inventory/suppliers` | GET `/inventory/suppliers` | ⚠️ | Legacy accepts `includeInactive` param; FastAPI ignores it | P2 |
| POST `/inventory/suppliers` | POST `/inventory/suppliers` | 🔒 | No RBAC | P0 |
| POST `/inventory/suppliers/:id` | POST `/inventory/suppliers/:id` | 🔒 | No RBAC | P0 |
| POST `/inventory/suppliers/:id/delete` | POST `/inventory/suppliers/:id/delete` | 🔒 | No RBAC | P0 |
| GET `/inventory/orders` | GET `/inventory/orders` | ⚠️ | Legacy `list_supplier_orders`; FastAPI `list_purchase_orders`; may differ | P2 |
| GET `/inventory/orders/:id` | — | ❌ | Get single order; only list in FastAPI | P2 |
| POST `/inventory/orders` | POST `/inventory/orders` | 🔒 | No RBAC | P0 |
| POST `/inventory/orders/:id/:action` | POST `/inventory/orders/:id/:action` | 🔒 | No RBAC | P0 |
| GET `/inventory/lots` | GET `/inventory/lots` | 🔒 | No RBAC | P0 |
| POST `/inventory/lots` | POST `/inventory/lots` | 🔒 | No RBAC | P0 |
| GET `/inventory/reservations` | GET `/inventory/reservations` | ⚠️ | Legacy also accepts `skuId` + `status` params; FastAPI only `projectId` | P2 |
| POST `/inventory/reservations` | POST `/inventory/reservations` | 🔒 | No RBAC | P0 |
| POST `/inventory/reservations/:id/release` | POST `/inventory/reservations/:id/release` | 🔒 | No RBAC | P0 |
| GET `/inventory/reorder-requests` | GET `/inventory/reorder-requests` | 🔒 | No RBAC | P0 |
| GET `/inventory/reorder-suggest` | GET `/inventory/reorder-suggest` | 🔒 | No RBAC | P0 |
| POST `/inventory/reorder-requests` | POST `/inventory/reorder-requests` | ⚠️ | Legacy passes `unit_cost`, `supplier_ref`; FastAPI drops these | P2 |
| POST `/inventory/reorder-requests/:id/fulfill` | POST `/inventory/reorder-requests/:id/fulfill` | 🔒 | No RBAC | P0 |
| GET `/inventory/cycle-counts` | GET `/inventory/cycle-counts` | 🔒 | No RBAC; FastAPI uses `list_reconciliations`, legacy uses same | P0 |
| GET `/inventory/cycle-counts/:id` | GET `/inventory/cycle-counts/:id` | 🔒 | No RBAC | P0 |
| POST `/inventory/cycle-counts` | POST `/inventory/cycle-counts` | 🔒 | No RBAC | P0 |
| POST `/inventory/cycle-counts/:id/lines` | POST `/inventory/cycle-counts/:id/lines` | 🔒 | No RBAC | P0 |
| POST `/inventory/cycle-counts/:id/commit` | POST `/inventory/cycle-counts/:id/commit` | ⚠️ | Legacy uses `complete_reconciliation`; FastAPI uses `commit_reconciliation` — verify same method | P1 |
| GET `/inventory/alerts` | GET `/inventory/alerts` | 🔒 | No RBAC | P0 |
| POST `/inventory/auto-reorder` | POST `/inventory/auto-reorder` | ⚠️ | Legacy `auto_reorder(org, wh)`; FastAPI `process_auto_reorder(org)` — warehouseId lost | P2 |
| GET `/inventory/valuation` | GET `/inventory/valuation` | 🔒 | No RBAC | P0 |
| GET `/inventory/demand-forecast` | GET `/inventory/demand-forecast` | 🔒 | No RBAC | P0 |
| GET `/inventory/supplier-performance` | GET `/inventory/supplier-performance` | 🔒 | No RBAC | P0 |
| GET `/inventory/pending` | GET `/inventory/pending` | 🔒 | No RBAC | P0 |
| POST `/inventory/pending/:id/approve` | POST `/inventory/pending/:id/approve` | ⚠️ | Legacy passes `approved_indices` for partial approval; FastAPI drops it | P2 |
| POST `/inventory/pending/:id/reject` | POST `/inventory/pending/:id/reject` | 🔒 | No RBAC | P0 |
| POST `/inventory/ai-parse` | POST `/inventory/ai-parse` | ⚠️ | Legacy calls `build_inventory_ai_prompt` then `create_inventory_pending_from_ai`; FastAPI calls a different overloaded store method | P1 |
| POST `/inventory/ai-photo` | — | ❌ | Vision AI photo analysis; multipart + base64 support | P2 |
| POST `/inventory/import-xlsx` | — | ❌ | XLSX import with binary upload | P2 |
| GET `/inventory/analytics` | — | ❌ | Category totals, top-moving SKUs, ABC analysis | P2 |
| GET `/inventory/skus/:id/cost-history` | — | ❌ | SKU unit cost history | P3 |
| GET `/inventory/skus/:id/label` | — | ❌ | Printable HTML label page | P3 |
| GET `/inventory/export` | — | ❌ | CSV inventory export (streaming) | P3 |
| POST `/inventory/reorder-config` | — | ❌ | Per-SKU reorder configuration | P2 |

---

### 2.6 Work Orders (`/api/v1/work-orders`)

| Legacy | FastAPI | Status | Notes | Priority |
|--------|---------|--------|-------|---------|
| GET `/work-orders` | GET `/work-orders` | 🔒 | No RBAC | P0 |
| POST `/work-orders` | POST `/work-orders` | ⚠️ | FastAPI drops `actor` param | P1 |
| POST `/work-orders/:id/update` | POST `/work-orders/:id/update` | ⚠️ | FastAPI drops `actor` param | P1 |

---

### 2.7 Wiki (`/api/v1/wiki`)

| Legacy | FastAPI | Status | Notes | Priority |
|--------|---------|--------|-------|---------|
| GET `/wiki` | GET `/wiki` | 🔒 | No RBAC | P0 |
| POST `/wiki` | POST `/wiki` | 🔒 | No RBAC | P0 |
| GET `/wiki/:id` | GET `/wiki/:id` | 🔒 | No RBAC | P0 |
| POST `/wiki/:id` | POST `/wiki/:id` | 🔒 | No RBAC | P0 |
| POST `/wiki/:id/delete` | POST `/wiki/:id/delete` | 🔒 | No RBAC | P0 |
| GET `/wiki/projects/:pid` | GET `/wiki/projects/:pid` | 🔒 | No RBAC | P0 |
| POST `/wiki/projects/:pid` | POST `/wiki/projects/:pid` | 🔒 | No RBAC | P0 |
| POST `/wiki/generate-diagram` | POST `/wiki/generate-diagram` | 🔒 | No RBAC | P0 |
| GET `/wiki/search` | — | ❌ | Full-text wiki search | P1 |
| GET `/wiki/analytics` | — | ❌ | View counts, ratings aggregated | P3 |
| GET `/wiki/attachments/:id` | — | ❌ | Binary file serving (Content-Disposition) | P1 |
| GET `/wiki/:id/attachments` | — | ❌ | List attachments for a page | P1 |
| POST `/wiki/attachments` | — | ❌ | Download + store attachment from URL | P1 |
| POST `/wiki/:id/attachments` | — | ❌ | Per-page attachment download | P1 |
| POST `/wiki/ai-lookup` | — | ❌ | AI field assistant with web search | P1 |
| POST `/wiki/:id/view` | — | ❌ | View tracking | P3 |
| POST `/wiki/:id/rate` | — | ❌ | Helpful/not-helpful rating | P3 |

---

### 2.8 Admin (`/api/v1/admin`)

| Legacy | FastAPI | Status | Notes | Priority |
|--------|---------|--------|-------|---------|
| GET `/admin/platform-settings` | GET `/admin/platform-settings` | 🔒 | No RBAC | P0 |
| POST `/admin/platform-settings` | POST `/admin/platform-settings` | 🔒 | No RBAC | P0 |
| GET `/admin/git-sync` | GET `/admin/git-sync` | 🔒 | No RBAC | P0 |
| POST `/admin/git-sync` | POST `/admin/git-sync` | 🔒 | No RBAC | P0 |
| GET `/admin/compute-nodes` | GET `/admin/compute-nodes` | 🔒 | No RBAC | P0 |
| POST `/admin/compute-nodes/:id/enabled` | POST `/admin/compute-nodes/:id/enabled` | 🔒 | No RBAC | P0 |
| GET `/admin/work-types` | GET `/admin/work-types` | 🔒 | No RBAC | P0 |
| POST `/admin/work-types` | POST `/admin/work-types` | 🔒 | No RBAC | P0 |
| GET `/admin/custom-fields` | GET `/admin/custom-fields` | 🔒 | No RBAC | P0 |
| POST `/admin/custom-fields` | POST `/admin/custom-fields` | 🔒 | No RBAC | P0 |
| GET `/admin/secrets` | GET `/admin/secrets` | ⚠️ | Legacy: `secretsManage` perm + no org; FastAPI: no perm + org param | P0 |
| POST `/admin/secrets` | POST `/admin/secrets` | 🔒 | No RBAC (`secretsManage`) | P0 |
| POST `/admin/secrets/:id` | POST `/admin/secrets/:id` | 🔒 | No RBAC | P0 |
| POST `/admin/secrets/:id/delete` | POST `/admin/secrets/:id/delete` | 🔒 | No RBAC | P0 |
| GET `/admin/secrets/:id/reveal` | GET `/admin/secrets/:id/value` | ⚠️ | URL suffix: `reveal` → `value`; legacy requires `secretsManage` | P0 |
| GET `/admin/feature-docs` | GET `/admin/feature-docs` | ⚠️ | Legacy: `{"features": …}`; FastAPI: `{"featureDocs": …}` key rename | P2 |
| POST `/admin/feature-docs/save` | POST `/admin/feature-docs/save` | ⚠️ | Legacy body: `{taskId, content}`; FastAPI: `{featureId, guide}` — key rename | P2 |
| POST `/admin/feature-docs/generate` | — | ❌ | AI-generated feature doc from task | P3 |
| GET `/admin/ai-gateway/providers` | GET `/admin/ai-gateway/providers` | 🔒 | No RBAC | P0 |
| POST `/admin/ai-gateway/providers` | POST `/admin/ai-gateway/providers` | 🔒 | No RBAC | P0 |
| POST `/admin/ai-gateway/providers/:id/delete` | POST `/admin/ai-gateway/providers/:id/delete` | 🔒 | No RBAC | P0 |
| GET `/admin/ai-gateway/usage` | GET `/admin/ai-gateway/usage` | 🔒 | No RBAC | P0 |
| GET `/admin/email-inboxes` | GET `/admin/email-inboxes` | 🔒 | No RBAC | P0 |
| POST `/admin/email-inboxes` | POST `/admin/email-inboxes` | 🔒 | No RBAC | P0 |
| POST `/admin/email-inboxes/:id/delete` | POST `/admin/email-inboxes/:id/delete` | 🔒 | No RBAC | P0 |
| POST `/admin/email-inboxes/:id/poll` | POST `/admin/email-inboxes/:id/poll` | ⚠️ | Legacy passes AI gateway; FastAPI passes only raw email string | P2 |
| GET `/admin/email-inboxes/:id/log` | — | ❌ | Email processing log per inbox | P3 |
| GET `/admin/sessions` | GET `/admin/sessions` | 🔒 | No RBAC | P0 |
| POST `/admin/sessions/revoke` | POST `/admin/sessions/revoke` | 🔒 | No RBAC | P0 |
| GET `/admin/monitors` | GET `/admin/monitors` | 🔒 | No RBAC | P0 |
| POST `/admin/monitors` | POST `/admin/monitors` | 🔒 | No RBAC | P0 |
| POST `/admin/monitors/:id/delete` | POST `/admin/monitors/:id/delete` | 🔒 | No RBAC | P0 |
| GET `/admin/connectors` | GET `/admin/connectors` | 🔒 | No RBAC | P0 |
| POST `/admin/connectors` | POST `/admin/connectors` | 🔒 | No RBAC | P0 |
| GET `/admin/org-settings` | GET `/admin/org-settings` | 🔒 | No RBAC | P0 |
| POST `/admin/org-settings` | POST `/admin/org-settings` | 🔒 | No RBAC | P0 |
| GET `/admin/privacy` | GET `/admin/privacy` | 🔒 | No RBAC | P0 |
| POST `/admin/privacy/:key` | POST `/admin/privacy/:key` | ⚠️ | Legacy body: `{purpose, enabled, retention_days, redact_fields, notes}`; FastAPI: `{value}` only — reduced contract | P2 |
| GET `/admin/retrieval-eval` | GET `/admin/retrieval-eval` | ⚠️ | Legacy returns `{cases, runs}`; FastAPI returns `{"cases": []}` stub | P2 |
| GET `/admin/audit-log` | GET `/admin/audit-log` | ✅ | `require_permission(ctx, "adminPanel")` applied; limit capped at 500 (`8cf9d7f`) | — |
| GET `/admin/user-activity` | — | ❌ | Per-actor activity report | P3 |
| GET `/admin/ai-approvals` | — | ❌ | AI approval queue | P2 |
| GET `/admin/api-metrics` | — | ❌ | In-memory request metrics snapshot | P3 |
| GET `/admin/overdue-sweep` | — | ❌ | Auto-marks overdue work items | P3 |
| GET `/admin/system-stats` | GET `/admin/system-stats` | 🔒 | No RBAC | P0 |
| GET `/admin/platform-growth` | GET `/admin/platform-growth` | 🔗 | Imports `_build_platform_growth` from `server.app` | P3 |
| GET `/admin/runbooks` | GET `/admin/runbooks` | 🔗 | Imports `_RUNBOOKS` from `server.app` | P3 |
| GET `/admin/coordinator` | GET `/admin/coordinator` | ✅ | Has authenticated admin check | — |
| POST `/admin/coordinator/jobs` | POST `/admin/coordinator/jobs` | ✅ | Has authenticated admin check | — |
| POST `/admin/coordinator/jobs/:id/:action` | POST `/admin/coordinator/jobs/:id/:action` | ✅ | Has authenticated admin check | — |
| GET `/admin/team` | GET `/admin/team` | 🔒 | Also exposed as `/api/v1/team`; no RBAC | P0 |
| GET `/admin/digest` | GET `/admin/digest` | 🔒 | No RBAC | P0 |
| POST `/admin/digest/send-email` | POST `/admin/digest/send-email` | ⚠️ | FastAPI stub (`{"ok": True}` TODO) | P3 |
| GET `/admin/smtp-config` | GET `/admin/smtp-config` | 🔒 | No RBAC | P0 |
| POST `/admin/smtp-config` | POST `/admin/smtp-config` | 🔒 | No RBAC | P0 |

---

### 2.9 AI (`/api/v1/ai`)

| Legacy | FastAPI | Status | Notes | Priority |
|--------|---------|--------|-------|---------|
| GET `/ai/config` (via admin router in legacy) | GET `/ai/config` | 🔒 | No RBAC | P0 |
| GET `/ai/status` | GET `/ai/status` | 🔒 | No RBAC | P0 |
| POST `/ai/invoke` | POST `/ai/invoke` | 🔒 | No RBAC | P0 |
| POST `/ai/classify` | POST `/ai/classify` | 🔗 | Imports `classify` from `server.ai_router` | P3 |
| POST `/ai/parse-note` | POST `/ai/parse-note` | 🔒 | No RBAC | P0 |
| GET `/ai/log` | GET `/ai/log` | 🔒 | No RBAC | P0 |
| POST `/floorplan/analyze` | — | ❌ | Floor plan image AI analysis | P2 |

---

### 2.10 Notifications (`/api/v1/notifications`)

| Legacy | FastAPI | Status | Notes | Priority |
|--------|---------|--------|-------|---------|
| GET `/notifications` | GET `/notifications` + `main.py` duplicate | ⚠️ | `main.py` route uses `StoreOnly` (no auth); router route uses `Auth` — **two conflicting routes** | P0 |
| POST `/notifications/read` | POST + `main.py` duplicate | ⚠️ | Same duplication; `main.py` passes `notif_ids`; router passes `user_id` too | P0 |
| POST `/notifications/generate-alerts` | POST + `main.py` duplicate | ⚠️ | Same duplication | P0 |

---

### 2.11 Team & Labels (standalone, `main.py`)

| Legacy | FastAPI | Status | Notes | Priority |
|--------|---------|--------|-------|---------|
| GET `/team` | `main.py` + `/admin/team` | 🔒 | `main.py`: `StoreOnly` (no auth); `/admin/team`: `Auth` but no RBAC | P0 |
| GET `/team/skills` | `main.py` GET `/team/skills` | 🔒 | `StoreOnly` — no auth | P0 |
| GET `/team/:id` | — | ❌ | Single team member detail | P2 |
| POST `/team` | — | ❌ | Create team member | P1 |
| POST `/team/:id/delete` | — | ❌ | Delete team member | P1 |
| GET `/labels` | `main.py` GET `/labels` | 🔒 | `StoreOnly` — no auth | P0 |
| POST `/labels` | `main.py` POST `/labels` | 🔒 | `StoreOnly` — no auth | P0 |
| GET `/webhooks` | `main.py` GET `/webhooks` | 🔒 | `StoreOnly` — no auth | P0 |
| POST `/webhooks` | `main.py` POST `/webhooks` | 🔒 | `StoreOnly` — no auth | P0 |
| POST `/webhooks/:id/delete` | `main.py` POST `/webhooks/:id/delete` | 🔒 | `StoreOnly` — no auth | P0 |
| GET `/wi-templates` | `main.py` GET `/wi-templates` | 🔒 | `StoreOnly` — no auth | P0 |
| POST `/wi-templates` | `main.py` POST `/wi-templates` | 🔒 | `StoreOnly` — no auth | P0 |

---

### 2.12 Time Tracking (`/api/v1/time`)

| Legacy | FastAPI | Status | Notes | Priority |
|--------|---------|--------|-------|---------|
| GET `/time` | — | ❌ | List time sessions with member+project filters | P2 |
| GET `/time/utilization` | — | ❌ | Member utilization report | P2 |
| GET `/time/log` | `main.py` GET `/time/log` | 🔒 | `StoreOnly` — different store method than `/time`; signature mismatch | P0 |
| POST `/time/log` | `main.py` POST `/time/log` | ⚠️ | `StoreOnly`; legacy passes `memberId`, `projectId`, `durationMin`, `startedAt`, `notes`, `workTypeId`; FastAPI passes whole body blob | P0 |
| POST `/time/start` | — | ❌ | Start time session | P2 |
| POST `/time/:id/end` | — | ❌ | End time session | P2 |
| POST `/time/:id/approve` | — | ❌ | Approve time session | P2 |

---

### 2.13 Knowledge (`/api/v1/knowledge`)

| Legacy | FastAPI | Status | Notes | Priority |
|--------|---------|--------|-------|---------|
| GET `/knowledge/search` | — | ❌ | Full-text RAG search with user project scoping and RBAC | P1 |
| GET `/knowledge/log` | `main.py` GET `/knowledge/log` | 🔒 | `StoreOnly` — no auth; `limit` param wired | P0 |
| POST `/knowledge/rebuild` | `main.py` POST `/knowledge/rebuild` | 🔒 | `StoreOnly` — no auth | P0 |

---

### 2.14 Workspace (`/api/v1/workspace`)

| Legacy | FastAPI | Status | Notes | Priority |
|--------|---------|--------|-------|---------|
| GET `/workspace` | `main.py` GET `/workspace` | 🔒 | `StoreOnly`; ETag/304 logic present in FastAPI ✅ | P0 |
| POST `/workspace` | `main.py` POST `/workspace` | 🔒 | `StoreOnly` — no auth | P0 |
| PUT `/workspace` | — | ❌ | Full workspace save with idempotency-key support and revision conflict detection | P1 |

---

### 2.15 Digest & Schedules (`/api/v1/digest`)

| Legacy | FastAPI | Status | Notes | Priority |
|--------|---------|--------|-------|---------|
| GET `/digest/schedules` | `main.py` GET `/digest/schedules` | 🔒 | `StoreOnly` — no auth | P0 |
| POST `/digest/schedules` | `main.py` POST `/digest/schedules` | 🔒 | `StoreOnly` — no auth | P0 |
| POST `/digest/schedules/:id/delete` | `main.py` POST `/digest/schedules/:id/delete` | 🔒 | `StoreOnly` — no auth | P0 |

---

### 2.16 Misc & Observability

| Legacy | FastAPI | Status | Notes | Priority |
|--------|---------|--------|-------|---------|
| GET `/search` | — | ❌ | Global cross-entity full-text search | P1 |
| GET `/issues` | — | ❌ | Issue tracker (filtered by project/status/severity) | P2 |
| GET `/workload` | — | ❌ | Team workload summary | P2 |
| GET `/critical-tasks` | GET `/critical-tasks` | ✅ | `require_permission(ctx, "projectRead")` applied; parity with legacy (`8cf9d7f`) | — |
| GET `/overview/kpi` | GET `/overview/kpi` | ✅ | `require_permission(ctx, "projectRead")` applied; parity with legacy (`8cf9d7f`) | — |
| GET `/audit/integrity` | GET `/audit/integrity` | ✅ | `require_permission(ctx, "logsRead")` applied; accepts optional `projectId` param (`8cf9d7f`) | — |
| GET `/logs` | GET `/logs` | ✅ | `require_permission(ctx, "logsRead")` applied; all legacy filter params wired (`8cf9d7f`) | — |
| GET `/agent/context` | — | ❌ | Exports AI agent context JSON | P3 |
| POST `/telemetry/nodes/:id` | — | ❌ | Compute node heartbeat (X-Agent-Token required) | P2 |
| GET `/health` or `/api/health` | — | ❌ | Health check | P2 |

---

### 2.17 Dev Agent & Tech (`/api/v1/development-agent`, `/api/v1/tech`)

| Legacy | FastAPI | Status | Notes | Priority |
|--------|---------|--------|-------|---------|
| GET `/development-agent/status` | GET `/development-agent/status` | 🔒 | No RBAC | P0 |
| POST `/development-agent/status` | POST `/development-agent/status` | 🔒 | Legacy requires `X-Agent-Token` HMAC; FastAPI has none | P0 |
| POST `/development-agent/continue` | POST `/development-agent/request-continuation` | ⚠️ | URL suffix renamed: `continue` → `request-continuation` | P1 |
| GET `/tech/projects` | GET `/tech/projects` | 🔒 | No RBAC | P0 |
| GET `/tech/projects/:id/tasks` | GET `/tech/projects/:id/tasks` | 🔒 | No RBAC | P0 |
| POST `/tech/projects/:id/tasks/:tid/progress` | POST `/tech/projects/:id/tasks/:tid/progress` | 🔒 | No RBAC | P0 |
| POST `/tech/field-note` | POST `/tech/field-note` | 🔒 | No RBAC | P0 |

---

## 3. Obsolete / Cross-Module Import Shims

The following FastAPI files import directly from legacy modules. These are coupling points that will break when the legacy stack is retired:

| File | Import | Impact |
|------|--------|--------|
| `backend/app/routes/admin.py:311` | `from server.app import _RUNBOOKS` | Runbooks data hard-coupled to legacy process |
| `backend/app/routes/admin.py:332` | `from server.app import _build_platform_growth` | Growth stats hard-coupled to legacy |
| `backend/app/routes/ai.py:35` | `from server.ai_router import classify` | AI classify bypasses the store's AI router config |
| `backend/app/store/__init__.py` | `from server.app import WorkspaceStore` | Entire store is still the legacy monolith class |
| `backend/app/main.py:235` | `app.mount("/", StaticFiles(directory=_web_dir))` | Falls back to legacy `web/` frontend if `frontend/dist` absent |

**Dependency chain:** The FastAPI backend cannot run independently of `server/app.py` until the store is split (Phase 2) and these imports are removed.

---

## 4. Suggested Task Boundaries for Codex

Tasks are ordered by dependency; each block can be parallelised within it but depends on prior blocks.

### Block A — Security hardening (must ship before routing traffic to FastAPI)

| Task | Scope | Files | Status |
|------|-------|-------|--------|
| A1 | Replace all `StoreOnly` usages in `main.py` with `Auth` dependency | `backend/app/main.py` | Open |
| A2 | ~~Implement `require_permission` FastAPI dependency~~ | `backend/app/middleware/auth.py` | **Done** (`8cf9d7f`) |
| A3 | Apply `require_permission` to every remaining route (projects, inventory, wiki, assets, admin, AI, notifications, work-orders, tech, dev-agent) | All route files | Open |
| A4 | Add `X-Agent-Token` HMAC validation to dev-agent status POST | `backend/app/routes/dev_agent.py` | Open |
| A5 | Fix `GET /auth/me` response to include `mfa` status | `backend/app/routes/auth.py` | Open |
| A6 | Remove duplicate notification routes in `main.py` (keep router versions, delete shims) | `backend/app/main.py` | Open |

### Block B — Feature parity P1 (blocking for active users)

| Task | Scope | Files |
|------|-------|-------|
| B1 | Add team CRUD endpoints (GET `:id`, POST, DELETE `:id/delete`) | New routes or extend `admin.py` |
| B2 | Add project team assignment endpoints | `backend/app/routes/projects.py` |
| B3 | Add work-item bulk ops (bulk-status, bulk-assign, bulk-update) | `backend/app/routes/projects.py` |
| B4 | Add global search `GET /search` | New or existing router |
| ~~B5~~ | ~~Add `GET /overview/kpi` and `GET /critical-tasks`~~ | — | **Done** (`8cf9d7f`) |
| B6 | Add wiki search, attachments, AI-lookup, view tracking | `backend/app/routes/wiki.py` |
| B7 | Add knowledge search endpoint with user project scoping | `backend/app/routes/` |
| B8 | Add asset relationship create + object bindings | `backend/app/routes/assets.py` |
| B9 | Add `POST /assets/:id/configs` (config snapshot create) | `backend/app/routes/assets.py` |
| B10 | Align `/development-agent/continue` → `/request-continuation` URL or add alias | `backend/app/routes/dev_agent.py` |
| B11 | Add workspace PUT with idempotency-key + revision conflict handling | `backend/app/main.py` |

### Block C — Feature parity P2 (UI completeness)

| Task | Scope |
|------|-------|
| C1 | Time tracking endpoints (GET /time, GET /time/utilization, POST /time/start, POST /time/:id/end, approve) |
| C2 | Project sub-routes: daily-report, progress-history, analytics, presence, CSV export, objects |
| C3 | Inventory: movements-summary, analytics, skus search, stock-settings, reorder-config, orders/:id |
| C4 | Health check endpoint |
| C5 | Admin: user-activity, ai-approvals, overdue-sweep, email-inbox-log (`audit-log` completed in `8cf9d7f`) |
| C6 | Issues and workload endpoints (`critical-tasks` completed in `8cf9d7f`) |
| C7 | Align feature-docs key names and privacy body contract |
| C8 | Telemetry nodes endpoint with HMAC |

### Block D — Import shim removal (Phase 2 dependency)

These cannot be done until Phase 2 store split is complete:

| Task | Scope |
|------|-------|
| D1 | Move `_RUNBOOKS` data to FastAPI config or DB |
| D2 | Move `_build_platform_growth` to store method |
| D3 | Wire `classify` through store AI router |
| D4 | Split `WorkspaceStore` into domain stores per Phase 2 plan |

---

## 5. Evidence Index

| Finding | Location |
|---------|---------|
| `StoreOnly` bypasses auth | `backend/app/middleware/auth.py:80` |
| `require_permission` added (`8cf9d7f`) | `backend/app/middleware/auth.py:83-94` |
| `require_permission` used on logs+overview only | `backend/app/routes/logs.py:23,39,46`, `backend/app/routes/overview.py:16,71` |
| Unauthenticated fallback changed to `Technician` (`8cf9d7f`) | `backend/app/middleware/auth.py:54` |
| RBAC absent on projects/inventory/wiki/assets/admin routes | All route files except `logs.py`, `overview.py`, coordinator in `admin.py`; vs. `server/app.py:467` |
| Dev-agent X-Agent-Token check missing | `server/app.py:11106`, `backend/app/routes/dev_agent.py:17` |
| `/auth/me` response mismatch | `server/app.py:9354`, `backend/app/routes/auth.py:117` |
| MFA enroll email hardcoded to `""` | `backend/app/routes/auth.py:137` |
| Duplicate notification routes | `backend/app/main.py:162-177`, `backend/app/routes/notifications.py` |
| `_RUNBOOKS` import shim | `backend/app/routes/admin.py:311` |
| `_build_platform_growth` import shim | `backend/app/routes/admin.py:332` |
| `classify` import shim | `backend/app/routes/ai.py:35` |
| `WorkspaceStore` + `role_can` + `ROLE_POLICIES` from legacy | `backend/app/store/__init__.py:21` |
| Privacy body contract reduction | `server/app.py:11044`, `backend/app/routes/admin.py:276` |
| Feature-docs key rename | `server/app.py:9427` (`features`), `backend/app/routes/admin.py:151` (`featureDocs`) |
| Inventory pending approve: lost `approved_indices` | `server/app.py:11686`, `backend/app/routes/inventory.py:257` |
| Auto-reorder: lost `warehouseId` | `server/app.py:11862`, `backend/app/routes/inventory.py:231` |
| SKU search on `?q=`: not wired | `server/app.py:9927`, `backend/app/routes/inventory.py:29` |
| `ctx: Auth = None` bug in activity route | `backend/app/routes/projects.py:146` |

---

*Stop here — Codex review required before implementing any of the above.*
