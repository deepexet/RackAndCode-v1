/**
 * Shared UI primitives for RackPilot SPA.
 *
 * All functions return HTML strings unless otherwise noted.
 * DOM-modifying functions (modal) are clearly marked.
 * Import only what you need — tree-shaking keeps bundles lean.
 */

// ── Escaping & formatting ─────────────────────────────────────────────────

export function esc(str) {
  return String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

export function timeAgo(dateStr) {
  if (!dateStr) return '—'
  const diff = Date.now() - new Date(dateStr).getTime()
  const s = Math.floor(diff / 1000)
  if (s < 60)  return 'только что'
  const m = Math.floor(s / 60)
  if (m < 60)  return `${m} мин назад`
  const h = Math.floor(m / 60)
  if (h < 24)  return `${h} ч назад`
  const d = Math.floor(h / 24)
  if (d < 30)  return `${d} д назад`
  return new Date(dateStr).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })
}

export function fmtDate(dateStr, opts = {}) {
  if (!dateStr) return '—'
  const d = new Date(dateStr)
  if (isNaN(d)) return '—'
  return d.toLocaleString('ru-RU', {
    day: '2-digit', month: '2-digit', year: '2-digit',
    hour: '2-digit', minute: '2-digit',
    ...opts
  })
}

export function fmtDateShort(dateStr) {
  if (!dateStr) return '—'
  return new Date(dateStr).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', year: 'numeric' })
}

// ── Status badges ─────────────────────────────────────────────────────────

const STATUS_COLORS = {
  active: 'green', planned: 'blue', archived: 'dim', done: 'green',
  progress: 'blue', ready: 'purple', backlog: 'dim', blocked: 'red',
  review: 'amber', testing: 'amber', ideas: 'dim',
  ok: 'green', error: 'red', warning: 'amber', info: 'blue',
  Administrator: 'purple', Manager: 'blue', Technician: 'green',
  Viewer: 'dim', critical: 'red', high: 'amber', medium: 'blue', low: 'dim',
}

export function badge(text, colorOverride = null) {
  const color = colorOverride || STATUS_COLORS[text] || 'dim'
  return `<span class="ui-badge ui-badge--${color}">${esc(text)}</span>`
}

// ── Loading & empty states ────────────────────────────────────────────────

export function skeleton(rows = 4) {
  return `<div class="ui-skeleton">${Array.from({ length: rows }, () =>
    `<div class="ui-skel-row"><div class="ui-skel-line" style="width:${60 + Math.random() * 30 | 0}%"></div></div>`
  ).join('')}</div>`
}

export function emptyState({ icon = 'ti-inbox', title = 'Ничего нет', message = '', action = '' } = {}) {
  return `<div class="ui-empty">
    <i class="ti ${esc(icon)}"></i>
    <span class="ui-empty-title">${esc(title)}</span>
    ${message ? `<span class="ui-empty-msg">${esc(message)}</span>` : ''}
    ${action}
  </div>`
}

export function loadingSpinner(text = 'Загрузка…') {
  return `<div class="ui-loading"><i class="ti ti-loader-2"></i> ${esc(text)}</div>`
}

// ── Toolbar ───────────────────────────────────────────────────────────────

export function toolbar({ back = null, onBack = '', title = '', subtitle = '', actions = '' } = {}) {
  return `<div class="ui-toolbar">
    <div class="ui-toolbar-left">
      ${back ? `<button class="ui-back-btn" data-action="back">${back === true ? '<i class="ti ti-arrow-left"></i>' : `<i class="ti ti-arrow-left"></i> ${esc(back)}`}</button>` : ''}
      <div class="ui-toolbar-title-group">
        ${title ? `<h2 class="ui-toolbar-title">${esc(title)}</h2>` : ''}
        ${subtitle ? `<span class="ui-toolbar-subtitle">${esc(subtitle)}</span>` : ''}
      </div>
    </div>
    ${actions ? `<div class="ui-toolbar-right">${actions}</div>` : ''}
  </div>`
}

// ── Tab bar ───────────────────────────────────────────────────────────────

export function tabBar(tabs, activeId) {
  return `<div class="ui-tabs" role="tablist">
    ${tabs.map(t => `
      <button class="ui-tab ${t.id === activeId ? 'active' : ''}" data-tab="${esc(t.id)}" role="tab"
              aria-selected="${t.id === activeId}" ${t.disabled ? 'disabled' : ''}>
        ${t.icon ? `<i class="ti ${esc(t.icon)}"></i>` : ''}
        ${esc(t.label)}
        ${t.count != null ? `<span class="ui-tab-count">${t.count}</span>` : ''}
      </button>`).join('')}
  </div>`
}

// ── Data table ────────────────────────────────────────────────────────────

export function table({ columns, rows, onRowClick = false, emptyText = 'Нет данных', emptyIcon = 'ti-table-off' }) {
  if (!rows.length) return emptyState({ icon: emptyIcon, title: emptyText })
  const clickable = onRowClick ? 'ui-table--clickable' : ''
  return `<div class="ui-table-wrap">
    <table class="ui-table ${clickable}">
      <thead><tr>${columns.map(c =>
        `<th class="${c.cls || ''}" style="${c.width ? `width:${c.width}` : ''}">${esc(c.label)}</th>`
      ).join('')}</tr></thead>
      <tbody>${rows.map((row, i) => `
        <tr data-row="${i}" ${onRowClick ? 'role="button" tabindex="0"' : ''}>
          ${columns.map(c => `<td class="${c.cls || ''}">${c.render ? c.render(row) : esc(row[c.key] ?? '')}</td>`).join('')}
        </tr>`).join('')}
      </tbody>
    </table>
  </div>`
}

// ── Key-value detail rows ─────────────────────────────────────────────────

export function kvList(items) {
  return `<dl class="ui-kv-list">${items.map(([k, v]) =>
    `<div class="ui-kv-row"><dt>${esc(k)}</dt><dd>${v}</dd></div>`
  ).join('')}</dl>`
}

// ── Section card ─────────────────────────────────────────────────────────

export function card({ title = '', subtitle = '', body = '', footer = '', cls = '' } = {}) {
  return `<div class="ui-card ${esc(cls)}">
    ${title || subtitle ? `<div class="ui-card-header">
      ${title ? `<h3 class="ui-card-title">${esc(title)}</h3>` : ''}
      ${subtitle ? `<span class="ui-card-subtitle">${esc(subtitle)}</span>` : ''}
    </div>` : ''}
    ${body ? `<div class="ui-card-body">${body}</div>` : ''}
    ${footer ? `<div class="ui-card-footer">${footer}</div>` : ''}
  </div>`
}

// ── Grid of stat cards ────────────────────────────────────────────────────

export function statCards(stats) {
  return `<div class="ui-stat-grid">${stats.map(s => `
    <div class="ui-stat-card">
      <i class="ti ${esc(s.icon || 'ti-chart-bar')} ui-stat-icon" style="${s.color ? `color:${esc(s.color)}` : ''}"></i>
      <div class="ui-stat-value">${esc(String(s.value))}</div>
      <div class="ui-stat-label">${esc(s.label)}</div>
    </div>`).join('')}</div>`
}

// ── Search / filter bar ───────────────────────────────────────────────────

export function filterBar({ placeholder = 'Поиск…', value = '', selects = [] } = {}) {
  return `<div class="ui-filter-bar">
    <div class="ui-filter-search">
      <i class="ti ti-search"></i>
      <input class="ui-filter-input" type="search" placeholder="${esc(placeholder)}" value="${esc(value)}" data-filter="q">
    </div>
    ${selects.map(s => `
      <select class="ui-filter-select" data-filter="${esc(s.key)}">
        ${s.options.map(o => `<option value="${esc(o.value)}" ${o.value === s.value ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}
      </select>`).join('')}
  </div>`
}

// ── Markdown renderer (safe, internal content only) ───────────────────────

export function renderMarkdown(text) {
  if (!text) return ''
  let html = esc(text)
    // Un-escape for markdown processing (we already escaped the original)
  html = text
  // Code blocks
  html = html.replace(/```[\w]*\n?([\s\S]*?)```/g, (_, code) =>
    `<pre class="md-pre"><code>${esc(code.trim())}</code></pre>`)
  // Inline code
  html = html.replace(/`([^`]+)`/g, (_, code) => `<code class="md-code">${esc(code)}</code>`)
  // Headers
  html = html.replace(/^#### (.+)$/gm, '<h4 class="md-h4">$1</h4>')
  html = html.replace(/^### (.+)$/gm, '<h3 class="md-h3">$1</h3>')
  html = html.replace(/^## (.+)$/gm, '<h2 class="md-h2">$1</h2>')
  html = html.replace(/^# (.+)$/gm, '<h1 class="md-h1">$1</h1>')
  // Bold & italic
  html = html.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>')
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
  html = html.replace(/\*([^*\n]+?)\*/g, '<em>$1</em>')
  // Unordered lists
  html = html.replace(/((?:^[-*] .+\n?)+)/gm, (block) => {
    const items = block.trim().split('\n').map(l => `<li>${l.replace(/^[-*] /, '')}</li>`).join('')
    return `<ul class="md-ul">${items}</ul>`
  })
  // Ordered lists
  html = html.replace(/((?:^\d+\. .+\n?)+)/gm, (block) => {
    const items = block.trim().split('\n').map(l => `<li>${l.replace(/^\d+\. /, '')}</li>`).join('')
    return `<ol class="md-ol">${items}</ol>`
  })
  // Horizontal rule
  html = html.replace(/^---$/gm, '<hr class="md-hr">')
  // Paragraphs (double newline)
  html = html.replace(/\n\n((?!<[huo]|<p|<pre|<hr).+)/g, '\n\n<p>$1</p>')
  // Line breaks
  html = html.replace(/\n(?!<)/g, '<br>')
  return html
}

// ── Modal (DOM operation — returns {el, close}) ───────────────────────────

export function openModal({ title = '', body = '', footer = '', width = 520, onClose = null } = {}) {
  const overlay = document.createElement('div')
  overlay.className = 'ui-modal-overlay'
  overlay.innerHTML = `
    <div class="ui-modal" style="max-width:${width}px" role="dialog" aria-modal="true">
      <div class="ui-modal-header">
        <h3 class="ui-modal-title">${esc(title)}</h3>
        <button class="ui-modal-close" aria-label="Закрыть"><i class="ti ti-x"></i></button>
      </div>
      <div class="ui-modal-body">${body}</div>
      ${footer ? `<div class="ui-modal-footer">${footer}</div>` : ''}
    </div>`

  const close = () => {
    overlay.classList.remove('visible')
    setTimeout(() => overlay.remove(), 180)
    onClose?.()
  }

  overlay.querySelector('.ui-modal-close').addEventListener('click', close)
  overlay.addEventListener('click', e => { if (e.target === overlay) close() })
  document.addEventListener('keydown', function onEsc(e) {
    if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onEsc) }
  })

  document.body.appendChild(overlay)
  requestAnimationFrame(() => overlay.classList.add('visible'))

  return { el: overlay, close }
}
