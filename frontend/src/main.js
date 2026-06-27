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
  router
    .on('overview',     () => import('./modules/overview.js').then(m => m.mount()))
    .on('projects',     () => import('./modules/projects.js').then(m => m.mount()))
    .on('inventory',    () => import('./modules/inventory.js').then(m => m.mount()))
    .on('work-orders',  () => import('./modules/work_orders.js').then(m => m.mount()))
    .on('tech',         () => import('./modules/tech.js').then(m => m.mount()))
    .on('logs',         () => import('./modules/logs.js').then(m => m.mount()))
    .on('api',          () => import('./modules/api_metrics.js').then(m => m.mount()))
    .on('admin',        () => import('./modules/admin.js').then(m => m.mount()))
    .start()
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
