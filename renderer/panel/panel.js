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
})

window.watchpup.onMentionReady((m) => {
  state.mentions.set(m.id, m)
  renderList()
  if (state.current === m.id) renderDetail(m)
})

// 채널 라벨 일괄 갱신 등 → 목록/상세 새로고침
if (window.watchpup.onMentionsRefresh) window.watchpup.onMentionsRefresh(() => refresh())

// ---- 탭 전환 ----
document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'))
    document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'))
    tab.classList.add('active')
    document.getElementById(tab.dataset.tab + '-view').classList.add('active')
    if (tab.dataset.tab === 'settings') {
      loadSettings()
      loadPlaybooks()
      showSset('detect')
    } else if (tab.dataset.tab === 'digest') {
      refresh().then(renderDigest).catch(renderDigest)
    } else if (tab.dataset.tab === 'todos') {
      refresh().then(renderTodosView).catch(renderTodosView)
    }
  })
})

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

// 펫 클릭으로 열 때: 항상 멘션 탭부터(직전 설정 탭 잔상 방지)
function ensureMentionsTab() {
  const mtab = document.querySelector('.tab[data-tab="mentions"]')
  if (mtab && !mtab.classList.contains('active')) mtab.click()
}
if (window.watchpup.onPanelShown) {
  window.watchpup.onPanelShown(() => ensureMentionsTab())
}
// HUD의 Claude/Codex 행 클릭 → Watchpup 내부 세션 상세
if (window.watchpup.onActivityFocus) {
  window.watchpup.onActivityFocus((id) => {
    if (typeof id !== 'string' || !id) return
    ensureMentionsTab()
    window.watchpup.activityList().then((rows) => {
      const activity = Array.isArray(rows) ? rows.find((row) => row?.id === id) : null
      if (!activity) return
      state.current = null
      state.currentActivity = id
      renderList()
      renderActivityDetail(activity)
    }).catch(() => {})
  })
}
if (window.watchpup.onActivitySessions) {
  window.watchpup.onActivitySessions((rows) => {
    if (!state.currentActivity || !Array.isArray(rows)) return
    const activity = rows.find((row) => row?.id === state.currentActivity)
    if (activity) renderActivityDetail(activity)
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

refresh()
loadPlaybooks()
