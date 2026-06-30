import { apiJSON, getSession } from '../core/api.js'

let history = []

function esc(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function formatMessage(value) {
  return esc(value).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/\n/g, '<br>')
}

async function loadHistory() {
  const data = await apiJSON('/api/v1/admin/coordinator/chat?limit=100')
  history = (data.messages || []).map(row => ({
    role: row.role === 'user' ? 'You' : row.role === 'assistant' ? 'Coordinator' : 'System',
    text: row.content,
    createdAt: row.createdAt,
  }))
  renderMessages()
}

function renderMessages() {
  const target = document.getElementById('coordinatorChatMessages')
  if (!target) return
  target.innerHTML = history.length
    ? history.map(row => `<div class="coord-msg coord-msg--${row.role === 'You' ? 'user' : 'assistant'}">
        <span class="coord-msg-role">${row.role === 'You' ? '<i class="ti ti-user"></i>' : '<i class="ti ti-sparkles"></i>'} ${esc(row.role)}</span>
        <div>${formatMessage(row.text)}</div>${row.createdAt ? `<time>${new Date(row.createdAt).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}</time>` : ''}</div>`).join('')
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
      <div class="coord-chat-help">Default: Local AI · /local TASK · /codex REQUEST · /claude REQUEST · /status · /start 10 · /stop</div>
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
  setInterval(() => {
    if (panel.classList.contains('open')) loadHistory().catch(() => {})
  }, 15000)

  const input = document.querySelector('#coordinatorChatForm textarea')
  input?.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault()
      event.currentTarget.form?.requestSubmit()
    }
  })

  document.getElementById('coordinatorChatForm')?.addEventListener('submit', async event => {
    event.preventDefault()
    const form = event.currentTarget
    const input = form.elements.message
    const message = String(input.value || '').trim()
    if (!message) return
    const button = form.querySelector('button[type="submit"]')
    history.push({ role: 'You', text: message, createdAt: new Date().toISOString() })
    input.value = ''
    button.disabled = true
    panel.classList.add('thinking')
    renderMessages()
    try {
      const result = await apiJSON('/api/v1/admin/coordinator/chat', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message }),
      })
      history.push({ role: 'Coordinator', text: result.answer || 'No response', createdAt: new Date().toISOString() })
      await refreshStatus()
    } catch (err) {
      history.push({ role: 'System', text: err.message === 'Method Not Allowed'
        ? 'Coordinator backend is updating. Try again in a few seconds.' : err.message, createdAt: new Date().toISOString() })
    } finally {
      button.disabled = false
      panel.classList.remove('thinking')
      renderMessages()
      input.focus()
    }
  })
}
