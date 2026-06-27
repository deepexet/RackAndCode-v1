/**
 * RackPilot SPA — entry point.
 *
 * Initializes auth, router, and lazy-loads domain modules on navigation.
 */
import { router } from './core/router.js'
import { apiJSON, setSession, getSession, clearSession } from './core/api.js'
import { appState } from './core/store.js'

// ── Auth bootstrap ────────────────────────────────────────────────────────

async function bootstrap() {
  const stored = getSession()
  if (stored?.token) {
    try {
      const me = await apiJSON('/api/v1/auth/me')
      setSession({ ...stored, ...me })
      appState.set({ session: getSession() })
      startApp()
    } catch {
      clearSession()
      showLoginModal()
    }
  } else {
    showLoginModal()
  }
}

function showLoginModal() {
  const modal = document.getElementById('loginModal')
  if (modal) modal.style.display = 'flex'
}

function hideLoginModal() {
  const modal = document.getElementById('loginModal')
  if (modal) modal.style.display = 'none'
}

// ── Login form ────────────────────────────────────────────────────────────

document.getElementById('loginForm')?.addEventListener('submit', async e => {
  e.preventDefault()
  const email = document.getElementById('loginEmail').value.trim()
  const password = document.getElementById('loginPassword').value
  const errEl = document.getElementById('loginError')

  try {
    const data = await apiJSON('/api/v1/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    })
    setSession(data)
    appState.set({ session: data })
    hideLoginModal()
    startApp()
  } catch (err) {
    if (errEl) { errEl.textContent = err.message; errEl.style.display = 'block' }
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
    .on('tech',         () => import('./modules/tech.js').then(m => m.mount()))
    .on('logs',         () => import('./modules/logs.js').then(m => m.mount()))
    .on('api',          () => import('./modules/api_metrics.js').then(m => m.mount()))
    .on('admin',        () => import('./modules/admin.js').then(m => m.mount()))

  // Update breadcrumb on route change
  window.addEventListener('rp:route', e => {
    const labels = {
      overview: 'Overview', projects: 'Projects', inventory: 'Inventory',
      'work-orders': 'Work orders', tech: 'Field', logs: 'Logs', admin: 'Admin',
    }
    const bc = document.getElementById('topbarBreadcrumb')
    if (bc) bc.innerHTML = `<span>${labels[e.detail.route] || e.detail.route}</span>`
  })

  // Command palette (⌘K)
  initCommandPalette()

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

// ── Boot ──────────────────────────────────────────────────────────────────

bootstrap()
