/**
 * RackPilot SPA — entry point.
 *
 * Initializes auth, router, and lazy-loads domain modules on navigation.
 */
import { router } from './core/router.js'
import { apiJSON, setSession, getSession, clearSession } from './core/api.js'
import { appState } from './core/store.js'
import { initCoordinatorChat } from './components/coordinator_chat.js'

// ── Auth bootstrap ────────────────────────────────────────────────────────

async function bootstrap() {
  const stored = getSession()
  if (stored?.token) {
    try {
      const me = await apiJSON('/api/v1/auth/me')
      setSession({ ...stored, ...me })
      appState.set({ session: getSession() })
      startApp()
      return
    } catch {
      clearSession()
    }
  }
  // Auto dev-login on LAN / localhost
  const isLocal = /^(localhost|127\.0\.0\.1|192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(location.hostname)
  if (isLocal) {
    try {
      const data = await apiJSON('/api/v1/auth/dev-login', { method: 'POST' })
      setSession(data)
      appState.set({ session: data })
      startApp()
      return
    } catch {}
  }
  showLoginModal()
}

function showLoginModal() {
  const modal = document.getElementById('loginModal')
  if (modal) modal.style.display = 'flex'
}

function hideLoginModal() {
  const modal = document.getElementById('loginModal')
  if (modal) modal.style.display = 'none'
}

async function finishLogin(data) {
  setSession(data)
  appState.set({ session: data })
  hideLoginModal()
  startApp()
}

// ── Login form ────────────────────────────────────────────────────────────

document.getElementById('loginForm')?.addEventListener('submit', async e => {
  e.preventDefault()
  const email = document.getElementById('loginEmail').value.trim()
  const password = document.getElementById('loginPassword').value
  const errEl = document.getElementById('loginError')
  const btn = e.target.querySelector('[type="submit"]')
  btn.disabled = true

  try {
    const data = await apiJSON('/api/v1/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    })
    await finishLogin(data)
  } catch (err) {
    if (errEl) { errEl.textContent = err.message; errEl.style.display = 'block' }
    btn.disabled = false
  }
})

// Dev login button
document.getElementById('devLoginBtn')?.addEventListener('click', async () => {
  const btn = document.getElementById('devLoginBtn')
  btn.disabled = true
  btn.innerHTML = '<i class="ti ti-loader-2"></i> Вход…'
  try {
    const data = await apiJSON('/api/v1/auth/dev-login', { method: 'POST' })
    await finishLogin(data)
  } catch (err) {
    const errEl = document.getElementById('loginError')
    if (errEl) { errEl.textContent = err.message; errEl.style.display = 'block' }
    btn.disabled = false
    btn.innerHTML = '<i class="ti ti-bolt"></i> Войти без пароля (dev)'
  }
})

window.addEventListener('rp:unauthorized', () => {
  clearSession()
  showLoginModal()
})

// ── Router setup (lazy modules) ───────────────────────────────────────────

function startApp() {
  // Show app shell, hide login
  const app = document.getElementById('app')
  const loginModal = document.getElementById('loginModal')
  if (app) app.style.display = 'flex'
  if (loginModal) loginModal.style.display = 'none'

  // Update sidebar user info
  const session = getSession()
  if (session) {
    const name = session.name || session.email || '?'
    const initials = name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase()
    const av = document.getElementById('sidebarAvatar')
    const nm = document.getElementById('sidebarName')
    const rl = document.getElementById('sidebarRole')
    if (av) av.textContent = initials
    if (nm) nm.textContent = name
    if (rl) rl.textContent = session.role || ''
  }

  // Register routes
  router
    .on('overview',     () => import('./modules/overview.js').then(m => m.mount()))
    .on('projects',     (params) => import('./modules/projects.js').then(m => m.mount(params)))
    .on('inventory',    () => import('./modules/inventory.js').then(m => m.mount()))
    .on('work-orders',  () => import('./modules/work_orders.js').then(m => m.mount()))
    .on('transport',    () => import('./modules/transport.js').then(m => m.mount()))
    .on('tech',         () => import('./modules/tech.js').then(m => m.mount()))
    .on('logs',         () => import('./modules/logs.js').then(m => m.mount()))
    .on('wiki',         () => import('./modules/wiki.js').then(m => m.mount()))
    .on('diagrams',     () => import('./modules/diagrams.js').then(m => m.mount()))
    .on('docs',         () => import('./modules/docs.js').then(m => m.mount()))
    .on('api',          () => import('./modules/api_metrics.js').then(m => m.mount()))
    .on('admin',        () => import('./modules/admin.js').then(m => m.mount()))

  // Update breadcrumb on route change
  window.addEventListener('rp:route', e => {
    const labels = {
      overview: 'Overview', projects: 'Projects', inventory: 'Inventory',
      'work-orders': 'Work orders', transport: 'Transport', tech: 'Field', logs: 'Logs',
      wiki: 'Wiki', diagrams: 'Схемы', docs: 'Platform Docs', admin: 'Admin',
    }
    const bc = document.getElementById('topbarBreadcrumb')
    if (bc) bc.innerHTML = `<span>${labels[e.detail.route] || e.detail.route}</span>`
  })

  // Command palette (⌘K)
  initCommandPalette()

  // Notification bell panel
  initNotifPanel()

  // Mobile "More" drawer
  initMobileDrawer()

  // System monitoring widget
  startSysWidget()

  // Development control surface available from every route for Administrators.
  initCoordinatorChat()

  router.start()
}

// ── Command palette ───────────────────────────────────────────────────────

function initCommandPalette() {
  const overlay = document.getElementById('commandPalette')
  const input = document.getElementById('cmdInput')
  const results = document.getElementById('cmdResults')
  const trigger = document.getElementById('searchTrigger')
  if (!overlay || !input) return

  const open = () => { overlay.style.display = 'flex'; input.focus(); input.value = ''; showResults('') }
  const close = () => { overlay.style.display = 'none' }

  trigger?.addEventListener('click', open)
  document.addEventListener('keydown', e => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'k') { e.preventDefault(); open() }
    if (e.key === 'Escape') close()
  })
  overlay.addEventListener('click', e => { if (e.target === overlay) close() })

  input.addEventListener('input', () => showResults(input.value))

  const quickLinks = [
    { icon: 'ti-layout-dashboard', label: 'Overview', hash: '#overview' },
    { icon: 'ti-briefcase', label: 'Projects', hash: '#projects' },
    { icon: 'ti-packages', label: 'Inventory', hash: '#inventory' },
    { icon: 'ti-clipboard-list', label: 'Work orders', hash: '#work-orders' },
    { icon: 'ti-car', label: 'Transport', hash: '#transport' },
    { icon: 'ti-map-pin', label: 'Field', hash: '#tech' },
    { icon: 'ti-settings', label: 'Admin', hash: '#admin' },
  ]

  function showResults(q) {
    const filtered = q.trim()
      ? quickLinks.filter(l => l.label.toLowerCase().includes(q.toLowerCase()))
      : quickLinks
    if (!filtered.length) {
      results.innerHTML = `<div class="cmd-result-empty">No results for "${q}"</div>`
      return
    }
    results.innerHTML = filtered.map(l => `
      <div class="cmd-result-item" data-hash="${l.hash}">
        <i class="ti ${l.icon}" aria-hidden="true"></i>
        ${l.label}
      </div>`).join('')
    results.querySelectorAll('.cmd-result-item').forEach(el => {
      el.addEventListener('click', () => { location.hash = el.dataset.hash; close() })
    })
  }
}

// ── Mobile drawer ─────────────────────────────────────────────────────────

function initMobileDrawer() {
  const btn      = document.getElementById('mobileMoreBtn')
  const drawer   = document.getElementById('mobileDrawer')
  const backdrop = document.getElementById('mobileDrawerBackdrop')
  if (!btn || !drawer || !backdrop) return

  const open = () => {
    drawer.classList.add('open')
    backdrop.classList.add('open')
    drawer.setAttribute('aria-hidden', 'false')
    btn.classList.add('active')
  }
  const close = () => {
    drawer.classList.remove('open')
    backdrop.classList.remove('open')
    drawer.setAttribute('aria-hidden', 'true')
    btn.classList.remove('active')
  }

  btn.addEventListener('click', () => drawer.classList.contains('open') ? close() : open())
  backdrop.addEventListener('click', close)

  // Close drawer when any item inside is tapped (event delegation)
  drawer.addEventListener('click', e => {
    if (e.target.closest('[data-drawer-close]')) close()
  })

  // Also close drawer on any route change (belt + suspenders)
  window.addEventListener('rp:route', close)

  // Sync active state for drawer items
  window.addEventListener('rp:route', e => {
    drawer.querySelectorAll('.mobile-drawer-item').forEach(el => {
      const route = el.getAttribute('data-route-link')
      el.classList.toggle('active', route === e.detail.route)
    })
  })
}

// ── Global UI utilities ───────────────────────────────────────────────────

export function toast(message, type = 'info') {
  const el = document.getElementById('toast')
  if (!el) return
  el.textContent = message
  el.className = `toast visible ${type}`
  clearTimeout(el._timer)
  el._timer = setTimeout(() => el.classList.remove('visible'), 3500)
}

export function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

window.toast = toast
window.router = router

// ── System stats widget ───────────────────────────────────────────────────

function fmtBytes(b) {
  if (b >= 1073741824) return (b / 1073741824).toFixed(1) + 'G'
  if (b >= 1048576) return (b / 1048576).toFixed(0) + 'M'
  return (b / 1024).toFixed(0) + 'K'
}

let _tempHistory = []
let _tempHistoryFetchedAt = 0

function renderTemperatureSparkline(samples) {
  const svg = document.getElementById('sw-temp-spark')
  const values = samples.map(row => Number(row.temperatureC)).filter(Number.isFinite)
  if (!svg || values.length < 2) { if (svg) svg.innerHTML = ''; return }
  const min = Math.min(...values) - 1
  const max = Math.max(...values) + 1
  const range = Math.max(1, max - min)
  const points = values.map((value, index) => {
    const x = values.length === 1 ? 0 : index * 90 / (values.length - 1)
    const y = 18 - ((value - min) / range) * 16
    return `${x.toFixed(1)},${y.toFixed(1)}`
  }).join(' ')
  svg.innerHTML = `<polyline points="${points}" fill="none" stroke="currentColor" stroke-width="1.8" vector-effect="non-scaling-stroke"/>`
}

async function refreshTemperatureHistory(headers) {
  if (Date.now() - _tempHistoryFetchedAt < 60000) return
  _tempHistoryFetchedAt = Date.now()
  const response = await fetch('/api/v1/admin/system-stats/history?hours=6', { headers })
  if (!response.ok) return
  _tempHistory = (await response.json()).samples || []
  renderTemperatureSparkline(_tempHistory)
}

async function refreshSysWidget() {
  try {
    const headers = { 'Authorization': 'Bearer ' + (JSON.parse(localStorage.getItem('rp_session') || '{}').token || '') }
    const d = await (await fetch('/api/v1/admin/system-stats', {
      headers
    })).json()
    if (!d.cpu) return

    const $cpu = document.getElementById('sw-cpu')
    const $cpuBar = document.getElementById('sw-cpu-bar')
    const $mem = document.getElementById('sw-mem')
    const $memBar = document.getElementById('sw-mem-bar')
    const $bat = document.getElementById('sw-bat')
    const $batBar = document.getElementById('sw-bat-bar')
    const $batIcon = document.getElementById('sw-bat-icon')
    const $volt = document.getElementById('sw-volt')
    const $temp = document.getElementById('sw-temp')

    if ($cpu) $cpu.textContent = d.cpu.percent + '%'
    if ($cpuBar) $cpuBar.style.width = d.cpu.percent + '%'

    if ($mem) $mem.textContent = fmtBytes(d.memory.usedBytes)
    if ($memBar) $memBar.style.width = d.memory.percent + '%'

    if (d.battery && d.battery.percent != null) {
      const pct = d.battery.percent
      const plugged = d.battery.plugged
      if ($bat) $bat.textContent = pct + '%'
      if ($batBar) {
        $batBar.style.width = pct + '%'
        $batBar.style.background = pct < 20 ? 'var(--red)' : pct < 40 ? 'var(--amber)' : 'var(--green)'
      }
      if ($batIcon) {
        const icon = plugged ? 'ti-battery-charging-2' : pct < 20 ? 'ti-battery-1' : pct < 50 ? 'ti-battery-2' : pct < 80 ? 'ti-battery-3' : 'ti-battery-4'
        $batIcon.innerHTML = `<i class="ti ${icon}"></i>`
        $batIcon.style.color = plugged ? 'var(--green)' : pct < 20 ? 'var(--red)' : 'var(--text-4)'
      }
      if ($volt && d.battery.voltageMv) {
        $volt.textContent = (d.battery.voltageMv / 1000).toFixed(2) + 'V'
      }
    }
    if ($temp) {
      const value = d.temperature?.celsius
      $temp.textContent = Number.isFinite(value) ? `${value.toFixed(1)}°` : 'n/a'
      $temp.title = `${d.temperature?.sensor || 'sensor unavailable'} · thermal ${d.temperature?.thermalState || 'unknown'}`
      $temp.style.color = value >= 45 ? 'var(--red)' : value >= 38 ? 'var(--amber)' : 'var(--text-2)'
    }
    await refreshTemperatureHistory(headers)
  } catch {}
}

let _sysWidgetTimer = null
function startSysWidget() {
  refreshSysWidget()
  _sysWidgetTimer = setInterval(refreshSysWidget, 5000)
}


// ── Notification panel ────────────────────────────────────────────────────

function initNotifPanel() {
  const btn = document.getElementById('notifBtn')
  if (!btn) return

  // Create panel
  const panel = document.createElement('div')
  panel.id = 'notifPanel'
  panel.style.cssText = `
    position:fixed;top:56px;right:12px;width:340px;max-height:480px;
    background:var(--surface);border:1px solid var(--border);border-radius:12px;
    box-shadow:0 8px 32px rgba(0,0,0,.4);z-index:1200;display:none;
    flex-direction:column;overflow:hidden;
  `
  panel.innerHTML = `
    <div style="padding:14px 16px 10px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between">
      <span style="font-size:13px;font-weight:600;color:var(--text)">Уведомления</span>
      <button id="notifMarkAll" style="font-size:11px;color:var(--accent);background:none;border:none;cursor:pointer;padding:0">Отметить все</button>
    </div>
    <div id="notifList" style="overflow-y:auto;flex:1;padding:8px 0"></div>
  `
  document.body.appendChild(panel)

  const badge = document.createElement('span')
  badge.id = 'notifBadge'
  badge.style.cssText = `
    position:absolute;top:-4px;right:-4px;min-width:16px;height:16px;
    background:var(--red,#f25757);color:#fff;font-size:10px;font-weight:700;
    border-radius:8px;display:none;align-items:center;justify-content:center;
    padding:0 4px;line-height:1;
  `
  btn.style.position = 'relative'
  btn.appendChild(badge)

  let open = false
  let unread = 0

  function renderNotifs(items) {
    const list = document.getElementById('notifList')
    if (!list) return
    if (!items.length) {
      list.innerHTML = `<div style="padding:24px;text-align:center;color:var(--text-4);font-size:13px">Нет уведомлений</div>`
      return
    }
    const col = { info:'var(--blue)', warning:'var(--amber)', success:'var(--green)', error:'var(--red,#f25757)' }
    list.innerHTML = items.slice(0, 20).map(n => `
      <div style="padding:10px 16px;display:flex;gap:10px;align-items:flex-start;${n.read ? '' : 'background:rgba(255,255,255,.03)'}">
        <div style="width:7px;height:7px;border-radius:50%;background:${col[n.type]||'var(--text-4)'};margin-top:5px;flex-shrink:0"></div>
        <div style="flex:1;min-width:0">
          <div style="font-size:12px;font-weight:${n.read ? 400 : 500};color:var(--text);line-height:1.4">${esc(n.title || n.message || '')}</div>
          ${n.body ? `<div style="font-size:11px;color:var(--text-3);margin-top:1px;line-height:1.4">${esc(n.body)}</div>` : ''}
          <div style="font-size:11px;color:var(--text-4);margin-top:3px">${relTime(n.created_at || n.createdAt)}</div>
        </div>
      </div>
    `).join('')
  }

  async function loadAndShow() {
    const list = document.getElementById('notifList')
    if (list) list.innerHTML = `<div style="padding:20px;text-align:center;color:var(--text-4);font-size:12px">Загрузка…</div>`
    try {
      const { apiJSON } = await import('./core/api.js')
      const data = await apiJSON('/api/v1/notifications?limit=20').catch(() => ({ notifications: [] }))
      const items = data.notifications || []
      unread = items.filter(n => !n.read_at && !n.readAt).length
      renderNotifs(items)
    } catch {}
  }

  function togglePanel() {
    open = !open
    panel.style.display = open ? 'flex' : 'none'
    if (open) loadAndShow()
  }

  btn.addEventListener('click', e => { e.stopPropagation(); togglePanel() })
  document.addEventListener('click', e => {
    if (open && !panel.contains(e.target) && e.target !== btn) {
      open = false; panel.style.display = 'none'
    }
  })

  document.getElementById('notifMarkAll')?.addEventListener?.('click', async () => {
    try {
      const { apiPost } = await import('./core/api.js')
      await apiPost('/api/v1/notifications/mark-all-read', {}).catch(() => {})
      badge.style.display = 'none'
      loadAndShow()
    } catch {}
  })

  // Poll for unread count every 60s
  async function pollUnread() {
    try {
      const { apiJSON } = await import('./core/api.js')
      // Use unreadCount from server — it reflects total unread, not the page size
      const data = await apiJSON('/api/v1/notifications?limit=1&unread=1').catch(() => null)
      if (!data) return
      const count = typeof data.unreadCount === 'number' ? data.unreadCount : 0
      badge.style.display = count > 0 ? 'flex' : 'none'
      badge.textContent = count > 9 ? '9+' : String(count)
    } catch {}
  }
  pollUnread()
  setInterval(pollUnread, 60000)
}

function esc(s) { return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;') }
function relTime(iso) {
  if (!iso) return ''
  const m = Math.floor((Date.now() - new Date(iso)) / 60000)
  if (m < 1) return 'только что'
  if (m < 60) return `${m} мин. назад`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h} ч. назад`
  return `${Math.floor(h/24)} д. назад`
}

// ── Boot ──────────────────────────────────────────────────────────────────

bootstrap()
