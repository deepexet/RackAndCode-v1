/**
 * Field Progress Module — track technician progress on objects.
 *
 * Views: projects list → project overview (locations) → location tech matrix
 * Mobile-first: large touch targets, quick-tap to mark complete.
 */

import { apiJSON, apiPatch } from '../core/api.js'

// ── State ─────────────────────────────────────────────────────────────────

let _el = null
let _s = {
  view: 'projects',     // 'projects' | 'project' | 'location'
  projects: [],
  project: null,        // full project data (with locations, workTypes…)
  projectId: null,
  locationId: null,
  filterWorkType: null, // null = all work types
  pendingKeys: new Set(), // "unitId:actionId" — optimistic updates in flight
  todayStr: new Date().toISOString().slice(0, 10),
}

// ── Data layer ───────────────────────────────────────────────────────────

async function loadProjects() {
  const data = await apiJSON('/api/v1/projects')
  _s.projects = (data.projects || []).filter(p => p.status !== 'archived')
}

async function loadProject(id) {
  const data = await apiJSON(`/api/v1/projects/${id}`)
  _s.project = data.project
  _s.projectId = id
}

async function patchProgress(pid, lid, uid, workTypeId, actionId, newStatus) {
  const key = `${uid}:${actionId}`
  _s.pendingKeys.add(key)

  try {
    const resp = await apiPatch(
      `/api/v1/projects/${pid}/locations/${lid}/units/${uid}/progress`,
      { workTypeId, actionId, status: newStatus, comments: '' }
    )
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}))
      throw new Error(err?.error?.message || `HTTP ${resp.status}`)
    }
    await loadProject(pid)
  } catch (err) {
    window.toast?.(`Ошибка: ${err.message}`, 'error')
  } finally {
    _s.pendingKeys.delete(key)
    renderView()
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────

function esc(str) {
  return String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function pct(n) { return Math.round(n ?? 0) }

function progressRing(pctVal, size = 48, stroke = 4) {
  const r = (size - stroke * 2) / 2
  const circ = 2 * Math.PI * r
  const dash = (pctVal / 100) * circ
  const color = pctVal >= 100 ? 'var(--green)' : pctVal > 0 ? 'var(--accent)' : 'var(--border)'
  return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" class="progress-ring">
    <circle cx="${size/2}" cy="${size/2}" r="${r}" fill="none" stroke="var(--surface-2)" stroke-width="${stroke}"/>
    <circle cx="${size/2}" cy="${size/2}" r="${r}" fill="none" stroke="${color}" stroke-width="${stroke}"
      stroke-dasharray="${dash} ${circ}" stroke-dashoffset="${circ/4}" stroke-linecap="round"
      transform="rotate(-90 ${size/2} ${size/2})"/>
    <text x="50%" y="50%" text-anchor="middle" dominant-baseline="central"
      fill="${color}" font-size="${size < 40 ? 9 : 11}" font-weight="600">${pctVal}%</text>
  </svg>`
}

function getUnitProgress(unit, workTypeId, actionId) {
  return (unit.progress || []).find(p => p.workTypeId === workTypeId && p.actionId === actionId)
}

function countTodayDone(locations, todayStr) {
  let n = 0
  for (const loc of (locations || [])) {
    for (const unit of (loc.units || [])) {
      for (const p of (unit.progress || [])) {
        if (p.status === 'complete' && p.completedOn === todayStr) n++
      }
    }
  }
  return n
}

function locationProgress(location, filterWtId = null) {
  let done = 0, total = 0
  for (const unit of (location.units || [])) {
    for (const p of (unit.progress || [])) {
      if (filterWtId && p.workTypeId !== filterWtId) continue
      total++
      if (p.status === 'complete') done++
    }
  }
  return total > 0 ? Math.round((done / total) * 100) : 0
}

// ── View: Projects list ───────────────────────────────────────────────────

function renderProjects() {
  if (!_s.projects.length) {
    _el.innerHTML = `
      <div class="fp-empty">
        <i class="ti ti-building-skyscraper"></i>
        <p>Нет активных проектов</p>
      </div>`
    return
  }

  _el.innerHTML = `
    <div class="fp-page-header">
      <div>
        <h2>Полевые объекты</h2>
        <span class="fp-header-date">${new Date().toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' })}</span>
      </div>
    </div>
    <div class="fp-project-list">
      ${_s.projects.map(p => {
        const prog = pct(p.progress)
        const wtBars = (p.workTypeProgress || []).filter(wt => wt.fieldUpdateCount > 0).slice(0, 8)
        return `
          <div class="fp-project-card" data-project-id="${esc(p.id)}">
            <div class="fp-project-card-top">
              <div class="fp-project-card-info">
                <span class="fp-project-name">${esc(p.name)}</span>
                <span class="fp-project-meta">${[p.code, p.status].filter(Boolean).join(' · ')}</span>
              </div>
              ${progressRing(prog, 56, 5)}
            </div>
            ${wtBars.length ? `
            <div class="fp-wt-bars">
              ${wtBars.map(wt => `
                <div class="fp-wt-bar-row" title="${esc(wt.name)}: ${pct(wt.progress)}%">
                  <span class="fp-wt-dot" style="background:${esc(wt.color)}"></span>
                  <span class="fp-wt-label">${esc(wt.name)}</span>
                  <div class="fp-wt-track">
                    <div class="fp-wt-fill" style="width:${pct(wt.progress)}%;background:${esc(wt.color)}"></div>
                  </div>
                  <span class="fp-wt-pct">${pct(wt.progress)}%</span>
                </div>`).join('')}
            </div>` : ''}
            <div class="fp-project-card-footer">
              <i class="ti ti-arrow-right"></i>
            </div>
          </div>`
      }).join('')}
    </div>`

  _el.querySelectorAll('[data-project-id]').forEach(card => {
    card.addEventListener('click', async () => {
      const pid = card.dataset.projectId
      _el.innerHTML = `<div class="fp-loading"><i class="ti ti-loader-2"></i> Загрузка…</div>`
      await loadProject(pid)
      _s.view = 'project'
      _s.filterWorkType = null
      renderView()
    })
  })
}

// ── View: Project overview ────────────────────────────────────────────────

function renderProject() {
  const p = _s.project
  if (!p) return

  const todayDone = countTodayDone(p.locations, _s.todayStr)
  const locations = p.locations || []
  const buildings = p.buildings || []

  const byBuilding = {}
  for (const loc of locations) {
    const bid = loc.buildingId || '__none__'
    if (!byBuilding[bid]) byBuilding[bid] = []
    byBuilding[bid].push(loc)
  }

  _el.innerHTML = `
    <div class="fp-toolbar">
      <button class="fp-back-btn" id="fp-back-projects">
        <i class="ti ti-arrow-left"></i> Объекты
      </button>
      ${todayDone > 0 ? `<span class="fp-today-badge"><i class="ti ti-check"></i> ${todayDone} сегодня</span>` : ''}
    </div>

    <div class="fp-project-overview-header">
      <div>
        <h2 class="fp-project-title">${esc(p.name)}</h2>
        <span class="fp-project-subtitle">${pct(p.progress)}% выполнено · ${locations.length} локаций</span>
      </div>
      ${progressRing(pct(p.progress), 64, 5)}
    </div>

    <div class="fp-wt-filter-bar">
      <button class="fp-wt-filter-chip ${!_s.filterWorkType ? 'active' : ''}" data-wt="">Все</button>
      ${(p.workTypes || []).map(wt => {
        const wtprog = (p.workTypeProgress || []).find(x => x.id === wt.id)
        return `
          <button class="fp-wt-filter-chip ${_s.filterWorkType === wt.id ? 'active' : ''}"
                  data-wt="${esc(wt.id)}" style="--wt-color:${esc(wt.color)}">
            <span class="fp-wt-chip-dot"></span>
            ${esc(wt.name)} ${pct(wtprog?.progress ?? 0)}%
          </button>`
      }).join('')}
    </div>

    <div class="fp-location-grid">
      ${Object.entries(byBuilding).map(([bid, locs]) => {
        const bld = buildings.find(b => b.id === bid)
        return `
          ${bld ? `<div class="fp-building-label"><i class="ti ti-building"></i> ${esc(bld.name)}</div>` : ''}
          ${locs.map(loc => {
            const prog = locationProgress(loc, _s.filterWorkType)
            const unitCount = (loc.units || []).length
            return `
              <div class="fp-location-card" data-location-id="${esc(loc.id)}">
                <div class="fp-location-card-top">
                  <span class="fp-location-badge">${esc(loc.code)}</span>
                  <span class="fp-location-kind-tag">${esc(loc.kind)}</span>
                </div>
                <div class="fp-location-name">${esc(loc.name)}</div>
                <div class="fp-location-stats">
                  <span>${unitCount} юнитов</span>
                  <span class="fp-loc-pct ${prog >= 100 ? 'done' : prog > 0 ? 'partial' : ''}">${prog}%</span>
                </div>
                <div class="fp-location-track">
                  <div class="fp-location-fill" style="width:${prog}%;background:${prog >= 100 ? 'var(--green)' : 'var(--accent)'}"></div>
                </div>
                <div class="fp-location-card-arrow"><i class="ti ti-arrow-right"></i></div>
              </div>`
          }).join('')}`
      }).join('')}
    </div>`

  document.getElementById('fp-back-projects')?.addEventListener('click', () => {
    _s.view = 'projects'
    _s.project = null
    renderView()
  })

  _el.querySelectorAll('[data-wt]').forEach(chip => {
    chip.addEventListener('click', () => {
      _s.filterWorkType = chip.dataset.wt || null
      renderProject()
    })
  })

  _el.querySelectorAll('[data-location-id]').forEach(card => {
    card.addEventListener('click', () => {
      _s.locationId = card.dataset.locationId
      _s.view = 'location'
      _s.filterWorkType = null
      renderView()
    })
  })
}

// ── View: Location — technician unit matrix ───────────────────────────────

function renderLocation() {
  const p = _s.project
  if (!p) return

  const loc = (p.locations || []).find(l => l.id === _s.locationId)
  if (!loc) return

  const units = loc.units || []
  const wtList = p.workTypes || []

  // Which work types have entries in this location?
  const activeWtIds = new Set(wtList.map(wt => wt.id))
  const displayWts = wtList.filter(wt => activeWtIds.has(wt.id))

  if (!_s.filterWorkType && displayWts[0]) _s.filterWorkType = displayWts[0].id
  const selectedWt = displayWts.find(wt => wt.id === _s.filterWorkType) || displayWts[0]

  const actions = selectedWt?.actions || []
  const todayDone = countTodayDone([loc], _s.todayStr)

  // Count done / total for selected work type (all possible unit×action combinations)
  let wt_done = 0, wt_total = 0
  for (const unit of units) {
    for (const action of actions) {
      wt_total++
      const pr = getUnitProgress(unit, selectedWt?.id, action.id)
      if (pr?.status === 'complete') wt_done++
    }
  }
  const locProg = wt_total > 0 ? Math.round((wt_done / wt_total) * 100) : 0

  function unitAllDone(unit) {
    if (!selectedWt) return false
    return actions.every(a => getUnitProgress(unit, selectedWt.id, a.id)?.status === 'complete')
  }

  _el.innerHTML = `
    <div class="fp-toolbar">
      <button class="fp-back-btn" id="fp-back-project">
        <i class="ti ti-arrow-left"></i> ${esc(p.name)}
      </button>
      ${todayDone > 0 ? `<span class="fp-today-badge"><i class="ti ti-check"></i> ${todayDone} сегодня</span>` : ''}
    </div>

    <div class="fp-location-header">
      <div>
        <h2>${esc(loc.name)}</h2>
        <span class="fp-location-sub">${esc(loc.code)} · ${units.length} юнитов</span>
      </div>
      ${progressRing(locProg, 52, 4)}
    </div>

    <div class="fp-wt-tabs" id="fp-wt-tabs">
      ${displayWts.map(wt => {
        const wtDoneCount = units.reduce((acc, u) => {
          const allDone = (wt.actions || []).every(a => getUnitProgress(u, wt.id, a.id)?.status === 'complete')
          return acc + (allDone ? 1 : 0)
        }, 0)
        return `
          <button class="fp-wt-tab ${selectedWt?.id === wt.id ? 'active' : ''}"
                  data-wt="${esc(wt.id)}" style="--wt-color:${esc(wt.color)}">
            <span class="fp-wt-tab-dot"></span>
            <span>${esc(wt.name)}</span>
            ${wtDoneCount > 0 ? `<span class="fp-wt-tab-badge">${wtDoneCount}/${units.length}</span>` : ''}
          </button>`
      }).join('')}
    </div>

    ${selectedWt ? `
    <div class="fp-wt-stat-bar">
      <span class="fp-wt-stat-label">
        <span class="fp-wt-stat-dot" style="background:${esc(selectedWt.color)}"></span>
        ${esc(selectedWt.name)}
      </span>
      <span class="fp-wt-stat-count">${wt_done} / ${wt_total} действий</span>
      <div class="fp-wt-stat-track">
        <div class="fp-wt-stat-fill" style="width:${wt_total ? Math.round(wt_done/wt_total*100) : 0}%;background:${esc(selectedWt.color)}"></div>
      </div>
    </div>` : ''}

    <div class="fp-matrix-wrap">
      ${!units.length ? `
        <div class="fp-empty">
          <i class="ti ti-inbox"></i>
          <p>Нет юнитов в этой локации</p>
        </div>` : `
      <div class="fp-matrix" id="fp-matrix" style="--action-cols:${actions.length}">
        <div class="fp-matrix-head">
          <div class="fp-mh-unit">Юнит</div>
          ${actions.map(a => `<div class="fp-mh-action">${esc(a.name)}</div>`).join('')}
        </div>
        ${units.map(unit => {
          const allDone = unitAllDone(unit)
          return `
            <div class="fp-matrix-row${allDone ? ' fp-row-done' : ''}">
              <div class="fp-mr-unit">
                <span class="fp-unit-code">${esc(unit.code)}</span>
                <span class="fp-unit-name">${esc(unit.name)}</span>
              </div>
              ${actions.map(action => {
                const pr = selectedWt ? getUnitProgress(unit, selectedWt.id, action.id) : null
                const status = pr?.status || 'not_started'
                const key = `${unit.id}:${action.id}`
                const pending = _s.pendingKeys.has(key)
                return `
                  <div class="fp-mr-action">
                    <button class="fp-act-btn s-${status}${pending ? ' s-pending' : ''}"
                            data-uid="${esc(unit.id)}"
                            data-lid="${esc(loc.id)}"
                            data-wtid="${esc(selectedWt?.id ?? '')}"
                            data-aid="${esc(action.id)}"
                            data-status="${esc(status)}"
                            ${pending ? 'disabled' : ''}
                            title="${esc(action.name)}"
                            aria-label="${esc(action.name)}: ${status}">
                      ${pending
                        ? '<i class="ti ti-loader-2 fp-spin"></i>'
                        : status === 'complete'  ? '<i class="ti ti-check"></i>'
                        : status === 'ongoing'   ? '<i class="ti ti-dots"></i>'
                        : status === 'blocked'   ? '<i class="ti ti-ban"></i>'
                        : ''}
                    </button>
                  </div>`
              }).join('')}
            </div>`
        }).join('')}
      </div>`}
    </div>

    <div class="fp-legend">
      <div class="fp-legend-item"><span class="fp-act-btn s-not_started" style="pointer-events:none"></span> Не начато</div>
      <div class="fp-legend-item"><span class="fp-act-btn s-ongoing" style="pointer-events:none"><i class="ti ti-dots"></i></span> В процессе</div>
      <div class="fp-legend-item"><span class="fp-act-btn s-complete" style="pointer-events:none"><i class="ti ti-check"></i></span> Готово</div>
    </div>`

  document.getElementById('fp-back-project')?.addEventListener('click', () => {
    _s.view = 'project'
    _s.filterWorkType = null
    renderView()
  })

  _el.querySelectorAll('[data-wt]').forEach(btn => {
    btn.addEventListener('click', () => {
      _s.filterWorkType = btn.dataset.wt
      renderLocation()
    })
  })

  _el.querySelectorAll('.fp-act-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const { uid, lid, wtid, aid, status } = btn.dataset
      if (!uid || !lid || !wtid || !aid) return

      // Cycle: not_started → complete; ongoing → complete; complete → not_started
      const nextStatus = status === 'complete' ? 'not_started' : 'complete'
      const key = `${uid}:${aid}`
      _s.pendingKeys.add(key)

      // Optimistic update
      btn.dataset.status = nextStatus
      btn.className = `fp-act-btn s-${nextStatus} s-pending`
      btn.disabled = true
      btn.innerHTML = '<i class="ti ti-loader-2 fp-spin"></i>'

      await patchProgress(_s.projectId, lid, uid, wtid, aid, nextStatus)
    })
  })
}

// ── View dispatcher ───────────────────────────────────────────────────────

function renderView() {
  if (!_el) return
  switch (_s.view) {
    case 'projects': renderProjects(); break
    case 'project':  renderProject();  break
    case 'location': renderLocation(); break
  }
}

// ── Mount / Unmount ───────────────────────────────────────────────────────

export async function mount() {
  _el = document.querySelector('[data-view="tech"]')
  if (!_el) return unmount

  _s = {
    view: 'projects', projects: [], project: null, projectId: null,
    locationId: null, filterWorkType: null, pendingKeys: new Set(),
    todayStr: new Date().toISOString().slice(0, 10),
  }

  _el.innerHTML = `<div class="fp-loading"><i class="ti ti-loader-2"></i> Загрузка…</div>`

  await loadProjects()

  if (_s.projects.length === 1) {
    await loadProject(_s.projects[0].id)
    _s.view = 'project'
  }

  renderView()
  return unmount
}

export function unmount() {
  _el = null
}
