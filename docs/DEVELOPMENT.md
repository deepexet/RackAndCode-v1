# Development Guide — RackPilot

## Быстрый старт (новый стек)

### 1. Установка зависимостей

```bash
# Backend
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

# Frontend
cd ../frontend
npm install
```

### 2. Запуск в development

**Terminal 1 — Backend (FastAPI):**
```bash
cd backend
source .venv/bin/activate
PYTHONPATH=.. python run.py
# API доступен на http://localhost:4173
# Docs: http://localhost:4173/api/docs
```

**Terminal 2 — Frontend (Vite):**
```bash
cd frontend
npm run dev
# SPA на http://localhost:5173 (прокси /api → :4173)
```

### 3. Docker (рекомендуется для production)

```bash
# Сборка и запуск
docker-compose up --build

# Dev-режим (Vite + API в контейнерах)
docker-compose --profile dev up
```

## Устаревший стек (временно, для ссылки)

```bash
# Старый сервер (stdlib) — до полной миграции
HOST=0.0.0.0 PORT=4173 python3 server/app.py
```

## Добавление нового функционала

### Новый API endpoint

1. Создать или открыть `backend/app/routes/<domain>.py`
2. Добавить FastAPI роут:
```python
@router.get("/my-endpoint")
async def my_endpoint(ctx: Auth):
    return {"data": ctx.store.my_store_method(ctx.org)}
```
3. Добавить метод в `WorkspaceStore` (в `server/app.py`, Phase 1)
4. Написать SQL миграцию если нужна новая таблица: `server/migrations/NNN_description.sql`

### Новая страница (route)

1. Добавить `data-view="my-page"` секцию в `frontend/index.html` (пока используем legacy HTML)
2. Добавить ссылку в nav: `<a href="#my-page" data-route-link="my-page">My Page</a>`
3. Добавить маршрут в `backend/app/routes/__init__.py`
4. Создать `frontend/src/modules/my_page.js`:
```javascript
import { apiJSON } from '../core/api.js'

export async function mount() {
  const data = await apiJSON('/api/v1/my-page')
  render(data)
  return unmount
}

export function unmount() {}
```
5. Зарегистрировать в `frontend/src/main.js`:
```javascript
router.on('my-page', () => import('./modules/my_page.js').then(m => m.mount()))
```

### Новая миграция БД

```bash
# Следующий номер
ls server/migrations/ | sort | tail -1
# Создать файл
touch server/migrations/090_my_feature.sql
```

Требования к миграции:
- `CREATE TABLE IF NOT EXISTS` (идемпотентна)
- `CREATE INDEX IF NOT EXISTS`
- Никаких `DROP TABLE` / `ALTER TABLE` удаляющих данные
- Комментарий в начале файла

## Структура store методов

Все методы `WorkspaceStore` принимают `org: str` первым параметром.

```python
# Пример нового метода
def list_my_items(self, org: str, status: str | None = None) -> list[dict]:
    with self._connect() as conn:
        rows = conn.execute(
            "SELECT * FROM my_items WHERE organization_id=? " +
            ("AND status=?" if status else ""),
            [org] + ([status] if status else [])
        ).fetchall()
        return [dict(r) for r in rows]

def create_my_item(self, org: str, payload: dict, actor: str | None = None) -> dict:
    item_id = str(uuid.uuid4())
    now = utc_now()
    with self._connect() as conn:
        conn.execute(
            "INSERT INTO my_items (id, organization_id, ...) VALUES (?, ?, ...)",
            [item_id, org, ...]
        )
        self.audit(conn, org, "my_item.created", item_id, "my_items", actor=actor)
        return dict(conn.execute("SELECT * FROM my_items WHERE id=?", [item_id]).fetchone())
```

## Тестирование

```bash
# Unit tests (legacy)
python3 -m unittest discover -s tests -v

# FastAPI integration tests (coming)
cd backend
pytest tests/
```

## Переменные окружения

| Переменная | Default | Описание |
|---|---|---|
| `HOST` | `0.0.0.0` | Bind address |
| `PORT` | `4173` | Port |
| `DB_PATH` | `./data/fieldos.db` | SQLite file |
| `SESSION_SECRET` | — | Auth session signing key |
| `MASTER_KEY` | — | Secrets vault encryption key |
| `LAN_MODE` | `true` | Разрешить все CORS, X-RackPilot-Role header |
| `DEBUG` | `false` | Enable reload, verbose logging |
| `OPENAI_API_KEY` | — | OpenAI для AI features |
| `ANTHROPIC_API_KEY` | — | Anthropic для AI features |

Скопируй `.env.example` в `.env` и заполни нужные значения.
