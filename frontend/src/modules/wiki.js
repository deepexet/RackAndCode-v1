/**
 * Wiki module — knowledge base with AI assistant, search, analytics.
 *
 * Sections:
 *   - Library: browse pages by type/category
 *   - AI Assistant: equipment lookup + Q&A
 *   - Analytics: admin view (views, ratings, authors)
 */

import { apiJSON, apiPost, apiFetch } from '../core/api.js'
import { esc, fmtDate, timeAgo, badge, loadingSpinner, emptyState, renderMarkdown, openModal } from '../components/ui.js'

// ── State ─────────────────────────────────────────────────────────────────
let _el = null
let _pages = []
let _categories = []
let _selectedId = null
let _section = 'library'   // library | assistant | analytics
let _filterType = 'all'
let _filterCat = 'all'
let _searchQ = ''
let _searchResults = null  // null = not searching
let _searchDebounce = null

// ── Page types ───────────────────────────────────────────────────────────
const PAGE_TYPES = {
  general:     { label: 'Общее',        icon: 'ti-file-text',            color: 'var(--text-4)' },
  schema:      { label: 'Схема',         icon: 'ti-circuit-switchboard',  color: 'var(--blue-text)' },
  equipment:   { label: 'Оборудование',  icon: 'ti-cpu',                  color: 'var(--amber)' },
  troubleshoot:{ label: 'Решение проблем',icon: 'ti-tool',                color: 'var(--red)' },
  doc:         { label: 'Документация',  icon: 'ti-file-certificate',     color: 'var(--green)' },
}

const CATEGORY_ICONS = {
  'Схемы': 'ti-circuit-switchboard', 'Доступы': 'ti-key', 'Конфигурации': 'ti-settings',
  'Процедуры': 'ti-checklist', 'Инфраструктура': 'ti-server', 'Безопасность': 'ti-shield-lock',
  'Контакты': 'ti-phone', 'Оборудование': 'ti-cpu', 'Документация': 'ti-file-certificate',
  'Проблемы': 'ti-tool', 'Общее': 'ti-file-text',
}
const PRESET_CATS = ['Схемы', 'Доступы', 'Конфигурации', 'Оборудование', 'Документация', 'Проблемы', 'Процедуры', 'Безопасность', 'Контакты', 'Общее']

function typeIcon(type) { return PAGE_TYPES[type]?.icon || 'ti-file-text' }
function typeColor(type) { return PAGE_TYPES[type]?.color || 'var(--text-4)' }
function catIcon(cat) { return CATEGORY_ICONS[cat] || 'ti-file-text' }

// ── Data ─────────────────────────────────────────────────────────────────
async function loadPages() {
  const d = await apiJSON('/api/v1/wiki')
  _pages = d.pages || []
  _categories = d.categories || []
}

function filteredPages() {
  if (_searchResults !== null) return _searchResults
  let list = _pages
  if (_filterType !== 'all') list = list.filter(p => (p.page_type || 'general') === _filterType)
  if (_filterCat !== 'all') list = list.filter(p => p.category === _filterCat)
  if (_searchQ) {
    const q = _searchQ.toLowerCase()
    list = list.filter(p =>
      (p.title || '').toLowerCase().includes(q) ||
      (p.content || '').toLowerCase().includes(q) ||
      (p.category || '').toLowerCase().includes(q)
    )
  }
  return list
}

// ── Render ────────────────────────────────────────────────────────────────
function render() {
  if (!_el) return
  const pages = filteredPages()
  const selected = _selectedId ? _pages.find(p => p.id === _selectedId) : null

  _el.innerHTML = `
    <div class="wiki-layout">
      <!-- Sidebar -->
      <aside class="wiki-sidebar">
        ${renderSidebar(pages)}
      </aside>
      <!-- Content -->
      <main class="wiki-content" id="wiki-content">
        ${renderContent(selected, pages)}
      </main>
    </div>`

  bindEvents()
}

function renderSidebar(pages) {
  const typeCounts = {}
  _pages.forEach(p => {
    const t = p.page_type || 'general'
    typeCounts[t] = (typeCounts[t] || 0) + 1
  })

  return `
    <div class="wiki-sidebar-header">
      <div class="wiki-sidebar-title"><i class="ti ti-notebook"></i><span>База знаний</span></div>
      <button class="wiki-new-btn" id="wiki-new-page" title="Новая страница"><i class="ti ti-plus"></i></button>
    </div>

    <div class="wiki-search-wrap">
      <i class="ti ti-search wiki-search-icon"></i>
      <input class="wiki-search" type="search" placeholder="Поиск…" value="${esc(_searchQ)}" id="wiki-search">
    </div>

    <!-- Section tabs -->
    <div class="wiki-section-tabs">
      <button class="wiki-section-tab ${_section==='library'?'active':''}" data-section="library">
        <i class="ti ti-books"></i> Библиотека
      </button>
      <button class="wiki-section-tab ${_section==='assistant'?'active':''}" data-section="assistant">
        <i class="ti ti-robot"></i> AI
      </button>
      <button class="wiki-section-tab ${_section==='analytics'?'active':''}" data-section="analytics">
        <i class="ti ti-chart-bar"></i> Аналитика
      </button>
    </div>

    ${_section === 'library' ? `
      <!-- Type filters -->
      <div class="wiki-type-filters">
        <button class="wiki-type-btn ${_filterType==='all'?'active':''}" data-type="all">
          Все <span class="wiki-cat-count">${_pages.length}</span>
        </button>
        ${Object.entries(PAGE_TYPES).map(([key, def]) => {
          const cnt = typeCounts[key] || 0
          if (!cnt) return ''
          return `<button class="wiki-type-btn ${_filterType===key?'active':''}" data-type="${key}">
            <i class="ti ${def.icon}" style="color:${def.color}"></i> ${def.label}
            <span class="wiki-cat-count">${cnt}</span>
          </button>`
        }).join('')}
      </div>

      <nav class="wiki-nav">
        ${!pages.length
          ? `<div class="wiki-nav-empty">${_pages.length ? 'Ничего не найдено' : 'Нет страниц — создайте первую!'}</div>`
          : pages.map(p => `
            <button class="wiki-nav-item ${p.id === _selectedId ? 'active' : ''}" data-id="${esc(p.id)}">
              <i class="ti ${typeIcon(p.page_type)} wiki-nav-icon" style="color:${typeColor(p.page_type)}"></i>
              <div class="wiki-nav-info">
                <span class="wiki-nav-title">${esc(p.title)}</span>
                <span class="wiki-nav-meta">${esc(p.category || 'Общее')} · ${timeAgo(p.updated_at)}</span>
              </div>
              ${p.view_count > 0 ? `<span class="wiki-view-badge" title="${p.view_count} просмотров"><i class="ti ti-eye"></i>${p.view_count}</span>` : ''}
            </button>`).join('')}
      </nav>
    ` : '<div class="wiki-section-placeholder"></div>'}
  `
}

function renderContent(selected, pages) {
  if (_section === 'assistant') return renderAssistantSection()
  if (_section === 'analytics') return renderAnalyticsSection()
  if (selected) return renderPageView(selected, pages)
  return renderWelcome()
}

function renderWelcome() {
  const byType = {}
  _pages.forEach(p => { const t = p.page_type || 'general'; byType[t] = (byType[t] || 0) + 1 })
  const cats = [...new Set(_pages.map(p => p.category).filter(Boolean))]

  if (!_pages.length) return `
    <div class="wiki-welcome">
      <div class="wiki-welcome-icon"><i class="ti ti-notebook"></i></div>
      <h1>База знаний команды</h1>
      <p>Храните схемы подключения, документацию на оборудование, доступы и решения проблем.</p>
      <div class="wiki-welcome-types">
        ${Object.entries(PAGE_TYPES).map(([k, d]) => `
          <div class="wiki-type-hint">
            <i class="ti ${d.icon}" style="color:${d.color}"></i>
            <span>${d.label}</span>
          </div>`).join('')}
      </div>
      <button class="wiki-create-first" id="wiki-new-page-2"><i class="ti ti-plus"></i> Создать первую страницу</button>
    </div>`

  return `
    <div class="wiki-welcome">
      <div class="wiki-welcome-icon"><i class="ti ti-notebook"></i></div>
      <h1>База знаний</h1>
      <div class="wiki-stats-row">
        <div class="wiki-stat"><span class="wiki-stat-n">${_pages.length}</span><span>страниц</span></div>
        <div class="wiki-stat"><span class="wiki-stat-n">${cats.length}</span><span>разделов</span></div>
        <div class="wiki-stat"><span class="wiki-stat-n">${Object.keys(byType).length}</span><span>типов</span></div>
      </div>
      <div class="wiki-type-grid">
        ${Object.entries(PAGE_TYPES).map(([key, def]) => {
          const cnt = byType[key] || 0
          if (!cnt) return ''
          const items = _pages.filter(p => (p.page_type || 'general') === key).slice(0, 3)
          return `<div class="wiki-type-card" data-type="${key}">
            <div class="wiki-type-card-head">
              <i class="ti ${def.icon}" style="color:${def.color}"></i>
              <span>${def.label}</span>
              <span class="wiki-cat-count">${cnt}</span>
            </div>
            ${items.map(p => `<div class="wiki-type-card-item" data-id="${esc(p.id)}">${esc(p.title)}</div>`).join('')}
          </div>`
        }).join('')}
      </div>
      <p class="wiki-hint"><i class="ti ti-arrow-left"></i> Выберите страницу в боковом меню или <button class="wiki-link-btn" id="wiki-new-page-3">добавьте новую</button></p>
    </div>`
}

function renderPageView(p, all) {
  const idx = all.indexOf(p)
  let tags = []
  try { tags = typeof p.tags === 'string' ? JSON.parse(p.tags) : (p.tags || []) } catch {}
  let meta = {}
  try { meta = typeof p.metadata === 'string' ? JSON.parse(p.metadata) : (p.metadata || {}) } catch {}
  const typeDef = PAGE_TYPES[p.page_type || 'general'] || PAGE_TYPES.general

  return `
    <div class="wiki-page">
      <div class="wiki-page-header">
        <div class="wiki-page-meta">
          <span class="wiki-type-chip" style="color:${typeDef.color}">
            <i class="ti ${typeDef.icon}"></i> ${typeDef.label}
          </span>
          <span class="wiki-breadcrumb">${esc(p.category || 'Общее')}</span>
          ${tags.map(t => `<span class="wiki-tag">${esc(t)}</span>`).join('')}
        </div>
        <div class="wiki-page-actions">
          <button class="wiki-action-btn" data-action="edit" data-id="${esc(p.id)}" title="Редактировать"><i class="ti ti-edit"></i></button>
          <button class="wiki-action-btn wiki-action-btn--danger" data-action="delete" data-id="${esc(p.id)}" title="Удалить"><i class="ti ti-trash"></i></button>
        </div>
      </div>

      <h1 class="wiki-page-title">${esc(p.title)}</h1>

      ${meta.model ? `<div class="wiki-equip-badge"><i class="ti ti-cpu"></i> ${esc(meta.manufacturer||'')} ${esc(meta.model)} ${meta.doc_version ? `· v${esc(meta.doc_version)}` : ''} ${meta.doc_date ? `· ${esc(meta.doc_date)}` : ''}</div>` : ''}

      <div class="wiki-page-dates">
        <span><i class="ti ti-eye"></i> ${p.view_count || 0} просмотров</span>
        <span>·</span>
        <span>Обновлено ${timeAgo(p.updated_at)}${p.updated_by ? ` · ${esc(p.updated_by)}` : ''}</span>
      </div>

      <div class="wiki-page-body">
        ${p.content ? processSchemaEmbeds(renderMarkdown(p.content)) : emptyState({ icon: 'ti-file-off', title: 'Страница пустая', message: 'Нажмите редактировать' })}
      </div>

      ${renderPageDocLinks(meta, p.id)}

      <!-- Rating -->
      <div class="wiki-rating" id="wiki-rating-${esc(p.id)}">
        <span class="wiki-rating-label">Полезная статья?</span>
        <button class="wiki-rate-btn" data-rate="1" data-id="${esc(p.id)}" title="Да, полезно">
          <i class="ti ti-thumb-up"></i> ${p.helpful_count || 0}
        </button>
        <button class="wiki-rate-btn wiki-rate-btn--no" data-rate="0" data-id="${esc(p.id)}" title="Нет">
          <i class="ti ti-thumb-down"></i> ${p.not_helpful_count || 0}
        </button>
      </div>

      <!-- AI Q&A -->
      <div class="wiki-ai-chat" id="wiki-ai-chat">
        <div class="wiki-ai-chat-header">
          <i class="ti ti-robot"></i> Спросить AI об этой странице
        </div>
        <div class="wiki-ai-messages" id="wiki-ai-msgs"></div>
        <div class="wiki-ai-input-row">
          <input class="wiki-ai-input" id="wiki-ai-input" placeholder="Например: покажи схему подключения electric strike к door expander…">
          <button class="wiki-ai-send" id="wiki-ai-send"><i class="ti ti-send"></i></button>
        </div>
      </div>

      <div class="wiki-page-nav">
        ${all[idx-1] ? `<button class="wiki-nav-btn" data-id="${esc(all[idx-1].id)}"><i class="ti ti-arrow-left"></i> ${esc(all[idx-1].title)}</button>` : '<span></span>'}
        ${all[idx+1] ? `<button class="wiki-nav-btn" data-id="${esc(all[idx+1].id)}">${esc(all[idx+1].title)} <i class="ti ti-arrow-right"></i></button>` : '<span></span>'}
      </div>
    </div>`
}

function renderPageDocLinks(meta, pageId) {
  const links = meta.docLinks || []
  const attachments = meta._attachments || []  // locally saved, loaded async

  if (!links.length && !attachments.length) return ''

  return `
    <div class="wiki-doc-links wiki-page-doc-links" id="wiki-page-doc-links-${esc(pageId)}">
      <div class="wiki-doc-links-title"><i class="ti ti-files"></i> Официальная документация</div>
      <div class="wiki-doc-links-list">
        ${attachments.map(a => `
          <a href="${esc(a.localUrl || `/api/v1/wiki/attachments/${a.id}`)}" target="_blank" rel="noopener"
             class="wiki-doc-link ${a.mimeType?.includes('pdf') ? 'wiki-doc-link--pdf' : ''} wiki-doc-link--local">
            <i class="ti ${a.mimeType?.includes('pdf') ? 'ti-file-type-pdf' : 'ti-file'}"></i>
            <div class="wiki-doc-link-info">
              <div class="wiki-doc-link-title">${esc(a.filename)}</div>
              <div class="wiki-doc-link-url wiki-doc-link--saved">
                <i class="ti ti-check"></i> Сохранён локально · ${fmtFileSize(a.fileSize || 0)}
              </div>
            </div>
            ${a.mimeType?.includes('pdf') ? '<span class="wiki-doc-pdf-badge">PDF</span>' : ''}
          </a>`).join('')}

        ${links.map((d, i) => `
          <div class="wiki-doc-link-row" id="wiki-dl-row-${pageId}-${i}">
            <a href="${esc(d.url)}" target="_blank" rel="noopener"
               class="wiki-doc-link ${d.isPdf ? 'wiki-doc-link--pdf' : ''}" style="flex:1">
              <i class="ti ${d.isPdf ? 'ti-file-type-pdf' : 'ti-external-link'}"></i>
              <div class="wiki-doc-link-info">
                <div class="wiki-doc-link-title">${esc(d.title)}</div>
                <div class="wiki-doc-link-url">${esc(d.displayUrl || '')}</div>
              </div>
              ${d.isPdf ? '<span class="wiki-doc-pdf-badge">PDF</span>' : ''}
            </a>
            <button class="wiki-dl-btn" title="Сохранить на платформу"
              data-url="${esc(d.url)}" data-title="${esc(d.title)}"
              data-page-id="${esc(pageId)}" data-row-id="wiki-dl-row-${pageId}-${i}">
              <i class="ti ti-download"></i>
            </button>
          </div>`).join('')}
      </div>
    </div>`
}

function fmtFileSize(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

// ── AI Assistant section ──────────────────────────────────────────────────
let _assistantHistory = []
let _assistantLoading = false

function renderAssistantSection() {
  return `
    <div class="wiki-assistant">
      <div class="wiki-assistant-header">
        <div class="wiki-assistant-icon"><i class="ti ti-robot"></i></div>
        <div>
          <h2>AI Техпомощник</h2>
          <p>Введите модель оборудования или задайте технический вопрос — получите документацию, схемы и инструкции.</p>
        </div>
      </div>

      <div class="wiki-assistant-examples">
        <span class="wiki-example-label">Примеры:</span>
        ${['DMP XT30 panel', 'ICT Protégé WX', 'подключение electric strike к door expander', 'Bosch DS150i motion detector specs'].map(ex =>
          `<button class="wiki-example-chip" data-example="${esc(ex)}">${esc(ex)}</button>`
        ).join('')}
        <button class="wiki-example-chip wiki-example-chip--schema" id="wiki-gen-diagram-btn" title="Сгенерировать схему подключения по запросу">
          <i class="ti ti-circuit-switchboard"></i> Схема AI
        </button>
      </div>

      <div class="wiki-assistant-input-row">
        <div class="wiki-assistant-input-wrap">
          <i class="ti ti-search wiki-search-icon"></i>
          <input class="wiki-assistant-input" id="wiki-assist-input"
            placeholder="Модель оборудования, технический вопрос…">
        </div>
        <label class="wiki-upload-btn" title="Загрузить фото оборудования">
          <i class="ti ti-photo"></i>
          <input type="file" id="wiki-photo-input" accept="image/*" style="display:none">
        </label>
        <button class="wiki-assist-send" id="wiki-assist-send">
          <i class="ti ti-arrow-right"></i> Найти
        </button>
      </div>

      <div id="wiki-photo-preview" class="wiki-photo-preview" style="display:none">
        <img id="wiki-photo-img" style="max-height:100px;border-radius:6px">
        <button id="wiki-photo-clear" class="wiki-photo-clear"><i class="ti ti-x"></i></button>
      </div>

      <div class="wiki-assistant-messages" id="wiki-assist-msgs">
        ${_assistantHistory.length === 0 ? `
          <div class="wiki-assist-empty">
            <i class="ti ti-bolt"></i>
            <p>Введите модель или вопрос выше — AI найдёт документацию, спецификации и схемы подключения.</p>
          </div>` : _assistantHistory.map(renderAssistantMsg).join('')}
      </div>
    </div>`
}

function renderAssistantMsg(msg) {
  if (msg.role === 'user') return `
    <div class="wiki-assist-msg wiki-assist-msg--user">
      <div class="wiki-assist-bubble">${esc(msg.content)}
        ${msg.imageUrl ? `<img src="${esc(msg.imageUrl)}" class="wiki-assist-img">` : ''}
      </div>
    </div>`

  if (msg.loading) return `
    <div class="wiki-assist-msg wiki-assist-msg--ai">
      <div class="wiki-assist-ai-icon"><i class="ti ti-robot"></i></div>
      <div class="wiki-assist-bubble wiki-assist-bubble--ai">
        <span class="wiki-assist-loading"><i class="ti ti-loader-2"></i> ${esc(msg.loadingText || 'Ищу документацию…')}</span>
      </div>
    </div>`

  const docLinks = msg.docLinks || []
  const existingPages = msg.existingWikiPages || []

  return `
    <div class="wiki-assist-msg wiki-assist-msg--ai">
      <div class="wiki-assist-ai-icon"><i class="ti ti-robot"></i></div>
      <div class="wiki-assist-bubble wiki-assist-bubble--ai">
        <div class="wiki-assist-answer">${renderMarkdown(msg.content)}</div>

        ${docLinks.length ? `
          <div class="wiki-doc-links">
            <div class="wiki-doc-links-title"><i class="ti ti-files"></i> Официальная документация</div>
            <div class="wiki-doc-links-list">
              ${docLinks.map(d => `
                <a href="${esc(d.url)}" target="_blank" rel="noopener" class="wiki-doc-link ${d.isPdf ? 'wiki-doc-link--pdf' : ''}">
                  <i class="ti ${d.isPdf ? 'ti-file-type-pdf' : 'ti-external-link'}"></i>
                  <div class="wiki-doc-link-info">
                    <div class="wiki-doc-link-title">${esc(d.title)}</div>
                    <div class="wiki-doc-link-url">${esc(d.displayUrl || '')}</div>
                  </div>
                  ${d.isPdf ? '<span class="wiki-doc-pdf-badge">PDF</span>' : ''}
                </a>`).join('')}
            </div>
          </div>` : ''}

        <div class="wiki-assist-actions">
          <button class="wiki-assist-save"
            data-content="${esc(msg.content)}"
            data-query="${esc(msg.query||'')}"
            data-doc-links="${esc(JSON.stringify(docLinks))}">
            <i class="ti ti-bookmark"></i> Сохранить в Wiki
          </button>
          <button class="wiki-assist-diagram" data-query="${esc(msg.query||msg.content.slice(0,200))}">
            <i class="ti ti-circuit-switchboard"></i> Создать схему
          </button>
        </div>
      </div>
    </div>`
}

// ── Analytics section ─────────────────────────────────────────────────────
let _analytics = null

function renderAnalyticsSection() {
  if (!_analytics) return `<div class="wiki-analytics-loading">${loadingSpinner('Загрузка аналитики…')}</div>`

  const a = _analytics
  return `
    <div class="wiki-analytics">
      <h2 class="wiki-analytics-title"><i class="ti ti-chart-bar"></i> Аналитика базы знаний</h2>

      <div class="wiki-analytics-grid">
        <div class="wiki-a-card">
          <div class="wiki-a-val">${a.total}</div>
          <div class="wiki-a-label">Всего страниц</div>
        </div>
        ${a.byType.map(t => `
          <div class="wiki-a-card">
            <div class="wiki-a-val" style="color:${typeColor(t.type)}">${t.count}</div>
            <div class="wiki-a-label">${PAGE_TYPES[t.type]?.label || t.type}</div>
          </div>`).join('')}
      </div>

      <div class="wiki-analytics-row">
        <!-- Most viewed -->
        <div class="wiki-a-section">
          <div class="wiki-a-section-title"><i class="ti ti-eye"></i> Наиболее просматриваемые</div>
          ${a.mostViewed.length ? a.mostViewed.map((p, i) => `
            <div class="wiki-a-row" data-id="${esc(p.id)}">
              <span class="wiki-a-rank">${i+1}</span>
              <div class="wiki-a-info">
                <div class="wiki-a-item-title">${esc(p.title)}</div>
                <div class="wiki-a-item-meta">${PAGE_TYPES[p.page_type]?.label || 'Общее'} · ${esc(p.category)}</div>
              </div>
              <span class="wiki-a-metric"><i class="ti ti-eye"></i> ${p.view_count}</span>
            </div>`).join('') : '<div class="wiki-a-empty">Нет данных</div>'}
        </div>

        <!-- Most helpful -->
        <div class="wiki-a-section">
          <div class="wiki-a-section-title"><i class="ti ti-thumb-up"></i> Наиболее полезные</div>
          ${a.mostHelpful.length ? a.mostHelpful.map((p, i) => `
            <div class="wiki-a-row" data-id="${esc(p.id)}">
              <span class="wiki-a-rank">${i+1}</span>
              <div class="wiki-a-info">
                <div class="wiki-a-item-title">${esc(p.title)}</div>
                <div class="wiki-a-item-meta">${PAGE_TYPES[p.page_type]?.label || 'Общее'} · ${esc(p.category)}</div>
              </div>
              <span class="wiki-a-metric wiki-a-helpful"><i class="ti ti-thumb-up"></i> ${p.helpful_count}</span>
            </div>`).join('') : '<div class="wiki-a-empty">Нет оценок</div>'}
        </div>
      </div>

      <!-- By author -->
      <div class="wiki-a-section">
        <div class="wiki-a-section-title"><i class="ti ti-users"></i> Активность авторов</div>
        <div class="wiki-a-authors">
          ${a.byAuthor.map(a => `
            <div class="wiki-a-author">
              <div class="wiki-a-author-avatar">${(a.author || '?').slice(0,1).toUpperCase()}</div>
              <div class="wiki-a-author-info">
                <div class="wiki-a-author-name">${esc(a.author || 'Аноним')}</div>
                <div class="wiki-a-author-count">${a.count} стр.</div>
              </div>
              <div class="wiki-a-author-bar" style="width:${Math.round(a.count / (a.byAuthor?.[0]?.count || 1) * 100)}%"></div>
            </div>`).join('')}
        </div>
      </div>

      <!-- Recent views -->
      ${a.recentViews.length ? `
        <div class="wiki-a-section">
          <div class="wiki-a-section-title"><i class="ti ti-history"></i> Последние просмотры</div>
          ${a.recentViews.map(v => `
            <div class="wiki-a-row" data-id="${esc(v.page_id)}">
              <div class="wiki-a-info">
                <div class="wiki-a-item-title">${esc(v.title)}</div>
                <div class="wiki-a-item-meta">${esc(v.viewer_id)} · ${timeAgo(v.viewed_at)}</div>
              </div>
            </div>`).join('')}
        </div>` : ''}
    </div>`
}

// ── Edit modal ────────────────────────────────────────────────────────────
function openEditModal(page = null, prefill = {}) {
  const isEdit = !!page
  const defaultType = prefill.pageType || page?.page_type || 'general'
  let meta = {}
  try { meta = typeof page?.metadata === 'string' ? JSON.parse(page.metadata) : (page?.metadata || {}) } catch {}

  const { el, close } = openModal({
    title: isEdit ? 'Редактировать страницу' : 'Новая страница',
    maxWidth: '700px',
    body: `<form class="ui-form" id="wiki-form">
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
        <div class="ui-form-row">
          <label>Название</label>
          <input class="ui-input" name="title" placeholder="Название страницы…" value="${esc(prefill.title || page?.title || '')}" required>
        </div>
        <div class="ui-form-row">
          <label>Тип</label>
          <select class="ui-input" name="pageType" id="wiki-type-sel">
            ${Object.entries(PAGE_TYPES).map(([k, d]) =>
              `<option value="${k}" ${defaultType===k?'selected':''}>${d.label}</option>`
            ).join('')}
          </select>
        </div>
        <div class="ui-form-row">
          <label>Раздел</label>
          <select class="ui-input" name="category">
            ${PRESET_CATS.map(c =>
              `<option value="${esc(c)}" ${(prefill.category||page?.category)===c?'selected':''}>${esc(c)}</option>`
            ).join('')}
          </select>
        </div>
        <div class="ui-form-row">
          <label>Теги (через запятую)</label>
          <input class="ui-input" name="tags" placeholder="cisco, vpn, panel…" value="${esc((() => { try { return (typeof page?.tags==='string'?JSON.parse(page?.tags||'[]'):page?.tags||[]).join(', ') } catch{return''} })())}">
        </div>
      </div>
      <!-- Equipment metadata (shown for equipment/doc type) -->
      <div id="wiki-equip-meta" style="${['equipment','doc'].includes(defaultType)?'':'display:none'}">
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;margin-bottom:4px">
          <div class="ui-form-row"><label>Производитель</label>
            <input class="ui-input" name="manufacturer" value="${esc(meta.manufacturer||'')}"></div>
          <div class="ui-form-row"><label>Модель</label>
            <input class="ui-input" name="model" value="${esc(meta.model||'')}"></div>
          <div class="ui-form-row"><label>Версия документа</label>
            <input class="ui-input" name="doc_version" value="${esc(meta.doc_version||'')}"></div>
        </div>
      </div>
      <div class="ui-form-row">
        <label>Контент (Markdown)</label>
        <textarea class="ui-input wiki-textarea" name="content" rows="14" placeholder="# Заголовок\n\n## Описание\n\n...">${esc(prefill.content || page?.content || '')}</textarea>
      </div>
    </form>`,
    footer: `<button class="ui-btn ui-btn--primary" id="wiki-save">Сохранить</button>
             <button class="ui-btn" id="wiki-cancel">Отмена</button>`,
  })

  // Show/hide equipment meta on type change
  document.getElementById('wiki-type-sel')?.addEventListener('change', e => {
    const meta = document.getElementById('wiki-equip-meta')
    if (meta) meta.style.display = ['equipment','doc'].includes(e.target.value) ? '' : 'none'
  })

  // "Вставить схему" button — injects [[schema:ID]] at textarea cursor
  const schemaPages = _pages.filter(p => p.page_type === 'schema')
  if (schemaPages.length > 0) {
    const textarea = el.querySelector('textarea[name="content"]')
    const insertWrap = document.createElement('div')
    insertWrap.className = 'wiki-insert-schema-wrap'
    insertWrap.innerHTML = `
      <button type="button" class="wiki-insert-schema-btn">
        <i class="ti ti-circuit-switchboard"></i> Вставить схему
        <i class="ti ti-chevron-down"></i>
      </button>
      <div class="wiki-schema-picker" style="display:none">
        ${schemaPages.map(s => `
          <div class="wiki-schema-pick-item" data-id="${esc(s.id)}">
            <i class="ti ti-circuit-switchboard"></i> ${esc(s.title)}
          </div>`).join('')}
      </div>`
    textarea?.parentNode.insertBefore(insertWrap, textarea)
    const picker = insertWrap.querySelector('.wiki-schema-picker')
    insertWrap.querySelector('.wiki-insert-schema-btn')?.addEventListener('click', () => {
      picker.style.display = picker.style.display === 'none' ? '' : 'none'
    })
    insertWrap.querySelectorAll('.wiki-schema-pick-item').forEach(item =>
      item.addEventListener('click', () => {
        const txt = `[[schema:${item.dataset.id}]]`
        const start = textarea.selectionStart ?? textarea.value.length
        textarea.value = textarea.value.slice(0, start) + txt + textarea.value.slice(start)
        textarea.selectionStart = textarea.selectionEnd = start + txt.length
        textarea.focus()
        picker.style.display = 'none'
      })
    )
  }

  document.getElementById('wiki-cancel')?.addEventListener('click', close)
  document.getElementById('wiki-save')?.addEventListener('click', async () => {
    const form = document.getElementById('wiki-form')
    const fd = Object.fromEntries(new FormData(form))
    if (!fd.title?.trim()) { window.toast?.('Введите название', 'error'); return }
    const tags = fd.tags ? fd.tags.split(',').map(t => t.trim()).filter(Boolean) : []
    // Preserve docLinks from existing page (edit) or from AI assistant prefill (new)
    let existingMeta = {}
    try { existingMeta = typeof page?.metadata === 'string' ? JSON.parse(page.metadata) : (page?.metadata || {}) } catch {}
    const metadata = { ...existingMeta, ...(prefill.metadata || {}), manufacturer: fd.manufacturer, model: fd.model, doc_version: fd.doc_version }
    try {
      const url = isEdit ? `/api/v1/wiki/${page.id}` : '/api/v1/wiki'
      await apiPost(url, { title: fd.title.trim(), category: fd.category, pageType: fd.pageType, content: fd.content||'', tags, metadata })
      close()
      window.toast?.('Сохранено', 'success')
      await loadPages()
      if (isEdit) _selectedId = page.id
      render()
    } catch (err) { window.toast?.(`Ошибка: ${err.message}`, 'error') }
  })
}

// ── Schema embed helpers ──────────────────────────────────────────────────

// Replace [[schema:PAGE_ID]] in rendered HTML with interactive diagram cards
function processSchemaEmbeds(html) {
  return html.replace(/\[\[schema:([a-z0-9_-]+)\]\]/gi, (_, id) => {
    const sp = _pages.find(p => p.id === id && p.page_type === 'schema')
    if (!sp) return `<span class="wiki-schema-missing"><i class="ti ti-alert-circle"></i> схема ${esc(id)} не найдена</span>`
    let compCount = 0
    try {
      const meta = typeof sp.metadata === 'string' ? JSON.parse(sp.metadata) : (sp.metadata || {})
      const diag = meta.diagramJson ? JSON.parse(meta.diagramJson) : {}
      compCount = (diag.components || []).length
    } catch {}
    return `<div class="wiki-schema-embed" data-diagram-id="${esc(id)}">
      <div class="wiki-schema-embed-icon"><i class="ti ti-circuit-switchboard"></i></div>
      <div class="wiki-schema-embed-info">
        <div class="wiki-schema-embed-title">${esc(sp.title)}</div>
        <div class="wiki-schema-embed-meta">${compCount} компонент${compCount===1?'':'ов'}</div>
      </div>
      <button class="wiki-schema-open-btn" data-diagram-id="${esc(id)}">
        <i class="ti ti-arrow-right"></i> Открыть
      </button>
    </div>`
  })
}

// ── Diagram generation ────────────────────────────────────────────────────

async function generateDiagramFromQuery(prompt) {
  window.toast?.('Генерирую схему…', 'info')
  try {
    const resp = await apiFetch('/api/v1/wiki/generate-diagram', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt }),
    })
    const data = await resp.json()
    if (!data.diagram) throw new Error('Нет данных от AI')
    window._rpPendingDiagram = data.diagram
    window.router?.go('diagrams')
    window.toast?.('Схема создана — открываю конструктор', 'success')
  } catch (err) {
    window.toast?.('Ошибка генерации: ' + err.message, 'error')
  }
}

// ── AI actions ────────────────────────────────────────────────────────────
let _photoBase64 = null

async function sendAIQuery(query, imageBase64 = null) {
  if (_assistantLoading) return
  _assistantLoading = true

  _assistantHistory.push({ role: 'user', content: query, imageUrl: imageBase64 ? `data:image/jpeg;base64,${imageBase64}` : null })

  // Check wiki for existing pages BEFORE calling AI
  const words = query.toLowerCase().split(/\s+/).filter(w => w.length > 3)
  const matchingWikiPages = _pages.filter(p =>
    words.some(w => p.title.toLowerCase().includes(w) || (p.content || '').toLowerCase().includes(w))
  )

  if (matchingWikiPages.length > 0) {
    // Show "found in wiki" suggestion inline — user can dismiss and continue
    _assistantHistory.push({
      role: 'wiki-hint',
      pages: matchingWikiPages.slice(0, 3),
      query,
    })
    rerenderAssistant()

    // Wait 0ms to let the user see the hint, then auto-continue with AI
    // (user can click pages or ignore; we still call AI)
  }

  _assistantHistory.push({ role: 'ai', content: '', loading: true, loadingText: 'Ищу документацию в интернете…', query })
  rerenderAssistant()

  try {
    const contextPages = matchingWikiPages
      .filter(p => p.page_type === 'equipment' || p.page_type === 'doc' || p.page_type === 'schema')
      .slice(0, 3)
      .map(p => ({ title: p.title, content: p.content || '' }))

    const resp = await apiFetch('/api/v1/wiki/ai-lookup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, contextPages, imageBase64, searchWeb: true }),
    })
    const data = await resp.json()
    const answer = data.answer || 'Нет ответа от AI'

    _assistantHistory[_assistantHistory.length - 1] = {
      role: 'ai', content: answer, query, loading: false,
      docLinks: data.docLinks || [],
      existingWikiPages: data.existingWikiPages || [],
    }
  } catch (err) {
    _assistantHistory[_assistantHistory.length - 1] = {
      role: 'ai', content: `Ошибка: ${err.message}`, query, loading: false, docLinks: [], existingWikiPages: [],
    }
  }

  _assistantLoading = false
  rerenderAssistant()
}

function renderWikiHint(msg) {
  return `
    <div class="wiki-hint-block">
      <div class="wiki-hint-header">
        <i class="ti ti-notebook"></i>
        <strong>В Wiki уже есть по этой теме:</strong>
      </div>
      ${msg.pages.map(p => `
        <div class="wiki-hint-page" data-id="${esc(p.id)}">
          <span class="wiki-hint-type-dot" style="background:${typeColor(p.page_type)}"></span>
          <span class="wiki-hint-page-title">${esc(p.title)}</span>
          <span class="wiki-hint-page-cat">${esc(p.category || '')}</span>
        </div>`).join('')}
      <div class="wiki-hint-note">AI также поищет новую документацию в интернете ↓</div>
    </div>`
}

function rerenderAssistant() {
  const msgs = document.getElementById('wiki-assist-msgs')
  if (!msgs) return
  msgs.innerHTML = _assistantHistory.length === 0
    ? `<div class="wiki-assist-empty"><i class="ti ti-bolt"></i><p>Введите модель или вопрос — AI найдёт документацию и схемы.</p></div>`
    : _assistantHistory.map(msg =>
        msg.role === 'wiki-hint' ? renderWikiHint(msg) : renderAssistantMsg(msg)
      ).join('')
  msgs.scrollTop = msgs.scrollHeight
  bindAssistantEvents()
}

async function sendPageAIQuery(query, page) {
  const chatMsgs = document.getElementById('wiki-ai-msgs')
  if (!chatMsgs) return

  chatMsgs.innerHTML += `<div class="wiki-page-ai-msg wiki-page-ai-msg--user">${esc(query)}</div>
    <div class="wiki-page-ai-msg wiki-page-ai-msg--ai wiki-page-ai-loading" id="page-ai-loading">
      <i class="ti ti-loader-2"></i> Думаю…
    </div>`
  chatMsgs.scrollTop = chatMsgs.scrollHeight

  try {
    const resp = await apiFetch('/api/v1/wiki/ai-lookup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, contextPages: [{ title: page.title, content: page.content }] }),
    })
    const data = await resp.json()
    const loadingEl = document.getElementById('page-ai-loading')
    if (loadingEl) loadingEl.outerHTML = `<div class="wiki-page-ai-msg wiki-page-ai-msg--ai">${renderMarkdown(data.answer || 'Нет ответа')}</div>`
  } catch (err) {
    const loadingEl = document.getElementById('page-ai-loading')
    if (loadingEl) loadingEl.outerHTML = `<div class="wiki-page-ai-msg wiki-page-ai-msg--ai">Ошибка: ${esc(err.message)}</div>`
  }
}

// ── Events ────────────────────────────────────────────────────────────────
function bindEvents() {
  // Search
  let debounce
  document.getElementById('wiki-search')?.addEventListener('input', e => {
    clearTimeout(debounce)
    _searchQ = e.target.value
    debounce = setTimeout(() => { _searchResults = null; render() }, 200)
  })

  // Section tabs
  _el.querySelectorAll('[data-section]').forEach(btn =>
    btn.addEventListener('click', async () => {
      _section = btn.dataset.section
      _selectedId = null
      if (_section === 'analytics' && !_analytics) {
        try { const d = await apiJSON('/api/v1/wiki/analytics'); _analytics = d } catch {}
      }
      render()
    })
  )

  // Type filters
  _el.querySelectorAll('[data-type]').forEach(btn =>
    btn.addEventListener('click', () => { _filterType = btn.dataset.type; _selectedId = null; render() })
  )

  // Nav items / any data-id
  _el.querySelectorAll('[data-id]').forEach(btn => {
    btn.addEventListener('click', async () => {
      _selectedId = btn.dataset.id
      _section = 'library'
      document.getElementById('wiki-content')?.scrollTo(0, 0)
      // Track view
      apiPost(`/api/v1/wiki/${_selectedId}/view`, {}).catch(() => {})
      render()
    })
  })

  // New page
  const openNew = () => openEditModal()
  document.getElementById('wiki-new-page')?.addEventListener('click', openNew)
  document.getElementById('wiki-new-page-2')?.addEventListener('click', openNew)
  document.getElementById('wiki-new-page-3')?.addEventListener('click', openNew)

  // Type card items (welcome screen)
  _el.querySelectorAll('[data-type].wiki-type-card').forEach(card =>
    card.addEventListener('click', () => { _filterType = card.dataset.type; render() })
  )

  // Edit / Delete
  _el.querySelectorAll('[data-action="edit"]').forEach(btn =>
    btn.addEventListener('click', () => { const p = _pages.find(x => x.id === btn.dataset.id); if (p) openEditModal(p) })
  )
  _el.querySelectorAll('[data-action="delete"]').forEach(btn =>
    btn.addEventListener('click', async () => {
      if (!confirm('Удалить страницу?')) return
      await apiPost(`/api/v1/wiki/${btn.dataset.id}/delete`, {})
      if (_selectedId === btn.dataset.id) _selectedId = null
      window.toast?.('Удалено', 'info')
      await loadPages(); render()
    })
  )

  // Rating
  _el.querySelectorAll('[data-rate]').forEach(btn =>
    btn.addEventListener('click', async () => {
      const helpful = btn.dataset.rate === '1'
      const resp = await apiFetch(`/api/v1/wiki/${btn.dataset.id}/rate`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ helpful }),
      })
      const data = await resp.json()
      const p = data.page
      if (p) {
        const idx = _pages.findIndex(x => x.id === p.id)
        if (idx >= 0) _pages[idx] = p
        const ratingEl = document.getElementById(`wiki-rating-${p.id}`)
        if (ratingEl) {
          ratingEl.innerHTML = `<span class="wiki-rating-thanks"><i class="ti ti-check"></i> Спасибо за оценку!</span>
            <span class="wiki-rating-counts"><i class="ti ti-thumb-up"></i> ${p.helpful_count} <i class="ti ti-thumb-down"></i> ${p.not_helpful_count}</span>`
        }
      }
    })
  )

  // Download doc to platform
  _el.querySelectorAll('.wiki-dl-btn').forEach(btn =>
    btn.addEventListener('click', async () => {
      const url = btn.dataset.url
      const title = btn.dataset.title
      const pageId = btn.dataset.pageId
      const rowId = btn.dataset.rowId
      if (!url) return

      btn.disabled = true
      btn.innerHTML = '<i class="ti ti-loader-2"></i>'
      btn.title = 'Загрузка…'

      try {
        const data = await apiJSON('/api/v1/wiki/attachments', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url, title, pageId }),
        })
        const att = data.attachment
        // Replace the external link row with a local attachment link
        const row = document.getElementById(rowId)
        if (row && att) {
          row.outerHTML = `
            <a href="${esc(att.localUrl)}" target="_blank" rel="noopener"
               class="wiki-doc-link ${att.mimeType?.includes('pdf') ? 'wiki-doc-link--pdf' : ''} wiki-doc-link--local">
              <i class="ti ${att.mimeType?.includes('pdf') ? 'ti-file-type-pdf' : 'ti-file'}"></i>
              <div class="wiki-doc-link-info">
                <div class="wiki-doc-link-title">${esc(att.filename)}</div>
                <div class="wiki-doc-link-url wiki-doc-link--saved">
                  <i class="ti ti-check"></i> Сохранён локально · ${fmtFileSize(att.fileSize || 0)}
                </div>
              </div>
              ${att.mimeType?.includes('pdf') ? '<span class="wiki-doc-pdf-badge">PDF</span>' : ''}
            </a>`
        }
        window.toast?.(`Файл "${att.filename}" сохранён`, 'success')
      } catch (err) {
        btn.disabled = false
        btn.innerHTML = '<i class="ti ti-download"></i>'
        btn.title = 'Сохранить на платформу'
        window.toast?.(`Ошибка: ${err.message}`, 'error')
      }
    })
  )

  // Load existing attachments for the current page and inject into doc links panel
  if (_selectedId) {
    const curPage = _pages.find(p => p.id === _selectedId)
    let meta = {}
    try { meta = typeof curPage?.metadata === 'string' ? JSON.parse(curPage.metadata) : (curPage?.metadata || {}) } catch {}
    if (meta.docLinks?.length) {
      apiJSON(`/api/v1/wiki/${_selectedId}/attachments`).then(data => {
        const atts = data.attachments || []
        if (!atts.length) return
        // Find already-saved URLs, remove their download buttons
        const savedUrls = new Set(atts.map(a => a.original_url))
        _el.querySelectorAll('.wiki-dl-btn').forEach(b => {
          if (savedUrls.has(b.dataset.url)) {
            const row = document.getElementById(b.dataset.rowId)
            const att = atts.find(a => a.original_url === b.dataset.url)
            if (row && att) {
              row.outerHTML = `
                <a href="/api/v1/wiki/attachments/${esc(att.id)}" target="_blank" rel="noopener"
                   class="wiki-doc-link ${att.mime_type?.includes('pdf') ? 'wiki-doc-link--pdf' : ''} wiki-doc-link--local">
                  <i class="ti ${att.mime_type?.includes('pdf') ? 'ti-file-type-pdf' : 'ti-file'}"></i>
                  <div class="wiki-doc-link-info">
                    <div class="wiki-doc-link-title">${esc(att.filename)}</div>
                    <div class="wiki-doc-link-url wiki-doc-link--saved">
                      <i class="ti ti-check"></i> Сохранён локально · ${fmtFileSize(att.file_size || 0)}
                    </div>
                  </div>
                  ${att.mime_type?.includes('pdf') ? '<span class="wiki-doc-pdf-badge">PDF</span>' : ''}
                </a>`
            }
          }
        })
      }).catch(() => {})
    }
  }

  // Page AI chat
  const page = _selectedId ? _pages.find(p => p.id === _selectedId) : null
  const sendPageAI = () => {
    const input = document.getElementById('wiki-ai-input')
    const q = input?.value?.trim()
    if (!q || !page) return
    input.value = ''
    sendPageAIQuery(q, page)
  }
  document.getElementById('wiki-ai-send')?.addEventListener('click', sendPageAI)
  document.getElementById('wiki-ai-input')?.addEventListener('keydown', e => { if (e.key === 'Enter') sendPageAI() })

  // Schema embed "Open" buttons (from [[schema:ID]] in page body)
  _el.querySelectorAll('.wiki-schema-open-btn').forEach(btn =>
    btn.addEventListener('click', () => {
      window._rpPendingDiagramId = btn.dataset.diagramId
      window.router?.go('diagrams')
    })
  )

  // Assistant section events
  bindAssistantEvents()
}

function bindAssistantEvents() {
  // Send button
  const doSend = async () => {
    const input = document.getElementById('wiki-assist-input')
    const q = input?.value?.trim()
    if (!q) return
    const isGenDiagram = input.dataset.genDiagram === '1'
    delete input.dataset.genDiagram
    input.value = ''
    _photoBase64 = null
    const preview = document.getElementById('wiki-photo-preview')
    if (preview) preview.style.display = 'none'
    if (isGenDiagram) { await generateDiagramFromQuery(q); return }
    await sendAIQuery(q)
  }
  document.getElementById('wiki-assist-send')?.addEventListener('click', doSend)
  document.getElementById('wiki-assist-input')?.addEventListener('keydown', e => { if (e.key === 'Enter') doSend() })

  // Example chips
  _el.querySelectorAll('[data-example]').forEach(btn =>
    btn.addEventListener('click', () => {
      const input = document.getElementById('wiki-assist-input')
      if (input) { input.value = btn.dataset.example; input.focus() }
    })
  )

  // Photo upload
  document.getElementById('wiki-photo-input')?.addEventListener('change', e => {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = ev => {
      const dataUrl = ev.target.result
      _photoBase64 = dataUrl.split(',')[1]
      const preview = document.getElementById('wiki-photo-preview')
      const img = document.getElementById('wiki-photo-img')
      if (preview && img) { img.src = dataUrl; preview.style.display = 'flex' }
    }
    reader.readAsDataURL(file)
  })
  document.getElementById('wiki-photo-clear')?.addEventListener('click', () => {
    _photoBase64 = null
    const preview = document.getElementById('wiki-photo-preview')
    if (preview) preview.style.display = 'none'
  })

  // Generate diagram from AI response query
  _el.querySelectorAll('.wiki-assist-diagram').forEach(btn =>
    btn.addEventListener('click', () => generateDiagramFromQuery(btn.dataset.query))
  )

  // "Схема AI" chip — prompt user inline for a wiring description
  document.getElementById('wiki-gen-diagram-btn')?.addEventListener('click', () => {
    const input = document.getElementById('wiki-assist-input')
    if (!input) return
    const placeholder = 'Опишите подключение, например: wiegand reader к ICT WX…'
    input.value = ''
    input.placeholder = placeholder
    input.focus()
    input.dataset.genDiagram = '1'
  })

  // Save to wiki from assistant — docLinks go to metadata ONLY, not into content
  _el.querySelectorAll('.wiki-assist-save').forEach(btn =>
    btn.addEventListener('click', () => {
      const content = btn.dataset.content || ''
      const query = btn.dataset.query || ''
      let docLinks = []
      try { docLinks = JSON.parse(btn.dataset.docLinks || '[]') } catch {}

      openEditModal(null, {
        title: query || 'Документ из AI',
        content,
        pageType: 'equipment',
        category: 'Оборудование',
        metadata: { docLinks, aiGenerated: true },
      })
    })
  )

  // Wiki hint: click a page to open it
  _el.querySelectorAll('.wiki-hint-page[data-id]').forEach(el =>
    el.addEventListener('click', () => {
      _selectedId = el.dataset.id
      _section = 'library'
      render()
    })
  )
}

// ── Mount / Unmount ───────────────────────────────────────────────────────
export async function mount() {
  _el = document.querySelector('[data-view="wiki"]')
  if (!_el) return unmount

  _el.innerHTML = loadingSpinner('Загрузка базы знаний…')
  _selectedId = null
  _searchQ = ''
  _filterType = 'all'
  _filterCat = 'all'
  _searchResults = null
  _analytics = null

  try {
    await loadPages()
    render()
  } catch (err) {
    _el.innerHTML = emptyState({ icon: 'ti-alert-circle', title: 'Ошибка', message: err.message })
  }
  return unmount
}

export function unmount() { _el = null; _assistantHistory = [] }
