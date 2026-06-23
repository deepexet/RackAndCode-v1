# ADR-003: Organization как обязательная граница данных

- **Статус:** Accepted
- **Дата:** 2026-06-22
- **Владельцы:** Platform Architecture
- **Связанные задачи:** FS-015, FS-016, FS-017

## Контекст

RackPilot обслуживает несколько компаний. Проекты, цифровые двойники, документы, audit и AI retrieval не могут полагаться на фильтрацию только в UI.

## Решение

- Каждая workspace принадлежит `Organization`.
- Tenant context передается в `X-Organization-ID` и проверяется до data access.
- Workspace revisions и idempotency keys scoped составным ключом организации.
- Legacy данные атомарно мигрируются в `local-dev` tenant.
- Membership связывает user и organization с одной из ролей TRD.
- Authentication и fine-grained authorization добавляются следующими слоями, не смешиваясь с tenant storage boundary.

## Последствия

Data access API требует явного tenant context, а storage queries включают organization key. Локальный режим пока использует доверенный `local-dev` header; до внешнего deployment заголовок должен формироваться только authenticated gateway, а не приниматься как доказательство доступа.

## Проверка

Migration сохраняет существующую доску. Unit tests подтверждают, что workspace и одинаковые idempotency keys двух организаций изолированы.
