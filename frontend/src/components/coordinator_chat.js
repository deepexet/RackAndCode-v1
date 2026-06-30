import { apiJSON, getSession } from '../core/api.js'

let history = []

function esc(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

async function loadHistory() {
  const data = await apiJSON('/api/v1/admin/coordinator/chat?limit=100')
  history = (data.messages || []).map(row => ({
    role: row.role === 'user' ? 'You' : row.role === 'assistant' ? 'Coordinator' : 'System',
    text: row.content,
  }))
  renderMessages()
}

function renderMessages() {
  const target = document.getElementById('coordinatorChatMessages')
  if (!target) return
  target.innerHTML = history.length
    ? history.map(row => `<div class="coord-msg coord-msg--${row.role === 'You' ? 'user' : 'assistant'}">
        <span class="coord-msg-role">${esc(row.role)}</span><div>${esc(row.text)}</div></div>`).join('')
    : `<div class="coord-chat-welcome"><strong>Your development coordinator</strong>
        <span>Ask about agent activity, progress, limits and priorities. Explicit changes use slash commands.</span></div>`
  target.scrollTop = target.scrollHeight
}

async function refreshStatus() {
  const status = document.getElementById('coordinatorChatStatus')
  if (!status) return
  try {
    const data = await apiJSON('/api/v1/admin/coordinator')
    const scheduler = data.health?.scheduler || {}
    const jobs = data.jobs || []
    const labels = ['claude', 'codex', 'local'].map(agent => {
      const active = jobs.find(job => job.assignedAgent === agent && ['running', 'queued', 'review', 'integrating'].includes(job.status))
      return `${agent}: ${active?.status || 'idle'}`
    })
    status.textContent = `${labels.join(' · ')} · ${scheduler.running || 0} running`
  } catch (err) {
    status.textContent = `Coordinator unavailable: ${err.message}`
  }
}

export function initCoordinatorChat() {
  if (getSession()?.role !== 'Administrator' || document.getElementById('coordinatorChatLauncher')) return
  loadHistory().catch(err => {
    history = [{ role: 'System', text: `Could not load shared history: ${err.message}` }]
    renderMessages()
  })
  const host = document.createElement('div')
  host.innerHTML = `
    <button class="coord-chat-launcher" id="coordinatorChatLauncher" type="button" aria-label="Open Coordinator Chat">
      <i class="ti ti-message-chatbot"></i><span>Coordinator</span><span class="coord-chat-dot"></span>
    </button>
    <aside class="coord-chat-panel" id="coordinatorChatPanel" aria-hidden="true" aria-label="Coordinator Chat">
      <header class="coord-chat-header">
        <div><strong><i class="ti ti-message-chatbot"></i> Coordinator</strong><small id="coordinatorChatStatus">Loading team status…</small></div>
        <button id="coordinatorChatClose" type="button" aria-label="Close Coordinator Chat"><i class="ti ti-x"></i></button>
      </header>
      <div class="coord-chat-messages" id="coordinatorChatMessages"></div>
      <form class="coord-chat-form" id="coordinatorChatForm">
        <textarea name="message" rows="2" maxlength="4000" required placeholder="Ask the coordinator…"></textarea>
        <button type="submit" aria-label="Send to coordinator"><i class="ti ti-send"></i></button>
      </form>
      <div class="coord-chat-help">/status · /start 10 · /stop · /retry JOB_ID · /priority WORK_ITEM_ID high</div>
    </aside>`
  document.body.append(...host.children)
  renderMessages()

  const launcher = document.getElementById('coordinatorChatLauncher')
  const panel = document.getElementById('coordinatorChatPanel')
  const close = () => { panel.classList.remove('open'); panel.setAttribute('aria-hidden', 'true') }
  launcher.addEventListener('click', () => {
    const open = !panel.classList.contains('open')
    panel.classList.toggle('open', open)
    panel.setAttribute('aria-hidden', String(!open))
    if (open) { refreshStatus(); panel.querySelector('textarea')?.focus() }
  })
  document.getElementById('coordinatorChatClose')?.addEventListener('click', close)
  window.addEventListener('rp:unauthorized', close)

  document.getElementById('coordinatorChatForm')?.addEventListener('submit', async event => {
    event.preventDefault()
    const form = event.currentTarget
    const input = form.elements.message
    const message = String(input.value || '').trim()
    if (!message) return
    const button = form.querySelector('button[type="submit"]')
    history.push({ role: 'You', text: message })
    input.value = ''
    button.disabled = true
    renderMessages()
    try {
      const result = await apiJSON('/api/v1/admin/coordinator/chat', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message }),
      })
      history.push({ role: 'Coordinator', text: result.answer || 'No response' })
      await refreshStatus()
    } catch (err) {
      history.push({ role: 'System', text: err.message === 'Method Not Allowed'
        ? 'Coordinator backend is updating. Try again in a few seconds.' : err.message })
    } finally {
      button.disabled = false
      renderMessages()
      input.focus()
    }
  })
}
