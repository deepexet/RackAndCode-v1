/**
 * API client — thin wrapper around fetch.
 * All backend calls go through here for consistent auth, error handling and retries.
 */

let _session = null  // { token, role, userId, orgId }

export function setSession(session) {
  _session = session
  if (session) {
    sessionStorage.setItem('rp_session', JSON.stringify(session))
  } else {
    sessionStorage.removeItem('rp_session')
  }
}

export function getSession() {
  if (_session) return _session
  try {
    const raw = sessionStorage.getItem('rp_session')
    if (raw) _session = JSON.parse(raw)
  } catch { _session = null }
  return _session
}

export function clearSession() {
  _session = null
  sessionStorage.removeItem('rp_session')
}

function buildHeaders(extra = {}) {
  const session = getSession()
  const headers = { ...extra }
  if (session?.token) {
    headers['Authorization'] = `Bearer ${session.token}`
  }
  if (import.meta.env.DEV) {
    // Development role preview header
    headers['X-RackPilot-Role'] = session?.role || 'Administrator'
  }
  return headers
}

/**
 * Core fetch wrapper.
 * @param {string} path   - e.g. '/api/v1/projects'
 * @param {object} opts   - fetch options
 * @returns {Promise<Response>}
 */
export async function apiFetch(path, opts = {}) {
  const headers = buildHeaders(opts.headers || {})
  const resp = await fetch(path, { ...opts, headers })

  if (resp.status === 401) {
    clearSession()
    window.dispatchEvent(new CustomEvent('rp:unauthorized'))
  }

  return resp
}

export async function apiGet(path, query = {}) {
  const qs = Object.keys(query).length
    ? '?' + new URLSearchParams(query).toString()
    : ''
  return apiFetch(path + qs)
}

export async function apiPost(path, body, opts = {}) {
  return apiFetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    ...opts,
  })
}

export async function apiPatch(path, body) {
  return apiFetch(path, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

export async function apiDelete(path) {
  return apiFetch(path, { method: 'DELETE' })
}

/**
 * Fetch JSON with error throwing on non-2xx.
 */
export async function apiJSON(path, opts = {}) {
  const resp = await apiFetch(path, opts)
  if (!resp.ok) {
    let message = `HTTP ${resp.status}`
    try { message = (await resp.json()).error?.message || message } catch {}
    throw new Error(message)
  }
  return resp.json()
}
