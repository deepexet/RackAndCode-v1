# Mobile Web Baseline

FS-053 покрывает responsive Development Workspace и не заменяет future native Epic FS-044. По решению владельца FS-044 имеет Low Priority до готовности и проверки MVP/PWA workflow.

## Acceptance baseline

- Viewport 390×844 не создает global horizontal overflow.
- Header, hero, metrics и roadmap читаемы без zoom.
- Kanban использует touch-friendly horizontal snap; status filter может оставить одну колонку.
- Search и select controls имеют touch container не менее 44 px.
- Task dialog помещается в viewport, прокручивается независимо и сохраняет доступ к действиям.
- Form inputs и selects используют минимум 16 px на мобильном breakpoint, предотвращая Safari auto-zoom при фокусе.
- Task title — 16 px, description — 14 px; metadata и risk не меньше 10–12 px.
- Architecture nodes — 14 px, principles — 12 px; change stream events — 14 px и timestamps — 12 px.
- Offline cache и `/api/v1` sync работают с LAN-origin.
- Новые server revisions не могут быть стерты устаревшим полным browser snapshot; sync применяет только dirty task IDs и deletion tombstones поверх remote state.

## Проверено

Автоматизированный smoke test выполнен на 390×844: status filtering, FS-053 dialog, отсутствие global overflow и console errors. FS-054 добавляет mobile typography baseline по результату проверки на физическом устройстве. Финальный gate — повторная ручная проверка на iPhone и Android перед переводом задач в Done.
