export const STATUSES = [
  { id: 'ideas', label: 'Ideas', tone: 'violet' },
  { id: 'backlog', label: 'Backlog', tone: 'slate' },
  { id: 'ready', label: 'Ready', tone: 'cyan' },
  { id: 'progress', label: 'In Progress', tone: 'blue' },
  { id: 'blocked', label: 'Blocked', tone: 'red' },
  { id: 'review', label: 'Review', tone: 'amber' },
  { id: 'testing', label: 'Testing', tone: 'pink' },
  { id: 'done', label: 'Done', tone: 'green' }
];

export const AREAS = [
  { id: 'foundation', label: 'Foundation', short: 'FND', color: '#7c8cff' },
  { id: 'platform', label: 'Platform Core', short: 'CORE', color: '#31d4c3' },
  { id: 'field', label: 'Field Operations', short: 'FIELD', color: '#ffb45c' },
  { id: 'intelligence', label: 'AI Intelligence', short: 'AI', color: '#d987ff' },
  { id: 'ecosystem', label: 'Scale & Ecosystem', short: 'SCALE', color: '#ff7185' }
];

export const INITIAL_TASKS = [
  { id:'FS-001', title:'Утвердить architecture baseline', description:'Зафиксировать bounded contexts, data ownership и стратегию эволюции.', type:'Epic', status:'done', priority:'critical', area:'foundation', risk:'' },
  { id:'FS-002', title:'Development Workspace', description:'Живой roadmap, Kanban и локальное сохранение.', type:'Feature', status:'testing', priority:'critical', area:'foundation', risk:'Проверить UX на мобильном экране' },
  { id:'FS-003', title:'Identity & tenant isolation', description:'OIDC, memberships, RBAC + context policies.', type:'Epic', status:'ready', priority:'critical', area:'platform', risk:'Выбор identity provider' },
  { id:'FS-004', title:'Immutable audit pipeline', description:'Единый event envelope, append-only storage и retention.', type:'Feature', status:'testing', priority:'critical', area:'platform', risk:'PII redaction policy' },
  { id:'FS-005', title:'Offline sync protocol', description:'Durable outbox, cursor sync и conflict resolution.', type:'Epic', status:'ideas', priority:'high', area:'field', risk:'Нужен ADR по conflict model' },
  { id:'FS-006', title:'Digital Twin schema', description:'Building → Floor → Room → assets и typed relationships.', type:'Epic', status:'progress', priority:'high', area:'field', risk:'Graph representation' },
  { id:'FS-007', title:'Document ingestion pipeline', description:'Versioning, virus scan, OCR и permission-aware indexing.', type:'Feature', status:'ideas', priority:'medium', area:'field', risk:'DWG preview strategy' },
  { id:'FS-008', title:'AI gateway & policy gate', description:'Provider abstraction, budgets, tracing и approval rules.', type:'Epic', status:'backlog', priority:'high', area:'intelligence', risk:'Data residency requirements' },
  { id:'FS-009', title:'Knowledge retrieval evaluation', description:'Набор проверок качества, permissions и grounded answers.', type:'Task', status:'ideas', priority:'medium', area:'intelligence', risk:'Нет benchmark dataset' },
  { id:'FS-010', title:'Observability baseline', description:'Logs, metrics, traces, SLO и runbook templates.', type:'Feature', status:'progress', priority:'high', area:'platform', risk:'' },
  { id:'FS-011', title:'Integration SDK', description:'Изолированные connectors, webhook verification и retries.', type:'Epic', status:'ideas', priority:'low', area:'ecosystem', risk:'После стабилизации core API' },
  { id:'FS-012', title:'Disaster recovery drill', description:'Проверить RPO/RTO реальным восстановлением.', type:'Task', status:'blocked', priority:'high', area:'ecosystem', risk:'Нет production-like environment' }
];
