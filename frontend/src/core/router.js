/**
 * Hash-based SPA router.
 *
 * Usage:
 *   router.on('projects', () => import('../modules/projects.js').then(m => m.mount()))
 *   router.on('inventory', () => import('../modules/inventory.js').then(m => m.mount()))
 *   router.start()
 */

const _handlers = new Map()
let _currentRoute = null
let _currentCleanup = null

export const router = {
  /** Register a route handler. fn() should return a cleanup function or Promise<cleanup>. */
  on(route, fn) {
    _handlers.set(route, fn)
    return router
  },

  /** Start listening to hash changes. */
  start() {
    window.addEventListener('hashchange', _dispatch)
    _dispatch()
  },

  /** Navigate programmatically. */
  go(route) {
    location.hash = '#' + route
  },

  get current() {
    return _currentRoute
  },
}

function _parseHash() {
  const raw = location.hash.replace('#', '') || 'overview'
  const parts = raw.split('/')
  return { route: parts[0], params: parts.slice(1) }
}

async function _dispatch() {
  const { route, params } = _parseHash()

  // Tear down previous route
  if (_currentCleanup) {
    try { await _currentCleanup() } catch {}
    _currentCleanup = null
  }

  _currentRoute = route

  // Update nav active state
  document.querySelectorAll('[data-route-link]').forEach(el => {
    el.classList.toggle('active', el.dataset.routeLink === route)
  })

  // Update body data-route for CSS selectors
  document.body.dataset.route = route

  // Show matching view, hide others
  document.querySelectorAll('[data-view]').forEach(el => {
    el.classList.toggle('active', el.dataset.view === route)
  })

  const handler = _handlers.get(route)
  if (handler) {
    const cleanup = await handler(params)
    if (typeof cleanup === 'function') _currentCleanup = cleanup
  }

  window.dispatchEvent(new CustomEvent('rp:route', { detail: { route, params } }))
}
