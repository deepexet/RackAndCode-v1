# Technical Requirements Document

**Продукт:** RackPilot by Valeronix  
**Версия:** Draft 0.2  
**Статус:** Foundation baseline  
**Последнее обновление:** 2026-06-22

## 1. Назначение

RackPilot by Valeronix — AI-native операционная платформа для security, low-voltage и field service компаний. Она объединяет проекты, цифровой двойник, документацию, активы, персонал, время, мониторинг, аудит и корпоративные знания.

Ключевая продуктовая гипотеза: система понимает физический объект и историю работ в контексте, близком к пониманию техника, супервайзера и менеджера.

## 2. Границы первой поставки

### Входит

- Development Workspace с Kanban и иерархией Epic → Feature → Task → Subtask.
- Живой roadmap, метрики роста и журнал изменений.
- Документационный baseline, ADR и quality gates.
- Локальная автономная работа и экспорт состояния.

### Не входит

- Production identity, multi-tenancy и billing.
- Облачная синхронизация и мобильные приложения.
- Интеграции с Jobber и внешними системами.
- Управление реальными физическими устройствами.

## 3. Пользователи и роли

| Роль | Основные задачи | Ограничения |
|---|---|---|
| Technician | задачи, планы, активы, фото, чек-листы, offline | только назначенные проекты/объекты |
| Supervisor | команды, прогресс, время, блокировки | проекты своей области |
| Project Manager | сроки, риски, ресурсы, отчетность | портфель организации |
| Administrator | tenant, RBAC, интеграции, аудит | привилегированные операции с MFA |

Будущая production-модель авторизации MUST сочетать RBAC и контекстные ограничения (tenant/project/object).

## 4. Функциональные контексты

1. **Development Workspace** — разработка самой платформы.
2. **Project Management** — реальные клиентские проекты.
3. **Digital Twin** — Building → Floor → Room → Asset и граф связей.
4. **Documentation** — файлы, версии, привязки, извлечение знаний.
5. **Asset Management** — оборудование, конфигурации, service history.
6. **Time Tracking** — трудозатраты, загрузка и прогнозы.
7. **Monitoring** — сервисы, приложения, устройства и sync health.
8. **Audit** — неизменяемая история пользовательских, системных и AI-событий.
9. **AI Knowledge** — permission-aware retrieval и агентные workflows.
10. **Integrations** — изолированные опциональные коннекторы.

## 5. Нефункциональные требования

| Атрибут | Целевое состояние |
|---|---|
| Доступность | Tier-1 API: 99.9% monthly SLO после production launch |
| Целостность | tenant isolation, optimistic concurrency, idempotent writes |
| Offline | локальные команды, outbox, conflict policy, resumable sync |
| Производительность | p95 чтения API < 400 ms внутри региона без больших файлов |
| Масштабирование | stateless compute; partitioning по tenant/project |
| Аудит | корреляция actor/tenant/device/request/object и before/after |
| Безопасность | least privilege, MFA admin, encryption in transit/at rest |
| Восстановление | начальные цели RPO ≤ 15 min, RTO ≤ 60 min для Tier-1 |
| Переносимость | Web/PWA сначала; shared contracts для desktop/mobile |
| Доступность UI | WCAG 2.2 AA как quality gate |

## 6. Модель ключевых данных

Каждая business entity MUST иметь `id`, `tenant_id`, `version`, `created_at`, `updated_at`, `created_by`, `updated_by`. Удаление критичных сущностей — логическое с контролируемым retention.

Digital Twin хранится как нормализованные сущности и типизированные связи. Документы и медиа хранятся в object storage; метаданные, версии и ACL — в транзакционной БД.

Audit Event содержит timestamp, actor, tenant, project, device, action, object, before/after, source, correlation ID и context. Секреты и избыточные персональные данные в audit payload запрещены.

## 7. AI-требования

- Ответы MUST учитывать tenant/project permissions до retrieval.
- Каждое действие агента MUST быть трассируемым и иметь источник/основание.
- Изменяющие данные AI-действия MUST проходить policy gate; высокорисковые — human approval.
- Manual pin/priority/order MUST иметь больший вес, чем автоматическая рекомендация.
- Prompt/model/tool версии и метрики качества логируются без сохранения секретов.
- Local AI используется для маршрутизации, классификации и предварительной обработки; внешний LLM — через provider abstraction.

## 8. Acceptance criteria Foundation

- Локальная панель открывается одной командой без сборки.
- Пользователь создает, редактирует, перемещает и удаляет карточки.
- Состояние восстанавливается после перезагрузки страницы.
- Есть поиск, фильтры, метрики, roadmap, audit trail и JSON import/export.
- Интерфейс адаптируется к desktop/mobile и доступен с клавиатуры.
- Документация описывает архитектуру, безопасность, надежность и эксплуатацию.

## 9. Открытые решения

- Backend language/runtime и API style.
- Postgres-only graph representation или выделенный graph engine.
- CRDT против domain-specific conflict resolution.
- PWA + wrappers против отдельных native clients.
- Cloud topology и data residency regions.
