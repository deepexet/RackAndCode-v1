/**
 * Admin module — platform settings, team, work types, audit, API metrics.
 */

import { apiJSON, apiPost } from '../core/api.js'
import {
  esc, fmtDate, timeAgo, badge, loadingSpinner,
  toolbar, tabBar, table, kvList, statCards, openModal,
} from '../components/ui.js'

let _el = null
let _tab = 'settings'
let _data = {}

const TABS = [
  { id: 'settings',  label: 'Настройки',  icon: 'ti-settings' },
  { id: 'team',      label: 'Команда',    icon: 'ti-users' },
  { id: 'worktypes', label: 'Типы работ', icon: 'ti-tool' },
  { id: 'audit',     label: 'Аудит',      icon: 'ti-shield-check' },
  { id: 'metrics',   label: 'Метрики',    icon: 'ti-chart-bar' },
  { id: 'system',    label: 'Система',    icon: 'ti-cpu' },
  { id: 'agents',    label: 'Agents',      icon: 'ti-robot' },
]

// ── Data ─────────────────────────────────────────────────────────────────

async function load(tab) {
  if (_data[tab]) return _data[tab]
  let d
  switch (tab) {
    case 'settings':  d = await apiJSON('/api/v1/admin/platform-settings'); break
    case 'team':      d = await apiJSON('/api/v1/team'); break
    case 'worktypes': d = await apiJSON('/api/v1/admin/work-types'); break
    case 'audit':     d = await apiJSON('/api/v1/admin/audit-log'); break
    case 'metrics':   d = await apiJSON('/api/v1/admin/api-metrics'); break
    case 'system':    d = await apiJSON('/api/v1/admin/system-stats'); break
    case 'agents':    d = await apiJSON('/api/v1/admin/coordinator'); break
  }
  _data[tab] = d
  return d
}

// ── Tab renderers ─────────────────────────────────────────────────────────

function renderSettings(d) {
  const s = d.settings || {}
  return `
    <div class="adm-section">
      <div class="adm-section-header">
        <h3>Настройки платформы</h3>
        <button class="ui-btn ui-btn--sm" id="adm-edit-settings">
          <i class="ti ti-edit"></i> Редактировать
        </button>
      </div>
      ${kvList([
        ['Язык',              esc(s.defaultLanguage || '—')],
        ['Часовой пояс',      esc(s.timezone || '—')],
        ['Режим ролей',       badge(s.roleMode || '—')],
        ['Телеметрия',        esc(s.telemetryMode || '—')],
        ['Хранение логов',    `${s.logRetentionDays || '—'} дней`],
        ['Обновлено',         fmtDate(s.updatedAt)],
      ])}`
}

function renderTeam(d) {
  const members = d.members || []
  return `
    <div class="adm-section">
      <div class="adm-section-header">
        <h3>Команда <span class="ui-count">${members.length}</span></h3>
      </div>
      ${table({
        columns: [
          { label: 'Имя',       render: r => `<strong>${esc(r.name || '—')}</strong>` },
          { label: 'Email',     render: r => `<span class="ui-mono">${esc(r.email || '—')}</span>` },
          { label: 'Роль',      render: r => badge(r.role || '—') },
          { label: 'Профессия', render: r => esc(r.trade || '—') },
          { label: 'Телефон',   render: r => esc(r.phone || '—') },
        ],
        rows: members,
        emptyText: 'Нет участников', emptyIcon: 'ti-users-off',
      })}`
}

function renderWorkTypes(d) {
  const wts = d.workTypes || []
  return `
    <div class="adm-section">
      <div class="adm-section-header">
        <h3>Типы работ <span class="ui-count">${wts.length}</span></h3>
      </div>
      <div class="adm-wt-grid">
        ${wts.map(wt => `
          <div class="adm-wt-card">
            <div class="adm-wt-top">
              <span class="adm-wt-dot" style="background:${esc(wt.color)}"></span>
              <span class="adm-wt-name">${esc(wt.name)}</span>
              <span class="adm-wt-code">${esc(wt.code)}</span>
            </div>
            <div class="adm-wt-actions">
              ${(wt.actions || []).map(a =>
                `<span class="adm-wt-action"><i class="ti ti-arrow-right"></i> ${esc(a.name)}</span>`
              ).join('')}
            </div>
          </div>`).join('')}
      </div>
    </div>`
}

function renderAudit(d) {
  const entries = d.entries || []
  const ICON = {
    dev_login: 'ti-bolt', login: 'ti-login', logout: 'ti-logout',
    mfa_verify: 'ti-device-mobile', failed_login: 'ti-alert-triangle',
  }
  return `
    <div class="adm-section">
      <div class="adm-section-header">
        <h3>Журнал безопасности <span class="ui-count">${entries.length}</span></h3>
      </div>
      ${table({
        columns: [
          { label: '', width: '40px', render: r =>
              `<i class="ti ${ICON[r.action] || 'ti-activity'} adm-audit-ico"></i>` },
          { label: 'Действие',  render: r => `<span class="ui-mono">${esc(r.action)}</span>` },
          { label: 'Актор',     render: r => esc(r.actor_id || '—') },
          { label: 'Роль',      render: r => badge(r.actor_role || '—') },
          { label: 'Объект',    render: r => r.target_type
              ? `<span class="ui-mono ui-dim">${esc(r.target_type)}</span>` : '—' },
          { label: 'Статус',    render: r => badge(r.outcome || '—') },
          { label: 'IP',        render: r => `<span class="ui-mono ui-dim">${esc(r.ip || '—')}</span>` },
          { label: 'Время',     render: r =>
              `<span title="${esc(r.created_at)}">${timeAgo(r.created_at)}</span>` },
        ],
        rows: entries,
        emptyText: 'Нет записей', emptyIcon: 'ti-shield-off',
      })}`
}

function renderMetrics(d) {
  const m = d.metrics || {}
  const routes = m.routes || []
  const sum = m.summary || {}
  return `
    <div class="adm-section">
      <div class="adm-section-header"><h3>Производительность API</h3></div>
      ${statCards([
        { icon: 'ti-arrows-exchange', label: 'Запросов',   value: sum.totalRequests ?? '—',           color: 'var(--blue)' },
        { icon: 'ti-clock',           label: 'Сред. мс',   value: sum.avgDurationMs?.toFixed(1) ?? '—', color: 'var(--accent)' },
        { icon: 'ti-alert-circle',    label: '5xx ошибок', value: sum.errorCount5xx ?? '—',           color: 'var(--red)' },
        { icon: 'ti-activity',        label: '4xx ошибок', value: sum.errorCount4xx ?? '—',           color: 'var(--amber)' },
      ])}
      ${table({
        columns: [
          { label: 'Метод',  width: '72px', render: r =>
              `<span class="adm-method adm-method--${(r.method||'get').toLowerCase()}">${esc(r.method||'')}</span>` },
          { label: 'Маршрут', render: r => `<span class="ui-mono">${esc(r.route || r.path || '—')}</span>` },
          { label: 'Запросов', width: '90px', render: r => esc(String(r.count ?? '—')) },
          { label: 'Сред. мс', width: '100px', render: r => {
              const v = r.avgMs ?? r.avg_duration_ms ?? 0
              const cls = v > 500 ? 'adm-slow' : v > 200 ? 'adm-med' : ''
              return `<span class="${cls}">${typeof v === 'number' ? v.toFixed(1) : v}</span>`
            }},
          { label: 'P95 мс', width: '90px', render: r => {
              const v = r.p95Ms ?? r.p95_duration_ms ?? 0
              return typeof v === 'number' ? v.toFixed(1) : v
            }},
          { label: 'Ошибок', width: '80px', render: r => {
              const n = r.errorCount ?? r.error_count ?? 0
              return n > 0 ? `<span class="adm-slow">${n}</span>` : '0'
            }},
        ],
        rows: routes.slice(0, 50),
        emptyText: 'Нет метрик', emptyIcon: 'ti-chart-off',
      })}`
}

function renderSystem(d) {
  if (d.error) return `<div class="ui-empty"><i class="ti ti-alert-circle"></i><span>Ошибка: ${esc(d.error)}</span></div>`
  const bat = d.battery || {}
  const fmtB = b => b >= 1073741824 ? (b/1073741824).toFixed(1)+'GB' : b >= 1048576 ? (b/1048576).toFixed(0)+'MB' : (b/1024).toFixed(0)+'KB'
  const fmtTime = s => { if (s < 0) return '—'; const h = Math.floor(s/3600), m = Math.floor((s%3600)/60); return `${h}h ${m}m` }
  const pctBar = (pct, color='var(--blue)') =>
    `<div style="background:var(--bg-4);border-radius:4px;height:8px;overflow:hidden;margin-top:4px">
      <div style="width:${pct}%;height:100%;background:${color};border-radius:4px;transition:width .6s"></div>
    </div>`
  const batColor = bat.percent < 20 ? 'var(--red)' : bat.percent < 40 ? 'var(--amber)' : 'var(--green)'

  return `
    <div class="adm-section">
      <div class="adm-section-header">
        <h3><i class="ti ti-cpu"></i> Мониторинг системы</h3>
        <span class="ui-dim" style="font-size:12px">${esc(d.hostname || '')} · ${esc(d.platform || '')}</span>
        <button class="ui-btn ui-btn--sm" id="adm-sys-refresh"><i class="ti ti-refresh"></i> Обновить</button>
      </div>

      <div class="adm-sys-grid">
        <div class="adm-sys-card">
          <div class="adm-sys-label"><i class="ti ti-cpu"></i> CPU</div>
          <div class="adm-sys-val">${d.cpu?.percent ?? '—'}%</div>
          <div class="adm-sys-sub">${d.cpu?.count ?? '—'} ядер</div>
          ${pctBar(d.cpu?.percent ?? 0)}
        </div>

        <div class="adm-sys-card">
          <div class="adm-sys-label"><i class="ti ti-database"></i> Память</div>
          <div class="adm-sys-val">${d.memory ? fmtB(d.memory.usedBytes) : '—'}</div>
          <div class="adm-sys-sub">${d.memory?.percent ?? '—'}% из ${d.memory ? fmtB(d.memory.totalBytes) : '—'}</div>
          ${pctBar(d.memory?.percent ?? 0, 'var(--accent)')}
        </div>

        <div class="adm-sys-card">
          <div class="adm-sys-label"><i class="ti ti-device-sd-card"></i> Диск</div>
          <div class="adm-sys-val">${d.disk ? fmtB(d.disk.usedBytes) : '—'}</div>
          <div class="adm-sys-sub">${d.disk?.percent ?? '—'}% из ${d.disk ? fmtB(d.disk.totalBytes) : '—'}</div>
          ${pctBar(d.disk?.percent ?? 0, 'var(--amber)')}
        </div>

        <div class="adm-sys-card">
          <div class="adm-sys-label"><i class="ti ${bat.plugged ? 'ti-battery-charging-2' : 'ti-battery-2'}"></i> Батарея</div>
          <div class="adm-sys-val" style="color:${batColor}">${bat.percent ?? '—'}%</div>
          <div class="adm-sys-sub">
            ${bat.plugged ? 'Подключено к сети' : `Осталось ${fmtTime(bat.secsLeft)}`}
            ${bat.voltageMv ? `· ${(bat.voltageMv/1000).toFixed(2)}V` : ''}
            ${bat.currentMa ? `· ${Math.abs(bat.currentMa)}mA` : ''}
          </div>
          ${pctBar(bat.percent ?? 0, batColor)}
        </div>
      </div>

      <div class="adm-section" style="margin-top:16px">
        <div class="adm-section-header"><h3>Детали батареи</h3></div>
        ${kvList([
          ['Заряд',         `${bat.percent ?? '—'}%`],
          ['Состояние',     bat.plugged ? 'Зарядка / Сеть' : 'Батарея'],
          ['Напряжение',    bat.voltageMv ? `${(bat.voltageMv/1000).toFixed(3)} V` : '—'],
          ['Ток',           bat.currentMa != null ? `${bat.currentMa} mA` : '—'],
          ['Циклы заряда',  bat.cycleCount ?? '—'],
          ['Ёмкость',       bat.maxCapacity != null && bat.designCapacity ? `${bat.maxCapacity} / ${bat.designCapacity} mAh` : '—'],
          ['Аптайм',        d.uptimeSeconds != null ? fmtTime(d.uptimeSeconds) : '—'],
        ])}
      </div>
    </div>`
}

function renderAgents(d) {
  const health = d.health || {}
  const agents = d.agents || []
  const jobs = d.jobs || []
  const worktrees = d.worktrees || []
  const running = jobs.filter(j => j.status === 'running').length
  const review = jobs.filter(j => ['review', 'waiting_approval'].includes(j.status)).length
  return `
    <div class="adm-section">
      <div class="adm-section-header">
        <h3><i class="ti ti-robot"></i> Agent Coordinator</h3>
        <span class="ui-dim" style="font-size:12px">Local control plane · ${esc(health.version || '—')}</span>
        <button class="ui-btn ui-btn--sm" id="adm-agents-refresh"><i class="ti ti-refresh"></i> Refresh</button>
      </div>
      ${statCards([
        { icon: 'ti-heartbeat', label: 'Service', value: health.status === 'ok' ? 'Online' : 'Offline', color: health.status === 'ok' ? 'var(--green)' : 'var(--red)' },
        { icon: 'ti-player-play', label: 'Running', value: running, color: 'var(--blue)' },
        { icon: 'ti-eye-check', label: 'Needs review', value: review, color: 'var(--amber)' },
        { icon: 'ti-git-branch', label: 'Worktrees', value: worktrees.length, color: 'var(--accent)' },
      ])}
      <div class="adm-section-header" style="margin-top:18px"><h3>Installed agents</h3></div>
      ${table({
        columns: [
          { label: 'Agent', render: r => `<strong>${esc(r.agent)}</strong>` },
          { label: 'Status', render: r => badge(r.available ? 'available' : 'unavailable') },
          { label: 'Version', render: r => `<span class="ui-mono">${esc(r.version || '—')}</span>` },
          { label: 'Executable', render: r => `<span class="ui-mono ui-dim">${esc(r.executable || '—')}</span>` },
        ],
        rows: agents,
        emptyText: 'No agent CLIs detected', emptyIcon: 'ti-robot-off',
      })}
      <div class="adm-section-header" style="margin-top:18px"><h3>Recent jobs <span class="ui-count">${jobs.length}</span></h3></div>
      ${table({
        columns: [
          { label: 'Task', render: r => `<strong>${esc(r.title)}</strong><br><span class="ui-mono ui-dim">${esc(r.branchName)}</span>` },
          { label: 'Agent', render: r => esc(r.assignedAgent) },
          { label: 'Status', render: r => badge(r.status) },
          { label: 'Created', render: r => timeAgo(r.createdAt) },
        ],
        rows: jobs,
        emptyText: 'No coordinator jobs yet', emptyIcon: 'ti-list-check',
      })}
      <p class="ui-dim" style="margin-top:14px;font-size:12px">
        Autonomous execution: <strong>${health.executionEnabled ? 'enabled' : 'disabled'}</strong> ·
        Control token: <strong>${health.controlConfigured ? 'configured' : 'not configured'}</strong>.
        Write controls remain hidden until authenticated RBAC and approval gates are verified.
      </p>
    </div>`
}

// ── Render & navigation ───────────────────────────────────────────────────

function render() {
  if (!_el) return
  _el.innerHTML = `
    ${toolbar({ title: 'Admin' })}
    ${tabBar(TABS, _tab)}
    <div id="adm-body" class="adm-body">${loadingSpinner()}</div>`

  _el.querySelectorAll('[data-tab]').forEach(btn =>
    btn.addEventListener('click', () => { _tab = btn.dataset.tab; switchTab() })
  )
  switchTab()
}

async function switchTab() {
  const body = document.getElementById('adm-body')
  if (!body) return
  _el.querySelectorAll('[data-tab]').forEach(b => b.classList.toggle('active', b.dataset.tab === _tab))
  body.innerHTML = loadingSpinner()
  try {
    const d = await load(_tab)
    let html = ''
    switch (_tab) {
      case 'settings':  html = renderSettings(d);  break
      case 'team':      html = renderTeam(d);       break
      case 'worktypes': html = renderWorkTypes(d);  break
      case 'audit':     html = renderAudit(d);      break
      case 'metrics':   html = renderMetrics(d);    break
      case 'system':    html = renderSystem(d);     break
      case 'agents':    html = renderAgents(d);     break
    }
    body.innerHTML = html
    bindTabEvents()
  } catch (err) {
    body.innerHTML = `<div class="ui-empty"><i class="ti ti-alert-circle"></i><span>${esc(err.message)}</span></div>`
  }
}

function bindSystemRefresh() {
  document.getElementById('adm-sys-refresh')?.addEventListener('click', () => {
    delete _data.system
    switchTab()
  })
}

function bindTabEvents() {
  if (_tab === 'system') { bindSystemRefresh(); return }
  if (_tab === 'agents') {
    document.getElementById('adm-agents-refresh')?.addEventListener('click', () => {
      delete _data.agents
      switchTab()
    })
    return
  }
  document.getElementById('adm-edit-settings')?.addEventListener('click', () => {
    const s = _data.settings?.settings || {}
    const { close } = openModal({
      title: 'Настройки платформы',
      body: `<form class="ui-form" id="adm-settings-form">
        <div class="ui-form-row"><label>Язык</label>
          <select name="defaultLanguage" class="ui-input">
            <option value="ru" ${s.defaultLanguage === 'ru' ? 'selected' : ''}>Русский</option>
            <option value="en" ${s.defaultLanguage === 'en' ? 'selected' : ''}>English</option>
          </select></div>
        <div class="ui-form-row"><label>Часовой пояс</label>
          <input class="ui-input" name="timezone" value="${esc(s.timezone || '')}"></div>
        <div class="ui-form-row"><label>Хранение логов (дней)</label>
          <input class="ui-input" type="number" name="logRetentionDays" value="${s.logRetentionDays || 365}"></div>
      </form>`,
      footer: `<button class="ui-btn ui-btn--primary" id="adm-settings-save">Сохранить</button>
               <button class="ui-btn" id="adm-settings-cancel">Отмена</button>`,
    })
    document.getElementById('adm-settings-cancel')?.addEventListener('click', close)
    document.getElementById('adm-settings-save')?.addEventListener('click', async () => {
      const fd = Object.fromEntries(new FormData(document.getElementById('adm-settings-form')))
      fd.logRetentionDays = parseInt(fd.logRetentionDays, 10)
      try {
        await apiPost('/api/v1/admin/platform-settings', fd)
        delete _data.settings
        close()
        window.toast?.('Сохранено', 'success')
        switchTab()
      } catch (err) { window.toast?.(`Ошибка: ${err.message}`, 'error') }
    })
  })
}

// ── Mount / Unmount ───────────────────────────────────────────────────────

export async function mount() {
  _el = document.querySelector('[data-view="admin"]')
  if (!_el) return unmount
  _data = {}
  render()
  return unmount
}

export function unmount() { _el = null }
