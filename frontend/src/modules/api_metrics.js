/**
 * API Metrics module — live server health & performance monitoring.
 * Backend: GET /api/v1/admin/api-metrics
 */

import { apiJSON } from '../core/api.js'
import { esc } from '../components/ui.js'

let _el = null
let _data = null
let _refreshTimer = null
const REFRESH_MS = 10_000

export async function mount() {
  _el = document.querySelector('[data-view="api"]')
  if (!_el) return unmount
  render()
  await load()
  _refreshTimer = setInterval(load, REFRESH_MS)
  return unmount
}

function unmount() {
  clearInterval(_refreshTimer)
  _refreshTimer = null
  _el = null
}

async function load() {
  try {
    const d = await apiJSON('/api/v1/admin/api-metrics')
    _data = d.metrics || null
  } catch {
    _data = null
  }
  render()
}

// ── Helpers ───────────────────────────────────────────────────────────────

function fmtMs(ms) {
  if (ms == null) return '—'
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(2)}s`
}

function fmtBytes(b) {
  if (!b) return '—'
  if (b < 1024) return `${b}B`
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)}KB`
  return `${(b / 1024 / 1024).toFixed(2)}MB`
}

function relTime(iso) {
  if (!iso) return ''
  const diff = Math.floor((Date.now() - new Date(iso)) / 1000)
  if (diff < 60) return `${diff}s ago`
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
  return `${Math.floor(diff / 3600)}h ago`
}

function statusColor(s) {
  if (s >= 500) return 'var(--red)'
  if (s >= 400) return 'var(--amber)'
  if (s >= 300) return 'var(--text-4)'
  return 'var(--green)'
}

function latencyColor(ms) {
  if (ms > 1000) return 'var(--red)'
  if (ms > 300) return 'var(--amber)'
  return 'var(--green)'
}

function methodBadge(m) {
  const cls = { GET: 'apm-method--get', POST: 'apm-method--post', PUT: 'apm-method--put', DELETE: 'apm-method--del', PATCH: 'apm-method--patch' }
  return `<span class="apm-method ${cls[m] || ''}">${esc(m)}</span>`
}

// ── Render ────────────────────────────────────────────────────────────────

function render() {
  if (!_el) return
  const m = _data

  if (!m) {
    _el.innerHTML = `
      <div class="apm-shell">
        <div class="apm-header">
          <div>
            <h1 class="apm-title"><i class="ti ti-activity"></i> API Monitor</h1>
            <p class="apm-sub">Server health &amp; request metrics</p>
          </div>
        </div>
        <div class="apm-empty"><i class="ti ti-wifi-off"></i><p>Нет данных — ожидание сервера…</p></div>
      </div>`
    return
  }

  const updatedAgo = relTime(m.updatedAt)

  _el.innerHTML = `
    <div class="apm-shell">
      <div class="apm-header">
        <div>
          <h1 class="apm-title"><i class="ti ti-activity"></i> API Monitor</h1>
          <p class="apm-sub">${m.requestCount} запросов · обновлено ${updatedAgo} · авто-обновление ${REFRESH_MS / 1000}s</p>
        </div>
        <button class="apm-refresh-btn" id="apm-refresh" title="Обновить"><i class="ti ti-refresh"></i></button>
      </div>

      <!-- SLOs -->
      <div class="apm-slos">
        ${(m.slos || []).map(s => `
          <div class="apm-slo ${s.ok ? 'apm-slo--ok' : 'apm-slo--fail'}">
            <div class="apm-slo-icon"><i class="ti ${s.ok ? 'ti-circle-check' : 'ti-alert-triangle'}"></i></div>
            <div>
              <div class="apm-slo-name">${esc(s.name)}</div>
              <div class="apm-slo-val">${esc(s.current)} <span class="apm-slo-target">цель ${esc(s.target)}</span></div>
            </div>
          </div>`).join('')}
      </div>

      <!-- KPI cards -->
      <div class="apm-kpi-row">
        <div class="apm-kpi">
          <div class="apm-kpi-label">Всего запросов</div>
          <div class="apm-kpi-value">${m.requestCount.toLocaleString('ru-RU')}</div>
        </div>
        <div class="apm-kpi">
          <div class="apm-kpi-label">Avg latency</div>
          <div class="apm-kpi-value" style="color:${latencyColor(m.averageMs)}">${fmtMs(m.averageMs)}</div>
        </div>
        <div class="apm-kpi">
          <div class="apm-kpi-label">P95 latency</div>
          <div class="apm-kpi-value" style="color:${latencyColor(m.p95Ms)}">${fmtMs(m.p95Ms)}</div>
        </div>
        <div class="apm-kpi">
          <div class="apm-kpi-label">Ошибки</div>
          <div class="apm-kpi-value" style="color:${m.errorRate > 1 ? 'var(--red)' : m.errorRate > 0 ? 'var(--amber)' : 'var(--green)'}">
            ${m.errorCount} (${m.errorRate.toFixed(1)}%)
          </div>
        </div>
        <div class="apm-kpi">
          <div class="apm-kpi-label">Доступность</div>
          <div class="apm-kpi-value" style="color:${m.availability >= 99.5 ? 'var(--green)' : 'var(--red)'}">
            ${m.availability.toFixed(1)}%
          </div>
        </div>
      </div>

      <!-- Charts row: status codes + methods + top routes -->
      <div class="apm-row-3">
        <div class="apm-card">
          <div class="apm-card-title">Статус коды</div>
          ${Object.entries(m.statusCounts || {}).sort((a, b) => Number(a[0]) - Number(b[0])).map(([code, cnt]) => `
            <div class="apm-bar-row">
              <span class="apm-bar-label" style="color:${statusColor(Number(code))};font-weight:600">${code}</span>
              <div class="apm-bar-wrap">
                <div class="apm-bar" style="width:${Math.max(4, Math.min(100, cnt / m.requestCount * 100))}%;background:${statusColor(Number(code))}"></div>
              </div>
              <span class="apm-bar-count">${cnt}</span>
            </div>`).join('') || '<p class="apm-none">Нет данных</p>'}
        </div>

        <div class="apm-card">
          <div class="apm-card-title">Методы</div>
          ${Object.entries(m.methodCounts || {}).sort((a, b) => b[1] - a[1]).map(([method, cnt]) => `
            <div class="apm-bar-row">
              ${methodBadge(method)}
              <div class="apm-bar-wrap">
                <div class="apm-bar" style="width:${Math.max(4, Math.min(100, cnt / m.requestCount * 100))}%;background:var(--accent)"></div>
              </div>
              <span class="apm-bar-count">${cnt}</span>
            </div>`).join('') || '<p class="apm-none">Нет данных</p>'}
        </div>

        <div class="apm-card">
          <div class="apm-card-title">Топ маршруты</div>
          ${(m.topRoutes || []).slice(0, 8).map(r => `
            <div class="apm-bar-row">
              <span class="apm-bar-label apm-route-label" title="${esc(r.route)}">${esc(r.route.replace('/api/v1/', ''))}</span>
              <div class="apm-bar-wrap">
                <div class="apm-bar" style="width:${Math.max(4, Math.min(100, r.count / m.requestCount * 100))}%;background:var(--accent)"></div>
              </div>
              <span class="apm-bar-count">${r.count}</span>
            </div>`).join('') || '<p class="apm-none">Нет данных</p>'}
        </div>
      </div>

      <!-- Recent requests table -->
      <div class="apm-card apm-card--full">
        <div class="apm-card-title">
          Последние запросы
          <span class="apm-retention">буфер ${m.retention || 500}</span>
        </div>
        <div style="overflow-x:auto">
          <table class="data-table apm-table">
            <thead>
              <tr>
                <th>Время</th>
                <th>Метод</th>
                <th>Маршрут</th>
                <th style="text-align:right">Статус</th>
                <th style="text-align:right">Время</th>
                <th style="text-align:right">Размер</th>
              </tr>
            </thead>
            <tbody>
              ${(m.recent || []).slice().reverse().slice(0, 40).map(r => `
                <tr>
                  <td class="apm-td-time">${relTime(r.createdAt)}</td>
                  <td>${methodBadge(r.method)}</td>
                  <td class="apm-td-route">${esc(r.route)}</td>
                  <td style="text-align:right;color:${statusColor(r.status)};font-weight:600">${r.status}</td>
                  <td style="text-align:right;color:${latencyColor(r.durationMs)}">${fmtMs(r.durationMs)}</td>
                  <td style="text-align:right;color:var(--text-4)">${fmtBytes(r.responseBytes)}</td>
                </tr>`).join('')}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  `

  _el.querySelector('#apm-refresh')?.addEventListener('click', load)
}
