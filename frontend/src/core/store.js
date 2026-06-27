/**
 * Reactive state store (no framework dependency).
 *
 * Minimal pub/sub store. Each domain module manages its own slice.
 *
 * Usage:
 *   import { createStore } from '../core/store.js'
 *   const projectStore = createStore({ projects: [], loading: false })
 *   projectStore.subscribe(state => renderProjects(state.projects))
 *   projectStore.set({ projects: [...] })
 */

export function createStore(initialState = {}) {
  let state = { ...initialState }
  const listeners = new Set()

  return {
    get() {
      return state
    },

    set(patch) {
      state = { ...state, ...patch }
      listeners.forEach(fn => fn(state))
    },

    subscribe(fn) {
      listeners.add(fn)
      fn(state) // call immediately with current state
      return () => listeners.delete(fn) // unsubscribe
    },
  }
}

// ── Global app state (cross-module) ──────────────────────────────────────

export const appState = createStore({
  session: null,      // { token, role, userId, orgId }
  online: navigator.onLine,
  pendingWrites: 0,
})

window.addEventListener('online', () => appState.set({ online: true }))
window.addEventListener('offline', () => appState.set({ online: false }))
