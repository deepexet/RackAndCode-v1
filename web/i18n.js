/**
 * Minimal i18n for RackPilot — no external deps.
 * Default locale: 'en'. Switch via setLang('ru').
 * Keys follow SCREAMING_SNAKE for structural UI; dot-path for compound labels.
 */

const LANG_KEY = 'rackpilot.lang.v1';

const EN = {
  // Navigation
  NAV_OVERVIEW: 'Overview',
  NAV_PROJECTS: 'Projects',
  NAV_LOGS: 'Logs',
  NAV_API: 'API',
  NAV_ADMIN: 'Admin',
  NAV_TECH: 'Field',

  // Header actions
  HDR_EXPORT_WS: '⬇ Workspace',
  HDR_IMPORT_WS: '⬆ Workspace',
  HDR_NEW_TASK: '＋ New task',
  HDR_LOGOUT: '⏻',

  // Overview
  OVERVIEW_EYEBROW: 'PLATFORM OVERVIEW',
  OVERVIEW_TITLE: 'RackPilot Platform',
  OVERVIEW_SUBTITLE: 'AI-native field operations — projects, assets, team, knowledge.',
  OVERVIEW_KPI_PROJECTS: 'Active projects',
  OVERVIEW_KPI_TASKS: 'Open tasks',
  OVERVIEW_KPI_MEMBERS: 'Team members',
  OVERVIEW_KPI_UPDATED: 'Updated today',

  // Project section
  PROJ_EYEBROW: 'PROJECT PORTFOLIO',
  PROJ_TITLE: 'Projects',
  PROJ_NEW: '＋ New project',
  PROJ_EMPTY: 'No projects yet. Create the first one.',
  PROJ_DETAIL_BACK: '← All projects',
  PROJ_PROGRESS: 'Overall progress',
  PROJ_TODAY: 'Updated today',
  PROJ_ISSUES: 'Open issues',
  PROJ_LOCATIONS: 'Locations',
  PROJ_ADD_LOCATION: '＋ Floor / zone',
  PROJ_DAILY_BTN: '＋ Daily report',
  PROJ_EXPORT: '⬇ Export',
  PROJ_IMPORT: '⬆ Import',

  // Location panel
  LOC_EYEBROW: 'LOCATIONS',
  LOC_TITLE: 'Site structure',
  LOC_ADD: 'Add',
  LOC_TOGGLE_BUILDINGS: '🏢 Buildings',
  LOC_TOGGLE_LIST: '≡ List',
  LOC_EMPTY: 'Add floors or zones so field staff can log progress.',

  // Work progress
  SCOPE_EYEBROW: 'WORK PROGRESS',
  SCOPE_TITLE: 'Progress by work type',

  // Issues panel
  ISSUES_EYEBROW: 'ISSUES',
  ISSUES_TITLE: 'Open issues',
  ISSUES_EMPTY: 'No open issues.',

  // Daily log
  DAILY_EYEBROW: 'DAILY LOG · AUTO',
  DAILY_TITLE: 'Recent changes',
  DAILY_ADD: '＋ Add note',
  DAILY_EMPTY: 'Project changes will appear here automatically.',
  DAILY_EDIT: 'Edit',
  DAILY_AUTO: 'AUTO',

  // Team section
  TEAM_EYEBROW: 'TEAM',
  TEAM_TITLE: 'Assigned members',
  TEAM_ASSIGN: '＋ Assign',
  TEAM_LOADING: 'Loading…',

  // Documents section
  DOCS_EYEBROW: 'DOCUMENTS',
  DOCS_TITLE: 'Project files',
  DOCS_UPLOAD: '＋ Upload',
  DOCS_SEARCH: 'Search files…',
  DOCS_DROP: 'Drop files here or click Upload',
  DOCS_LOADING: 'Loading…',

  // Digital Twin
  DT_EYEBROW: 'DIGITAL TWIN',
  DT_TITLE: 'Asset registry',
  DT_ADD: '＋ Asset',
  DT_TAB_LIST: 'List',
  DT_TAB_GRAPH: 'Graph',
  DT_EMPTY: 'No assets. Add equipment to start tracking.',

  // Logs
  LOGS_EYEBROW: 'AUDIT LOG',
  LOGS_TITLE: 'System events',
  LOGS_SEARCH: 'Search events…',
  LOGS_REFRESH: '↺ Refresh',
  LOGS_EXPORT: '⬇ Export CSV',

  // Admin
  ADMIN_EYEBROW: 'ADMIN',
  ADMIN_TITLE: 'Administration',

  // AI Gateway
  AI_EYEBROW: 'AI ROUTER',
  AI_TITLE: 'Provider & usage',
  AI_DESC: 'Single entry point for all AI requests. Key read from env — never stored in DB.',
  AI_PROVIDER: 'Provider',
  AI_MODEL: 'Model',
  AI_ENV_KEY: 'API key env var',
  AI_MAX_TOKENS: 'Max tokens',
  AI_ENABLED: 'Enabled',
  AI_SAVE: 'Save',
  AI_TEST_EYEBROW: 'TEST PROMPT',
  AI_TEST_PLACEHOLDER: 'Enter a test prompt…',
  AI_CLASSIFY: '🏷 Classify',
  AI_INVOKE: '▶ Invoke',
  AI_LOG_EYEBROW: 'INVOCATION LOG',
  AI_LOG_LOAD: 'Load log',
  AI_STATUS_OK: '● Available',
  AI_STATUS_NO_KEY: '● No key',
  AI_STATUS_OFF: '● Disabled',
  AI_STATUS_ERR: '● Error',

  // Knowledge search
  KS_EYEBROW: 'KNOWLEDGE BASE',
  KS_TITLE: 'AI document search',
  KS_PLACEHOLDER: 'Search across all project documents…',
  KS_SEARCH: 'Search',
  KS_REBUILD: '↺ Rebuild index',
  KS_LOG_EYEBROW: 'SEARCH AUDIT LOG',
  KS_LOG_LOAD: 'Load log',

  // Time tracking
  TT_EYEBROW: 'TIME TRACKING',
  TT_TITLE: 'Member utilization',
  TT_LOG: '＋ Log time',
  TT_LOAD: 'Load sessions',

  // Conflict queue
  CQ_EYEBROW: 'CONFLICT QUEUE',
  CQ_TITLE: 'Sync conflicts',
  CQ_EMPTY: 'No conflicts.',

  // Misc
  BTN_CANCEL: 'Cancel',
  BTN_SAVE: 'Save',
  BTN_DELETE: 'Delete',
  BTN_CONFIRM: 'Confirm',
  BTN_CLOSE: 'Close',
  BTN_LOADING: 'Loading…',
  LBL_OR: 'or',
  LBL_LOADING: 'Loading…',
  ROLE_LABEL: 'Role',

  // Import/export dialogs
  IMPORT_TITLE: 'Import preview',
  IMPORT_EYEBROW: 'PROJECT IMPORT',
  IMPORT_NOTE: 'Existing records with matching IDs will be skipped (INSERT OR IGNORE).',
  IMPORT_CONFIRM: 'Import',

  // Status labels
  STATUS_ACTIVE: 'active',
  STATUS_DONE: 'done',
  STATUS_BLOCKED: 'blocked',

  SAVE_STATE_OK: 'Saved locally',
  SAVE_STATE_SAVING: 'Saving…',
};

const RU = {
  NAV_OVERVIEW: 'Обзор',
  NAV_PROJECTS: 'Проекты',
  NAV_LOGS: 'Журнал',
  NAV_API: 'API',
  NAV_ADMIN: 'Панель',
  NAV_TECH: 'ТК',

  HDR_EXPORT_WS: '⬇ Workspace',
  HDR_IMPORT_WS: '⬆ Workspace',
  HDR_NEW_TASK: '＋ Новая задача',
  HDR_LOGOUT: '⏻',

  OVERVIEW_EYEBROW: 'ОБЗОР ПЛАТФОРМЫ',
  OVERVIEW_TITLE: 'RackPilot Platform',
  OVERVIEW_SUBTITLE: 'AI-native полевые операции — проекты, активы, команда, знания.',
  OVERVIEW_KPI_PROJECTS: 'Активных проектов',
  OVERVIEW_KPI_TASKS: 'Открытых задач',
  OVERVIEW_KPI_MEMBERS: 'Участников',
  OVERVIEW_KPI_UPDATED: 'Обновлено сегодня',

  PROJ_EYEBROW: 'ПОРТФЕЛЬ ПРОЕКТОВ',
  PROJ_TITLE: 'Проекты',
  PROJ_NEW: '＋ Новый проект',
  PROJ_EMPTY: 'Проектов нет. Создайте первый.',
  PROJ_DETAIL_BACK: '← Все проекты',
  PROJ_PROGRESS: 'Общий прогресс',
  PROJ_TODAY: 'Сегодня обновлено',
  PROJ_ISSUES: 'Открытые проблемы',
  PROJ_LOCATIONS: 'Локации',
  PROJ_ADD_LOCATION: '＋ Этаж / зона',
  PROJ_DAILY_BTN: '＋ Отчет за сегодня',
  PROJ_EXPORT: '⬇ Экспорт',
  PROJ_IMPORT: '⬆ Импорт',

  LOC_EYEBROW: 'LOCATIONS',
  LOC_TITLE: 'Структура объекта',
  LOC_ADD: 'Добавить',
  LOC_TOGGLE_BUILDINGS: '🏢 Здания',
  LOC_TOGGLE_LIST: '≡ Список',
  LOC_EMPTY: 'Добавьте этажи или зоны, чтобы техник мог фиксировать прогресс.',

  SCOPE_EYEBROW: 'WORK PROGRESS',
  SCOPE_TITLE: 'Прогресс по видам работ',

  ISSUES_EYEBROW: 'ISSUES',
  ISSUES_TITLE: 'Проблемы',
  ISSUES_EMPTY: 'Открытых проблем нет.',

  DAILY_EYEBROW: 'DAILY LOG · AUTO',
  DAILY_TITLE: 'Последние изменения',
  DAILY_ADD: '＋ Добавить пояснение',
  DAILY_EMPTY: 'Изменения проекта автоматически появятся здесь.',
  DAILY_EDIT: 'Редактировать',
  DAILY_AUTO: 'AUTO',

  TEAM_EYEBROW: 'КОМАНДА',
  TEAM_TITLE: 'Назначенные сотрудники',
  TEAM_ASSIGN: '＋ Назначить',
  TEAM_LOADING: 'Загрузка…',

  DOCS_EYEBROW: 'ДОКУМЕНТЫ',
  DOCS_TITLE: 'Файлы проекта',
  DOCS_UPLOAD: '＋ Загрузить',
  DOCS_SEARCH: 'Поиск по файлам…',
  DOCS_DROP: 'Перетащите файлы сюда или нажмите «Загрузить»',
  DOCS_LOADING: 'Загрузка…',

  DT_EYEBROW: 'DIGITAL TWIN',
  DT_TITLE: 'Реестр оборудования',
  DT_ADD: '＋ Актив',
  DT_TAB_LIST: 'Список',
  DT_TAB_GRAPH: 'Граф',
  DT_EMPTY: 'Оборудование не добавлено.',

  LOGS_EYEBROW: 'ЖУРНАЛ СОБЫТИЙ',
  LOGS_TITLE: 'Системные события',
  LOGS_SEARCH: 'Поиск…',
  LOGS_REFRESH: '↺ Обновить',
  LOGS_EXPORT: '⬇ Экспорт CSV',

  ADMIN_EYEBROW: 'ADMIN',
  ADMIN_TITLE: 'Администрирование',

  AI_EYEBROW: 'AI ROUTER',
  AI_TITLE: 'Провайдер и использование',
  AI_DESC: 'Единая точка AI-запросов. Ключ читается из переменной окружения — никогда не хранится в БД.',
  AI_PROVIDER: 'Провайдер',
  AI_MODEL: 'Модель',
  AI_ENV_KEY: 'Env-переменная ключа',
  AI_MAX_TOKENS: 'Max tokens',
  AI_ENABLED: 'Включён',
  AI_SAVE: 'Сохранить',
  AI_TEST_EYEBROW: 'ТЕСТ ЗАПРОСА',
  AI_TEST_PLACEHOLDER: 'Введите промпт для теста…',
  AI_CLASSIFY: '🏷 Classify',
  AI_INVOKE: '▶ Invoke',
  AI_LOG_EYEBROW: 'LOG ВЫЗОВОВ',
  AI_LOG_LOAD: 'Загрузить лог',
  AI_STATUS_OK: '● Доступен',
  AI_STATUS_NO_KEY: '● Нет ключа',
  AI_STATUS_OFF: '● Не активен',
  AI_STATUS_ERR: '● Ошибка',

  KS_EYEBROW: 'БАЗА ЗНАНИЙ',
  KS_TITLE: 'Поиск по документам',
  KS_PLACEHOLDER: 'Поиск по файлам проекта…',
  KS_SEARCH: 'Найти',
  KS_REBUILD: '↺ Пересобрать индекс',
  KS_LOG_EYEBROW: 'AUDIT LOG ПОИСКА',
  KS_LOG_LOAD: 'Загрузить лог',

  TT_EYEBROW: 'УЧЁТ ВРЕМЕНИ',
  TT_TITLE: 'Загрузка сотрудников',
  TT_LOG: '＋ Записать время',
  TT_LOAD: 'Загрузить сессии',

  CQ_EYEBROW: 'КОНФЛИКТЫ СИНХРОНИЗАЦИИ',
  CQ_TITLE: 'Очередь конфликтов',
  CQ_EMPTY: 'Конфликтов нет.',

  BTN_CANCEL: 'Отмена',
  BTN_SAVE: 'Сохранить',
  BTN_DELETE: 'Удалить',
  BTN_CONFIRM: 'Подтвердить',
  BTN_CLOSE: 'Закрыть',
  BTN_LOADING: 'Загрузка…',
  LBL_OR: 'или',
  LBL_LOADING: 'Загрузка…',
  ROLE_LABEL: 'Роль',

  IMPORT_TITLE: 'Предпросмотр данных',
  IMPORT_EYEBROW: 'ИМПОРТ ПРОЕКТА',
  IMPORT_NOTE: 'Существующие записи с совпадающими ID будут пропущены (INSERT OR IGNORE).',
  IMPORT_CONFIRM: 'Импортировать',

  STATUS_ACTIVE: 'активен',
  STATUS_DONE: 'готово',
  STATUS_BLOCKED: 'заблокировано',

  SAVE_STATE_OK: 'Локально сохранено',
  SAVE_STATE_SAVING: 'Сохранение…',
};

const CATALOGS = { en: EN, ru: RU };

let _lang = localStorage.getItem(LANG_KEY) || 'en';

export function getLang() { return _lang; }

export function setLang(code) {
  if (!CATALOGS[code]) return;
  _lang = code;
  localStorage.setItem(LANG_KEY, code);
  applyI18n();
}

export function t(key, fallback) {
  const dict = CATALOGS[_lang] || EN;
  return dict[key] ?? EN[key] ?? fallback ?? key;
}

/** Walk DOM and replace [data-i18n] textContent and [data-i18n-placeholder]. */
export function applyI18n(root = document) {
  root.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.dataset.i18n;
    const val = t(key);
    if (val !== undefined) el.textContent = val;
  });
  root.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
    const key = el.dataset.i18nPlaceholder;
    const val = t(key);
    if (val !== undefined) el.placeholder = val;
  });
  root.querySelectorAll('[data-i18n-title]').forEach(el => {
    const key = el.dataset.i18nTitle;
    const val = t(key);
    if (val !== undefined) el.title = val;
  });
  // Update html lang attribute
  document.documentElement.lang = _lang;
}
