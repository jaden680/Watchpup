import {
  STATUS_LABEL, CAT_LABEL, CAT_ORDER, shortText, relativeTime, shortRef, debugRef,
  matchesQuery, hasOpenTodos, fmtMsgTime, authorColor, weekStart,
} from './format.js'
import { copyToClipboard, appendLinkified } from './richtext.js'
import { playbooks, playbookById } from './playbooks.js'
import { loadSettings, loadPlaybooks, showSset, setOnPlaybooksChanged } from './settings.js'
import { state, getChat, getActionLog, sortedMentions, nav } from './store.js'
import { renderDigest, renderTodosView } from './views.js'
import { renderActivityDetail, renderDetail } from './detail.js'
import { focusWorkItem, initWorkView, refreshWorkView } from './work.js'
import { normalizePanelTab, readPanelTab, writePanelTab } from './tab-state.js'

// playbook 변경 시 열린 상세의 액션 버튼 갱신(settings→panel 결합을 훅으로만)
setOnPlaybooksChanged(() => {
  if (state.current) {
    const m = state.mentions.get(state.current)
    if (m) renderDetail(m)
  }
})

// views 등 다른 모듈이 순환 import 없이 호출하도록 panel 함수를 nav에 등록(함수 선언은 hoisting).
Object.assign(nav, { select, renderList, ensureMentionsTab, refresh })

const listEl = document.getElementById('list')
const detailEl = document.getElementById('detail')
const agentListEl = document.getElementById('agent-list')
const agentDetailEl = document.getElementById('agent-detail')

const AGENT_STATE_LABEL = { running: '진행 중', done: '완료', waiting: '대기', error: '오류' }
let agentQuery = ''
let agentSource = ''
let agentState = ''
let agentPeriod = 'today'
let agentSort = 'newest'
let agentLoading = false
let agentRequest = 0

function agentSourceName(source) {
  return source === 'claude' ? 'Claude' : 'Codex'
}

function renderAgentEmpty() {
  if (!agentDetailEl) return
  delete agentDetailEl.dataset.activityId
  agentDetailEl.innerHTML = '<div class="empty"><div class="empty-mark">⌁</div><p class="empty-title">왼쪽에서 Agent 세션을 골라보세요</p><p class="empty-sub">Codex와 Claude의 진행 상태와 최근 대화를 확인할 수 있습니다.</p></div>'
}

function matchesAgentQuery(activity, query) {
  if (!query) return true
  const messages = Array.isArray(activity.messages) ? activity.messages.map((message) => message?.text || '').join(' ') : ''
  return [activity.title, activity.detail, activity.sessionId, messages]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
    .includes(query)
}

function renderAgentList() {
  if (!agentListEl) return
  agentListEl.replaceChildren()
  if (agentLoading) {
    const loading = document.createElement('p')
    loading.className = 'list-empty'
    loading.textContent = '세션 기록 불러오는 중…'
    agentListEl.append(loading)
    return
  }
  const query = agentQuery.trim().toLowerCase()
  const rows = state.activities
    .filter((activity) => !agentSource || activity.source === agentSource)
    .filter((activity) => !agentState || activity.state === agentState)
    .filter((activity) => matchesAgentQuery(activity, query))
    .sort((a, b) => agentSort === 'oldest' ? a.updatedAt - b.updatedAt : b.updatedAt - a.updatedAt)

  if (!rows.length) {
    const empty = document.createElement('p')
    empty.className = 'list-empty'
    empty.textContent = state.activities.length ? '조건에 맞는 Agent 세션이 없어요' : '선택한 기간에 Agent 세션이 없어요'
    agentListEl.append(empty)
    return
  }

  for (const activity of rows) {
    const card = document.createElement('div')
    card.className = `agent-card state-${activity.state || 'waiting'}${activity.id === state.currentActivity ? ' selected' : ''}`
    card.tabIndex = 0
    card.setAttribute('role', 'button')
    card.setAttribute('aria-label', `${agentSourceName(activity.source)} 세션 상세: ${activity.title || ''}`)

    const top = document.createElement('div')
    top.className = 'agent-card-top'
    const dot = document.createElement('span')
    dot.className = 'agent-state-dot'
    const source = document.createElement('span')
    source.className = `agent-source source-${activity.source}`
    source.textContent = agentSourceName(activity.source)
    const status = document.createElement('span')
    status.className = 'agent-card-status'
    status.textContent = AGENT_STATE_LABEL[activity.state] || '대기'
    const time = document.createElement('span')
    time.className = 'agent-card-time'
    time.textContent = relativeTime(activity.updatedAt)
    top.append(dot, source, status, time)

    const title = document.createElement('div')
    title.className = 'agent-card-title'
    title.textContent = activity.title || `${agentSourceName(activity.source)} 세션`
    const meta = document.createElement('div')
    meta.className = 'agent-card-meta'
    const context = Number.isFinite(activity.contextPercent) ? `컨텍스트 ${Math.round(activity.contextPercent)}%` : ''
    meta.textContent = [activity.detail, context].filter(Boolean).join(' · ') || activity.sessionId
    card.append(top, title, meta)
    card.addEventListener('click', () => selectActivity(activity.id))
    card.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return
      event.preventDefault()
      selectActivity(activity.id)
    })
    agentListEl.append(card)
  }
}

function selectActivity(id) {
  const activity = state.activities.find((row) => row.id === id)
  if (!activity) return
  state.current = null
  state.currentActivity = id
  renderAgentList()
  renderActivityDetail(activity, agentDetailEl)
}

async function refreshActivities() {
  const request = ++agentRequest
  const range = agentPeriod
  agentLoading = true
  renderAgentList()
  try {
    const rows = await window.watchpup.activityList(range)
    if (request !== agentRequest || range !== agentPeriod) return
    state.activities = Array.isArray(rows)
      ? rows.filter((row) => row?.source === 'codex' || row?.source === 'claude')
      : []
    if (state.currentActivity) {
      const activity = state.activities.find((row) => row.id === state.currentActivity)
      if (activity) renderActivityDetail(activity, agentDetailEl)
      else {
        state.currentActivity = null
        renderAgentEmpty()
      }
    }
  } finally {
    if (request === agentRequest) {
      agentLoading = false
      renderAgentList()
    }
  }
}

function activityMatchesPeriod(activity) {
  if (activity?.state === 'running' || agentPeriod === 'all') return true
  const updatedAt = Number(activity?.updatedAt)
  if (!Number.isFinite(updatedAt)) return false
  const now = Date.now()
  if (agentPeriod === 'recent') return now - updatedAt <= 30 * 60 * 1000
  if (agentPeriod === '7d') return now - updatedAt <= 7 * 24 * 60 * 60 * 1000
  const start = new Date(now)
  start.setHours(0, 0, 0, 0)
  return updatedAt >= start.getTime()
}




async function refresh() {
  const list = await window.watchpup.mentionsList()
  state.mentions = new Map(list.map((m) => [m.id, m]))
  renderList()
  if (state.current) {
    const m = state.mentions.get(state.current)
    if (m) renderDetail(m)
  }
}

// 디버그 참조: 멘션 id의 앞 6자 (Watchpup에게 "이 스레드요"라고 지목할 때 사용)

let listQuery = ''
let listCat = '' // '' = 전체
let todoOnly = false
let pendingThreadImportId = null
let importedThreadId = null
function matchesCat(m) {
  return !listCat || (m.analysis && m.analysis.category === listCat)
}

function renderList() {
  listEl.innerHTML = ''
  const q = listQuery.trim().toLowerCase()
  const items = sortedMentions().filter((m) => matchesCat(m) && matchesQuery(m, q) && (!todoOnly || hasOpenTodos(m)))
  if (!items.length) {
    const empty = document.createElement('p')
    empty.className = 'list-empty'
    empty.textContent = q ? '검색 결과 없음' : todoOnly ? '남은 할 일이 없어요 🎉' : (listCat ? '이 카테고리 항목이 없어요' : '아직 멘션이 없어요')
    listEl.appendChild(empty)
    return
  }
  for (const m of items) {
    const untracked = m.tracked === false
    const card = document.createElement('div')
    card.className = 'mention-card' + (m.id === state.current ? ' selected' : '') + (m.readAt ? '' : ' unread') + (untracked ? ' untracked' : '')
    card.dataset.id = m.id
    const top = document.createElement('div')
    top.className = 'card-top'
    const dot = document.createElement('span')
    dot.className = 'dot ' + m.status
    const channel = document.createElement('span')
    channel.className = 'channel'
    channel.textContent = m.channelName || m.channel
    top.append(dot, channel)
    const cat = m.analysis && m.analysis.category
    if (cat && CAT_LABEL[cat]) {
      const catEl = document.createElement('span')
      catEl.className = 'cat-badge cat-' + cat
      catEl.textContent = CAT_LABEL[cat]
      top.appendChild(catEl)
    }
    // 분석중이면 명시적으로 표시(점 + 텍스트)
    if (m.status === 'analyzing') {
      const ana = document.createElement('span')
      ana.className = 'analyzing-badge'
      ana.textContent = '분석중'
      top.appendChild(ana)
    }
    // 확인 상태: 할 일이 있으면 남은 개수(할 일 N) / 다 끝났으면 완료
    const todos = m.todos || []
    const openTodos = todos.filter((t) => !t.done).length
    if (m.status !== 'analyzing' && todos.length) {
      const tb = document.createElement('span')
      if (openTodos > 0) {
        tb.className = 'todo-badge open'
        tb.textContent = '할 일 ' + openTodos
      } else {
        tb.className = 'todo-badge done'
        tb.textContent = '✓ 완료'
      }
      top.appendChild(tb)
    }
    if (untracked) {
      const mute = document.createElement('span')
      mute.className = 'track-mark'
      mute.textContent = '🔕'
      mute.title = '추적 안 함'
      top.appendChild(mute)
    } else if (!m.readAt) {
      const badge = document.createElement('span')
      badge.className = 'unread-badge'
      badge.textContent = 'NEW'
      top.appendChild(badge)
    }
    const time = document.createElement('span')
    time.className = 'time'
    time.textContent = relativeTime(m.mentionedAt)
    top.appendChild(time)
    const author = document.createElement('div')
    author.className = 'author'
    const aname = document.createElement('span')
    aname.textContent = m.authorName || m.authorId || ''
    const acts = document.createElement('span')
    acts.className = 'card-acts'
    // 추적 토글
    const trackBtn = document.createElement('button')
    trackBtn.type = 'button'
    trackBtn.className = 'card-act'
    trackBtn.textContent = untracked ? '👁' : '🔕'
    trackBtn.title = untracked ? '추적 켜기' : '추적 끄기'
    trackBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      window.watchpup.setTracked(m.id, untracked).catch((err) => console.error('setTracked 실패', err))
    })
    // 제거
    const delBtn = document.createElement('button')
    delBtn.type = 'button'
    delBtn.className = 'card-act'
    delBtn.textContent = '✕'
    delBtn.title = '목록에서 제거'
    delBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      if (!confirm('이 스레드를 목록에서 제거할까요?')) return
      if (state.current === m.id) state.current = null
      window.watchpup.removeMention(m.id).catch((err) => console.error('removeMention 실패', err))
    })
    acts.append(trackBtn, delBtn)
    author.append(aname, acts)
    const preview = document.createElement('div')
    preview.className = 'preview'
    preview.textContent = shortText(m.text, 90)
    card.append(top, author, preview)
    card.addEventListener('click', () => select(m.id))
    listEl.appendChild(card)
  }
}

function select(id) {
  state.currentActivity = null
  state.current = id
  const m = state.mentions.get(id)
  if (m && !m.readAt) {
    m.readAt = Date.now()
    window.watchpup.mentionRead(id).catch((e) => console.error('mentionRead 실패', e))
  }
  // 마스터-디테일: 같은 창 오른쪽에 즉시 표시(팝업 없음).
  renderList()
  if (m) renderDetail(m)
}

window.watchpup.onMentionNew((m) => {
  state.mentions.set(m.id, m)
  renderList()
  if (pendingThreadImportId === m.id) {
    pendingThreadImportId = null
    setThreadImportState('추가됨 · 분석 중')
    select(m.id)
  }
})

window.watchpup.onMentionReady((m) => {
  state.mentions.set(m.id, m)
  renderList()
  if (state.current === m.id) renderDetail(m)
  if (importedThreadId === m.id) {
    importedThreadId = null
    setThreadImportState('과거 스레드 분석 완료', 4000)
  }
})

// 채널 라벨 일괄 갱신 등 → 목록/상세 새로고침
if (window.watchpup.onMentionsRefresh) window.watchpup.onMentionsRefresh(() => refresh())

// ---- 탭 전환 ----
function activateTab(name, { persist = true } = {}) {
  const normalized = normalizePanelTab(name)
  const tab = document.querySelector(`.tab[data-tab="${normalized}"]`)
  const view = document.getElementById(normalized + '-view')
  if (!tab || !view) return

  document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'))
  document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'))
  tab.classList.add('active')
  view.classList.add('active')
  if (persist) writePanelTab(normalized)

  if (normalized === 'settings') {
    loadSettings()
    loadPlaybooks()
    showSset('detect')
  } else if (normalized === 'digest') {
    refresh().then(renderDigest).catch(renderDigest)
  } else if (normalized === 'todos') {
    refresh().then(renderTodosView).catch(renderTodosView)
  } else if (normalized === 'agent') {
    refreshActivities().catch(() => {})
  } else if (normalized === 'work') {
    initWorkView().catch(() => {})
  }
}

document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => activateTab(tab.dataset.tab))
})

activateTab(readPanelTab(), { persist: false })

// ESC: 텍스트 입력 중이면 먼저 포커스 해제, 아니면 패널 닫기(숨김)
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return
  const el = document.activeElement
  if (el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) {
    el.blur()
  } else {
    window.watchpup.hidePanel()
  }
})
// 맥 스타일 창 컨트롤(신호등)
const wcClose = document.getElementById('wc-close')
const wcMin = document.getElementById('wc-min')
const wcMax = document.getElementById('wc-max')
if (wcClose) wcClose.addEventListener('click', () => window.watchpup.hidePanel())
if (wcMin) wcMin.addEventListener('click', () => window.watchpup.minimizePanel())
if (wcMax) wcMax.addEventListener('click', () => window.watchpup.maximizePanel())

// 목록 검색
const searchInput = document.getElementById('list-search-input')
if (searchInput) {
  searchInput.addEventListener('input', () => {
    listQuery = searchInput.value
    renderList()
  })
}

const threadImportButton = document.getElementById('thread-import-open')
const threadImportState = document.getElementById('thread-import-state')

function setThreadImportState(text, clearAfterMs = 0) {
  if (!threadImportState) return
  threadImportState.textContent = text
  if (clearAfterMs) setTimeout(() => {
    if (threadImportState.textContent === text) threadImportState.textContent = ''
  }, clearAfterMs)
}

function threadImportError(error) {
  const message = error?.message || String(error || '')
  if (message.includes('missing_scope')) {
    return 'User Token에 채널 기록 읽기 권한이 없어요. 설정의 새 매니페스트로 Slack 앱을 재설치해주세요.'
  }
  if (message.includes('channel_not_found') || message.includes('no_permission')) {
    return '이 채널을 읽을 수 없어요. User Token 계정의 채널 접근 권한을 확인해주세요.'
  }
  return message.replace(/^Error invoking remote method '[^']+': Error: /, '') || '스레드를 추가하지 못했습니다.'
}

function openThreadImportModal() {
  const overlay = document.createElement('div')
  overlay.className = 'modal-overlay'
  const box = document.createElement('form')
  box.className = 'modal-box modal-form'
  const title = document.createElement('div')
  title.className = 'modal-title'
  title.textContent = '과거 Slack 스레드 추가'
  const label = document.createElement('label')
  label.className = 'modal-field'
  label.textContent = 'Slack 메시지 링크'
  const input = document.createElement('input')
  input.type = 'url'
  input.required = true
  input.placeholder = 'https://workspace.slack.com/archives/…'
  input.autocomplete = 'off'
  label.append(input)
  const hint = document.createElement('p')
  hint.className = 'modal-hint'
  hint.textContent = 'Slack에서 스레드의 메시지를 우클릭하고 “링크 복사”한 주소를 붙여넣으세요. 과거 내용은 한 번만 분석하고 이후 새 답글부터 추적합니다.'
  const bar = document.createElement('div')
  bar.className = 'modal-bar'
  const status = document.createElement('span')
  status.className = 'reply-status'
  status.setAttribute('role', 'status')
  const cancel = document.createElement('button')
  cancel.type = 'button'
  cancel.textContent = '취소'
  const submit = document.createElement('button')
  submit.type = 'submit'
  submit.className = 'primary'
  submit.textContent = '추가 및 분석'
  bar.append(status, cancel, submit)
  box.append(title, label, hint, bar)
  overlay.append(box)
  document.body.append(overlay)

  const dismiss = () => overlay.remove()
  cancel.addEventListener('click', dismiss)
  overlay.addEventListener('click', (event) => { if (event.target === overlay) dismiss() })
  box.addEventListener('submit', async (event) => {
    event.preventDefault()
    const permalink = input.value.trim()
    if (!permalink) return
    input.disabled = true
    submit.disabled = true
    status.textContent = '스레드 확인 중…'
    try {
      const result = await window.watchpup.threadImport(permalink)
      pendingThreadImportId = result.id
      importedThreadId = result.existing ? null : result.id
      dismiss()
      if (result.existing) {
        pendingThreadImportId = null
        await refresh()
        select(result.id)
        setThreadImportState('이미 추가된 스레드 · 추적 켜짐', 4000)
        return
      }
      setThreadImportState('스레드를 가져오는 중…')
      await refresh()
      if (state.mentions.has(result.id)) {
        pendingThreadImportId = null
        select(result.id)
        setThreadImportState('추가됨 · 분석 중')
      }
    } catch (error) {
      input.disabled = false
      submit.disabled = false
      status.textContent = threadImportError(error)
      input.focus()
    }
  })
  requestAnimationFrame(() => input.focus())
}

if (threadImportButton) threadImportButton.addEventListener('click', openThreadImportModal)

// 카테고리 필터(이슈/프로젝트/문의/잡담)
document.querySelectorAll('.cat-chip').forEach((chip) => {
  chip.addEventListener('click', () => {
    listCat = chip.dataset.cat || ''
    document.querySelectorAll('.cat-chip').forEach((c) => c.classList.toggle('active', c === chip))
    renderList()
  })
})

// 할 일 남음만 토글
const todoOnlyChip = document.getElementById('todo-only')
if (todoOnlyChip) {
  todoOnlyChip.addEventListener('click', () => {
    todoOnly = !todoOnly
    todoOnlyChip.classList.toggle('active', todoOnly)
    todoOnlyChip.textContent = (todoOnly ? '☑' : '☐') + ' 할 일 남음만'
    renderList()
  })
}

// Agent 세션 검색·필터·정렬
const agentSearchInput = document.getElementById('agent-search-input')
const agentSourceFilter = document.getElementById('agent-source-filter')
const agentStateFilter = document.getElementById('agent-state-filter')
const agentPeriodFilter = document.getElementById('agent-period-filter')
const agentSortSelect = document.getElementById('agent-sort')
if (agentSearchInput) {
  agentSearchInput.addEventListener('input', () => {
    agentQuery = agentSearchInput.value
    renderAgentList()
  })
}
if (agentSourceFilter) {
  agentSourceFilter.addEventListener('change', () => {
    agentSource = agentSourceFilter.value
    renderAgentList()
  })
}
if (agentStateFilter) {
  agentStateFilter.addEventListener('change', () => {
    agentState = agentStateFilter.value
    renderAgentList()
  })
}
if (agentPeriodFilter) {
  agentPeriodFilter.addEventListener('change', () => {
    agentPeriod = agentPeriodFilter.value
    refreshActivities().catch(() => {})
  })
}
if (agentSortSelect) {
  agentSortSelect.addEventListener('change', () => {
    agentSort = agentSortSelect.value
    renderAgentList()
  })
}

// 목록 너비 드래그(비율로 저장·복원 — zoom 좌표 영향 없음)
const LIST_W_KEY = 'watchpup.listRatio'
const listCol = document.getElementById('list-col')
const listDivider = document.getElementById('list-divider')
function applyListRatio(r) {
  const ratio = Math.max(0.16, Math.min(0.5, r))
  if (listCol) listCol.style.flexBasis = (ratio * 100).toFixed(2) + '%'
}
applyListRatio(parseFloat(localStorage.getItem(LIST_W_KEY) || '') || 0.22)
if (listDivider) {
  let draggingList = false
  const onMove = (e) => {
    if (!draggingList) return
    const rect = document.getElementById('mentions-view').getBoundingClientRect()
    const r = (e.clientX - rect.left) / rect.width
    applyListRatio(r)
    localStorage.setItem(LIST_W_KEY, String(r))
  }
  const stop = () => {
    draggingList = false
    document.body.classList.remove('col-resizing')
    window.removeEventListener('mousemove', onMove)
    window.removeEventListener('mouseup', stop)
  }
  listDivider.addEventListener('mousedown', (e) => {
    e.preventDefault()
    draggingList = true
    document.body.classList.add('col-resizing')
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', stop)
  })
}

// Agent 목록 너비도 독립적으로 저장
const AGENT_LIST_W_KEY = 'watchpup.agentListRatio'
const agentListCol = document.getElementById('agent-list-col')
const agentListDivider = document.getElementById('agent-list-divider')
function applyAgentListRatio(r) {
  const ratio = Math.max(0.16, Math.min(0.5, r))
  if (agentListCol) agentListCol.style.flexBasis = (ratio * 100).toFixed(2) + '%'
}
applyAgentListRatio(parseFloat(localStorage.getItem(AGENT_LIST_W_KEY) || '') || 0.28)
if (agentListDivider) {
  let draggingAgentList = false
  const onMove = (e) => {
    if (!draggingAgentList) return
    const rect = document.getElementById('agent-view').getBoundingClientRect()
    const r = (e.clientX - rect.left) / rect.width
    applyAgentListRatio(r)
    localStorage.setItem(AGENT_LIST_W_KEY, String(r))
  }
  const stop = () => {
    draggingAgentList = false
    document.body.classList.remove('col-resizing')
    window.removeEventListener('mousemove', onMove)
    window.removeEventListener('mouseup', stop)
  }
  agentListDivider.addEventListener('mousedown', (e) => {
    e.preventDefault()
    draggingAgentList = true
    document.body.classList.add('col-resizing')
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', stop)
  })
}

function ensureTab(name) {
  const tab = document.querySelector(`.tab[data-tab="${name}"]`)
  if (tab && !tab.classList.contains('active')) activateTab(name)
}
function ensureMentionsTab() {
  ensureTab('mentions')
}
function ensureAgentTab() {
  ensureTab('agent')
}
function ensureWorkTab() {
  ensureTab('work')
}
// HUD의 Claude/Codex 행 클릭 → Watchpup 내부 세션 상세
if (window.watchpup.onActivityFocus) {
  window.watchpup.onActivityFocus((id) => {
    if (typeof id !== 'string' || !id) return
    ensureAgentTab()
    refreshActivities().then(() => selectActivity(id)).catch(() => {})
  })
}
if (window.watchpup.onActivitySessions) {
  window.watchpup.onActivitySessions((rows) => {
    if (!Array.isArray(rows)) return
    const live = rows.filter((row) => row?.source === 'codex' || row?.source === 'claude')
    if (agentPeriod === 'recent') {
      state.activities = live
    } else {
      const merged = new Map(state.activities.map((row) => [row.id, row]))
      for (const row of live) merged.set(row.id, row)
      state.activities = [...merged.values()].filter(activityMatchesPeriod)
    }
    renderAgentList()
    if (!state.currentActivity) return
    const activity = state.activities.find((row) => row?.id === state.currentActivity)
    if (activity) renderActivityDetail(activity, agentDetailEl)
    else {
      state.currentActivity = null
      renderAgentList()
      renderAgentEmpty()
    }
  })
}
// 말풍선 클릭으로 특정 스레드 열기
if (window.watchpup.onMentionFocus) {
  window.watchpup.onMentionFocus((id) => {
    if (typeof id !== 'string' || !id) return
    state.currentActivity = null
    ensureMentionsTab()
    // 목록에 없을 수 있으니 최신 목록을 먼저 반영 후 선택
    refresh().then(() => {
      if (state.mentions.has(id)) select(id)
    }).catch(() => { if (state.mentions.has(id)) select(id) })
  })
}
if (window.watchpup.onWorkFocus) {
  window.watchpup.onWorkFocus((id) => {
    if (typeof id !== 'string' || !id) return
    ensureWorkTab()
    focusWorkItem(id).catch(() => {})
  })
}

refresh()
loadPlaybooks()
