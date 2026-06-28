/**
 * Docs module — Platform Guide (auto-documentation).
 *
 * Uses /api/v1/admin/feature-docs which contains 90 platform features
 * each with a markdown guide explaining what it is, why it exists, how to use it.
 *
 * Two sections:
 *   #docs        → Platform Guide (feature-docs)
 *   #wiki        → Project & Org Wiki (to be implemented with backend support)
 */

import { apiJSON } from '../core/api.js'
import { esc, badge, loadingSpinner, emptyState, renderMarkdown } from '../components/ui.js'

let _el = null
let _features = []
let _selectedId = null
let _searchQ = ''
let _filterArea = 'all'
let _filterStatus = 'all'

// ── Data ─────────────────────────────────────────────────────────────────

async function loadFeatures() {
  if (_features.length) return
  const d = await apiJSON('/api/v1/admin/feature-docs')
  _features = d.features || []
}

// ── Helpers ───────────────────────────────────────────────────────────────

const AREA_LABELS = {
  foundation:   'Фундамент',
  projects:     'Проекты',
  field:        'Полевые операции',
  intelligence: 'AI & Аналитика',
  platform:     'Платформа',
  security:     'Безопасность',
  ecosystem:    'Экосистема',
}

const STATUS_ICONS = {
  done: 'ti-circle-check', progress: 'ti-loader-2', planned: 'ti-circle-dashed',
  ideas: 'ti-bulb', backlog: 'ti-list',
}

function filteredFeatures() {
  let list = _features
  if (_filterArea !== 'all') list = list.filter(f => f.area === _filterArea)
  if (_filterStatus !== 'all') list = list.filter(f => f.status === _filterStatus)
  if (_searchQ) {
    const q = _searchQ.toLowerCase()
    list = list.filter(f =>
      f.title?.toLowerCase().includes(q) ||
      f.description?.toLowerCase().includes(q) ||
      f.area?.toLowerCase().includes(q)
    )
  }
  return list
}

function groupByArea(features) {
  const groups = {}
  for (const f of features) {
    const area = f.area || 'other'
    if (!groups[area]) groups[area] = []
    groups[area].push(f)
  }
  return groups
}

// ── Render ────────────────────────────────────────────────────────────────

function render() {
  if (!_el) return
  const features = filteredFeatures()
  const groups = groupByArea(features)
  const selected = _selectedId ? _features.find(f => f.id === _selectedId) : null

  const areas = [...new Set(_features.map(f => f.area).filter(Boolean))]
  const statuses = [...new Set(_features.map(f => f.status).filter(Boolean))]
  const totalDone = _features.filter(f => f.status === 'done').length

  _el.innerHTML = `
    <div class="docs-layout">
      <!-- Sidebar -->
      <aside class="docs-sidebar">
        <div class="docs-sidebar-header">
          <h3>Platform Guide</h3>
          <div class="docs-meta">${totalDone}/${_features.length} реализовано</div>
        </div>

        <div class="docs-search-wrap">
          <i class="ti ti-search docs-search-icon"></i>
          <input class="docs-search" type="search" placeholder="Поиск функций…"
                 value="${esc(_searchQ)}" id="docs-search">
        </div>

        <div class="docs-filters">
          <select class="docs-filter-select" id="docs-filter-area">
            <option value="all">Все разделы</option>
            ${areas.map(a => `<option value="${esc(a)}" ${_filterArea === a ? 'selected' : ''}>${esc(AREA_LABELS[a] || a)}</option>`).join('')}
          </select>
          <select class="docs-filter-select" id="docs-filter-status">
            <option value="all">Все статусы</option>
            ${statuses.map(s => `<option value="${esc(s)}" ${_filterStatus === s ? 'selected' : ''}>${esc(s)}</option>`).join('')}
          </select>
        </div>

        <nav class="docs-nav">
          ${!features.length
            ? `<div class="docs-nav-empty">Ничего не найдено</div>`
            : Object.entries(groups).map(([area, items]) => `
              <div class="docs-nav-group">
                <div class="docs-nav-area">${esc(AREA_LABELS[area] || area)}</div>
                ${items.map(f => `
                  <button class="docs-nav-item ${f.id === _selectedId ? 'active' : ''}"
                          data-id="${esc(f.id)}" title="${esc(f.title)}">
                    <i class="ti ${STATUS_ICONS[f.status] || 'ti-circle'} docs-nav-icon docs-status--${esc(f.status)}"></i>
                    <span class="docs-nav-title">${esc(f.title)}</span>
                  </button>`).join('')}
              </div>`).join('')}
        </nav>
      </aside>

      <!-- Content pane -->
      <main class="docs-content">
        ${selected ? renderFeature(selected) : renderWelcome()}
      </main>
    </div>`

  bindEvents()
}

function renderWelcome() {
  const done = _features.filter(f => f.status === 'done').length
  const inprog = _features.filter(f => f.status === 'progress').length
  const planned = _features.filter(f => f.status === 'planned' || f.status === 'backlog').length
  const areas = [...new Set(_features.map(f => f.area).filter(Boolean))]

  return `
    <div class="docs-welcome">
      <div class="docs-welcome-icon"><i class="ti ti-book-2"></i></div>
      <h1>RackPilot Platform Guide</h1>
      <p class="docs-welcome-sub">
        Полная документация платформы — каждая функция объяснена: что это, зачем нужно и как использовать.
      </p>

      <div class="docs-stats-row">
        <div class="docs-stat"><span class="docs-stat-n docs-stat--done">${done}</span><span>Реализовано</span></div>
        <div class="docs-stat"><span class="docs-stat-n docs-stat--prog">${inprog}</span><span>В разработке</span></div>
        <div class="docs-stat"><span class="docs-stat-n docs-stat--plan">${planned}</span><span>Запланировано</span></div>
        <div class="docs-stat"><span class="docs-stat-n">${_features.length}</span><span>Всего функций</span></div>
      </div>

      <div class="docs-area-grid">
        ${areas.map(area => {
          const items = _features.filter(f => f.area === area)
          const done = items.filter(f => f.status === 'done').length
          return `
            <button class="docs-area-card" data-filter-area="${esc(area)}">
              <div class="docs-area-name">${esc(AREA_LABELS[area] || area)}</div>
              <div class="docs-area-count">${done}/${items.length}</div>
              <div class="docs-area-bar">
                <div class="docs-area-bar-fill" style="width:${Math.round(done/items.length*100)}%"></div>
              </div>
            </button>`
        }).join('')}
      </div>

      <p class="docs-hint"><i class="ti ti-arrow-left"></i> Выберите функцию в боковом меню для просмотра документации</p>
    </div>`
}

function renderFeature(f) {
  const prevFeature = _features[_features.indexOf(f) - 1]
  const nextFeature = _features[_features.indexOf(f) + 1]
  const areaFeatures = _features.filter(x => x.area === f.area)
  const areaIdx = areaFeatures.indexOf(f)

  return `
    <div class="docs-feature">
      <div class="docs-feature-header">
        <div class="docs-feature-meta">
          <span class="docs-breadcrumb">${esc(AREA_LABELS[f.area] || f.area || '')}</span>
          <span class="docs-breadcrumb-sep">/</span>
          <span class="docs-feature-id">${esc(f.id)}</span>
        </div>
        <div class="docs-feature-badges">
          ${badge(f.status || '—')}
          ${badge(f.priority || '—')}
          ${f.type ? badge(f.type) : ''}
        </div>
      </div>

      <h1 class="docs-feature-title">${esc(f.title)}</h1>
      ${f.description ? `<p class="docs-feature-desc">${esc(f.description)}</p>` : ''}

      <div class="docs-feature-body">
        ${f.guide ? renderMarkdown(f.guide) : emptyState({ icon: 'ti-file-off', title: 'Гайд не написан' })}
      </div>

      <div class="docs-feature-nav">
        ${prevFeature
          ? `<button class="docs-feature-nav-btn" data-id="${esc(prevFeature.id)}">
               <i class="ti ti-arrow-left"></i> ${esc(prevFeature.title)}
             </button>` : '<span></span>'}
        <span class="docs-feature-pos">${areaIdx + 1} / ${areaFeatures.length}</span>
        ${nextFeature
          ? `<button class="docs-feature-nav-btn" data-id="${esc(nextFeature.id)}">
               ${esc(nextFeature.title)} <i class="ti ti-arrow-right"></i>
             </button>` : '<span></span>'}
      </div>
    </div>`
}

// ── Events ────────────────────────────────────────────────────────────────

function bindEvents() {
  let debounce
  document.getElementById('docs-search')?.addEventListener('input', e => {
    clearTimeout(debounce)
    debounce = setTimeout(() => { _searchQ = e.target.value; render() }, 180)
  })

  document.getElementById('docs-filter-area')?.addEventListener('change', e => {
    _filterArea = e.target.value; render()
  })
  document.getElementById('docs-filter-status')?.addEventListener('change', e => {
    _filterStatus = e.target.value; render()
  })

  _el.querySelectorAll('[data-id]').forEach(btn =>
    btn.addEventListener('click', () => {
      _selectedId = btn.dataset.id
      // Scroll content to top
      _el.querySelector('.docs-content')?.scrollTo(0, 0)
      render()
    })
  )

  _el.querySelectorAll('[data-filter-area]').forEach(btn =>
    btn.addEventListener('click', () => {
      _filterArea = btn.dataset.filterArea
      render()
    })
  )
}

// ── Mount / Unmount ───────────────────────────────────────────────────────

export async function mount() {
  _el = document.querySelector('[data-view="docs"]')
  if (!_el) return unmount

  _el.innerHTML = loadingSpinner('Загрузка документации…')
  _selectedId = null
  _searchQ = ''
  _filterArea = 'all'
  _filterStatus = 'all'

  await loadFeatures()
  render()
  return unmount
}

export function unmount() { _el = null }
