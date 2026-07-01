import { apiJSON, getSession } from '../core/api.js'
import { esc, badge, emptyState, toolbar, tabBar } from '../components/ui.js'

let root
let active = 'pending'
const tabs = [
  { id: 'pending', label: 'Pending' }, { id: 'approved', label: 'Approved' },
  { id: 'rejected', label: 'Rejected' }, { id: 'expired', label: 'Expired' },
]

function approvalCard(item) {
  const canReview = getSession()?.role === 'Administrator' && item.status === 'pending'
  const payload = JSON.stringify(item.action_payload || {}, null, 2)
  const evidence = JSON.stringify(item.evidence || {}, null, 2)
  return `<article class="card approval-card" data-approval-id="${esc(item.id)}">
    <header><strong>${esc(item.action_type)}</strong>${badge(item.status)}</header>
    <small>Proposed by ${esc(item.proposed_by || 'agent')}</small>
    ${item.coordinator_job_id ? `<small>Coordinator job: ${esc(item.coordinator_job_id)}</small>` : ''}
    <details><summary>Proposed changes</summary><pre>${esc(payload)}</pre></details>
    <details><summary>Evidence</summary><pre>${esc(evidence)}</pre></details>
    ${canReview ? `<footer><button class="btn btn-primary" data-decision="approved">Approve</button><button class="btn btn-danger" data-decision="rejected">Reject</button></footer>` : ''}
  </article>`
}

async function render() {
  root.querySelector('#approvalTabs').innerHTML = tabBar(tabs, active)
  const target = root.querySelector('#approvalList')
  target.innerHTML = '<p class="muted">Loading approvals…</p>'
  try {
    const data = await apiJSON(`/api/v1/ai/approvals?status=${encodeURIComponent(active)}`)
    target.innerHTML = data.approvals?.length
      ? data.approvals.map(approvalCard).join('')
      : emptyState({ title: 'No approval requests', message: 'AI proposals requiring a human decision will appear here.' })
  } catch (error) {
    target.innerHTML = `<p class="error-text">${esc(error.message)}</p>`
  }
}

export async function mount() {
  root = document.getElementById('mainContent')
  root.innerHTML = `${toolbar({ title: 'AI Approvals', subtitle: 'Human control for AI-proposed platform changes' })}<div id="approvalTabs"></div><section id="approvalList" class="approval-list"></section>`
  root.onclick = async event => {
    const tab = event.target.closest('[data-tab]')
    if (tab) { active = tab.dataset.tab; await render(); return }
    const decision = event.target.closest('[data-decision]')
    if (!decision) return
    const card = decision.closest('[data-approval-id]')
    decision.disabled = true
    try {
      await apiJSON(`/api/v1/ai/approvals/${card.dataset.approvalId}/review`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision: decision.dataset.decision }),
      })
      await render()
    } catch (error) {
      decision.disabled = false
      window.alert(error.message)
    }
  }
  await render()
}

export function unmount() { root = null }
