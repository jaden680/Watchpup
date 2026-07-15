import { activityStateLabel, formatElapsed } from './activity-format.js'
import { bubbleOpenTarget, bubbleSurfaceState, canIncomingBubbleReplaceStream, hudFoldContent } from './bubble-surface.js'

const pet = document.getElementById('pet')
const petImg = document.getElementById('pet-img')
const petSprite = document.getElementById('pet-sprite')
const face = pet.querySelector('.face')
const badge = document.getElementById('badge')
const bubble = document.getElementById('bubble')
const activityHud = document.getElementById('activity-hud')
const hudFold = document.getElementById('hud-fold')
const hudFoldCount = document.getElementById('hud-fold-count')
const hudFoldAction = document.getElementById('hud-fold-action')
const hudMessage = document.getElementById('hud-message')
const hudMessageText = document.getElementById('hud-message-text')
const activityList = document.getElementById('activity-list')
const STATES = ['idle', 'thinking', 'ready', 'chatting']

// ---- 테마(글리프) / 커스텀 이미지 / Codex Pet 팩 ----
const THEMES = window.PET_THEMES || {}
let theme = THEMES.paw || { idle: '🐾', thinking: '🐾', ready: '🐾', chatting: '🐾' }
let images = {} // 상태별 file:// 경로 (하나라도 있으면 이미지 모드)
let codex = null // { spritesheet, displayName } | null (설정 시 gif/이모지보다 우선)
let currentState = 'idle'
let petSizePercent = 100
let bubbleSizePercent = 100
let currentBubbleText = ''
let hudSizePercent = 100
let hudAlignment = 'right'
let showActivityHud = true
let bubbleActive = false
let hudFolded = localStorage.getItem('watchpup.hudFolded') === '1'

function imageMode() {
  return Object.keys(images).length > 0
}
function codexMode() {
  return !!codex
}

// ---- Codex Pet 스프라이트 프레임 루프 ----
const BASE_CODEX_DISPLAY_H = 128 // 펫 표시 높이(PET_AREA와 동일하게 유지)
let codexFrameIndex = 0
let codexTimer = null
// passive(idle/ready) 상태에서 한 종류만 돌지 않도록 여러 동작을 번갈아 재생.
// idle(0)·waiting(6)·waving(3)·jumping(5=laughing) — 있는 행만 사용.
const AMBIENT_ROWS = [0, 6, 3, 4]
let ambientRow = 0
let ambientCycles = 0

function isPassiveState() {
  return currentState === 'idle' || currentState === 'ready'
}
// 현재 표시할 스프라이트 행: 능동 상태는 상태 매핑, passive는 ambient 로테이션.
function currentRowIdx() {
  if (isPassiveState()) return ambientRow
  return (window.CODEX_STATE_ROW && window.CODEX_STATE_ROW[currentState]) ?? 0
}

function codexTick() {
  if (!codexMode()) {
    codexTimer = null
    return
  }
  const atlas = window.CODEX_ATLAS
  const rows = window.CODEX_ROWS
  if (!atlas || !rows) {
    codexTimer = null
    return
  }
  let rowIdx = currentRowIdx()
  let row = rows[rowIdx]
  if (!row) {
    rowIdx = 0
    row = rows[0]
  }
  if (codexFrameIndex >= row.frames) codexFrameIndex = 0
  const scale = (BASE_CODEX_DISPLAY_H * petSizePercent / 100) / atlas.cellH
  const w = Math.round(atlas.cellW * scale)
  const h = Math.round(atlas.cellH * scale)
  petSprite.style.width = w + 'px'
  petSprite.style.height = h + 'px'
  petSprite.style.backgroundSize = Math.round(atlas.cols * atlas.cellW * scale) + 'px ' + Math.round(atlas.rows * atlas.cellH * scale) + 'px'
  petSprite.style.backgroundPosition =
    '-' + Math.round(codexFrameIndex * atlas.cellW * scale) + 'px -' + Math.round(rowIdx * atlas.cellH * scale) + 'px'
  const dur = row.durations[codexFrameIndex] || 150
  codexFrameIndex = (codexFrameIndex + 1) % row.frames
  // 한 사이클(마지막 프레임까지) 끝나면: passive면 몇 사이클마다 다른 ambient 동작으로 전환
  if (codexFrameIndex === 0 && isPassiveState()) {
    ambientCycles++
    if (ambientCycles >= 2) {
      ambientCycles = 0
      let next = ambientRow
      while (next === ambientRow && AMBIENT_ROWS.length > 1) {
        next = AMBIENT_ROWS[Math.floor(Math.random() * AMBIENT_ROWS.length)]
      }
      ambientRow = next
    }
  }
  codexTimer = setTimeout(codexTick, dur)
}

function startCodexLoop() {
  if (codexTimer) return // 이미 실행 중 — currentState는 매 tick마다 live로 읽음
  codexTick()
}
function stopCodexLoop() {
  if (codexTimer) {
    clearTimeout(codexTimer)
    codexTimer = null
  }
}

function applyFace() {
  if (codexMode()) {
    pet.classList.remove('img-mode')
    pet.classList.add('codex-mode')
    face.classList.add('hidden')
    petImg.classList.add('hidden')
    petSprite.classList.remove('hidden')
    startCodexLoop()
  } else {
    pet.classList.remove('codex-mode')
    stopCodexLoop()
    petSprite.classList.add('hidden')
    if (imageMode()) {
      pet.classList.add('img-mode')
      face.classList.add('hidden')
      const src = images[currentState] || images.idle || Object.values(images)[0]
      if (src && petImg.getAttribute('src') !== src) petImg.setAttribute('src', src)
      petImg.classList.remove('hidden')
    } else {
      pet.classList.remove('img-mode')
      petImg.classList.add('hidden')
      face.classList.remove('hidden')
      face.textContent = theme[currentState] || theme.idle || '🐾'
    }
  }
}

function setTheme(name) {
  if (name && THEMES[name]) {
    theme = THEMES[name]
    applyFace()
  }
}
function setImages(map) {
  images = map && typeof map === 'object' ? map : {}
  applyFace()
}
function setCodex(v) {
  const next = v && typeof v === 'object' && v.spritesheet ? v : null
  codex = next
  if (codex) petSprite.style.backgroundImage = 'url("' + codex.spritesheet + '")'
  applyFace()
}

function setPetSize(value) {
  const parsed = Number(value)
  petSizePercent = Number.isFinite(parsed) ? Math.max(50, Math.min(200, Math.round(parsed))) : 100
  const scale = petSizePercent / 100
  document.documentElement.style.setProperty('--pet-circle-size', `${Math.round(104 * scale)}px`)
  document.documentElement.style.setProperty('--pet-media-size', `${Math.round(128 * scale)}px`)
  document.documentElement.style.setProperty('--pet-face-size', `${Math.round(46 * scale)}px`)
  if (codexMode()) {
    stopCodexLoop()
    codexFrameIndex = 0
    startCodexLoop()
  }
  syncSize()
}

function clampSurfaceSize(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.max(60, Math.min(140, Math.round(parsed))) : 100
}

function setBubbleSize(value) {
  bubbleSizePercent = clampSurfaceSize(value)
  const scale = bubbleSizePercent / 100
  const root = document.documentElement.style
  const paddingY = Math.round(9 * scale)
  const fontSize = Math.max(10, Math.round(13 * scale))
  const lineHeight = fontSize * 1.35
  root.setProperty('--bubble-max-width', `${Math.round(320 * scale)}px`)
  root.setProperty('--bubble-padding-y', `${paddingY}px`)
  root.setProperty('--bubble-padding-x', `${Math.round(14 * scale)}px`)
  root.setProperty('--bubble-radius', `${Math.round(20 * scale)}px`)
  root.setProperty('--bubble-font-size', `${fontSize}px`)
  root.setProperty('--bubble-line-height', `${lineHeight}px`)
  root.setProperty('--bubble-max-height', `${Math.ceil(lineHeight * 4 + paddingY * 2 + 2)}px`)
  if (currentBubbleText && !bubble.classList.contains('hidden')) renderBubbleText(currentBubbleText)
  syncSize()
}

function setHudSize(value) {
  hudSizePercent = clampSurfaceSize(value)
  const scale = hudSizePercent / 100
  const root = document.documentElement.style
  const px = (name, base, minimum = 1) => root.setProperty(name, `${Math.max(minimum, Math.round(base * scale))}px`)
  px('--hud-width', 532)
  px('--hud-padding', 7)
  px('--hud-radius', 16)
  px('--hud-row-height', 38)
  px('--hud-dot-column', 8)
  px('--hud-icon-column', 24)
  px('--hud-row-gap', 8)
  px('--hud-row-padding', 9)
  px('--hud-row-radius', 10)
  px('--hud-dot-size', 7, 4)
  px('--hud-icon-size', 22, 12)
  px('--hud-icon-radius', 6)
  px('--hud-title-size', 13, 9)
  px('--hud-pill-padding-y', 3)
  px('--hud-pill-padding-x', 7)
  px('--hud-meta-size', 10, 8)
  px('--hud-elapsed-width', 31)
  px('--hud-badge-size', 38, 30)
  syncSize()
}

function setHudAlignment(value) {
  hudAlignment = value === 'left' ? 'left' : 'right'
  document.body.classList.toggle('hud-align-left', hudAlignment === 'left')
  document.body.classList.toggle('hud-align-right', hudAlignment === 'right')
  syncSize()
}

function updateHudFoldControl() {
  const content = hudFoldContent({
    activityCount: activityList.childElementCount,
    folded: hudFolded,
  })
  activityHud.classList.toggle('folded', hudFolded)
  hudFoldCount.textContent = content.visibleLabel
  hudFoldAction.textContent = content.actionLabel
  hudFold.setAttribute('aria-expanded', String(!hudFolded))
  hudFold.setAttribute('aria-label', `${content.accessibleLabel}, ${content.actionLabel}`)
}

function setHudFolded(value) {
  hudFolded = !!value
  localStorage.setItem('watchpup.hudFolded', hudFolded ? '1' : '0')
  updateHudFoldControl()
  // 접기·펼치기에서는 펫의 화면 위치를 고정하고 HUD가 아래로 늘어나게 한다.
  syncSize('top')
}

function updateHudVisibility() {
  const state = bubbleSurfaceState({ active: bubbleActive, showActivityHud, activityCount: activityList.childElementCount })
  activityHud.classList.toggle('hidden', !state.hudVisible)
  syncSize()
}

function setHudVisibility(value) {
  showActivityHud = value !== false
  renderBubbleSurface()
}

window.watchpup.settingsGet().then((cfg) => {
  setTheme(cfg?.petTheme)
  setPetSize(cfg?.petSizePercent)
  setBubbleSize(cfg?.bubbleSizePercent)
  setHudSize(cfg?.hudSizePercent)
  setHudAlignment(cfg?.hudAlignment)
  setHudVisibility(cfg?.showActivityHud)
}).catch(() => {})
window.watchpup.petImages().then(setImages).catch(() => {})
window.watchpup.petCodex().then(setCodex).catch(() => {})
if (window.watchpup.onPetTheme) window.watchpup.onPetTheme((n) => setTheme(typeof n === 'string' ? n : undefined))
if (window.watchpup.onPetImages) window.watchpup.onPetImages(setImages)
if (window.watchpup.onPetCodex) window.watchpup.onPetCodex(setCodex)
if (window.watchpup.onPetSize) window.watchpup.onPetSize(setPetSize)
if (window.watchpup.onBubbleSize) window.watchpup.onBubbleSize(setBubbleSize)
if (window.watchpup.onHudSize) window.watchpup.onHudSize(setHudSize)
if (window.watchpup.onHudAlignment) window.watchpup.onHudAlignment(setHudAlignment)
if (window.watchpup.onHudVisibility) window.watchpup.onHudVisibility(setHudVisibility)

window.watchpup.onPet((s) => {
  currentState = STATES.includes(s) ? s : 'idle'
  STATES.forEach((c) => pet.classList.remove(c))
  pet.classList.add(currentState)
  codexFrameIndex = 0
  applyFace()
})

window.watchpup.onBadge((n) => {
  if (typeof n === 'number' && n > 0) {
    badge.textContent = String(n)
    badge.classList.remove('hidden')
  } else {
    badge.classList.add('hidden')
  }
})

// ---- 말풍선 + 다이나믹 창 크기 ----
// 말풍선 내용에 맞춰 펫 창 높이를 조절(하단 고정 → 위로 확장). main의 pet.resize가 처리.
const BASE_PET_AREA = 128 // 펫 영역 높이(이미지/코덱스 스프라이트 최대) 근사
const HUD_SAFE_X = 28
// 상단패딩(10) + HUD 그림자 안전 여백(34) + 펫 그림자/발 여유(14)
const PET_CHROME = 10 + 34 + 14
function syncSize(verticalAnchor = 'bottom') {
  requestAnimationFrame(() => {
    const visible = !bubble.classList.contains('hidden')
    const bubbleH = visible ? bubble.getBoundingClientRect().height : 0
    const petArea = BASE_PET_AREA * petSizePercent / 100
    const hudVisible = !activityHud.classList.contains('hidden')
    const hudH = hudVisible ? activityHud.getBoundingClientRect().height : 0
    const visibleBlocks = 1 + Number(visible) + Number(hudVisible)
    const gaps = Math.max(0, visibleBlocks - 1) * 12
    const need = petArea + bubbleH + hudH + gaps + PET_CHROME
    // 현재 창이 좁아도 설정값 기준 목표 폭을 계산해야 다시 넓힐 수 있다.
    const expandedHudWidth = Math.ceil(532 * hudSizePercent / 100 + HUD_SAFE_X * 2)
    const foldedHudWidth = Math.ceil(Math.max(30, 38 * hudSizePercent / 100) + HUD_SAFE_X * 2)
    const hudWidth = hudVisible ? (hudFolded ? foldedHudWidth : expandedHudWidth) : 0
    window.watchpup.petResize({
      width: hudVisible ? Math.max(340, hudWidth) : 340,
      height: Math.ceil(need),
      anchor: hudAlignment,
      verticalAnchor,
    })
  })
}

const ACTIVITY_ICONS = {
  claude: './assets/claude.png',
  codex: './assets/codex.png',
  slack: './assets/slack.png',
}
const ACTIVITY_NAMES = { claude: 'Claude', codex: 'Codex', slack: 'Slack' }
let activities = []

function createActivityRow() {
  const row = document.createElement('div')
  row.tabIndex = 0
  row.setAttribute('role', 'button')

  const dot = document.createElement('span')
  dot.className = 'activity-dot'
  dot.setAttribute('aria-hidden', 'true')
  const icon = document.createElement('img')
  icon.className = 'activity-icon'
  icon.alt = ''
  const title = document.createElement('span')
  title.className = 'activity-title'
  const state = document.createElement('span')
  state.className = 'activity-state'
  const context = document.createElement('span')
  context.className = 'activity-context'
  row.append(dot, icon, title, state, context)
  const elapsed = document.createElement('span')
  elapsed.className = 'activity-elapsed'
  row.append(elapsed)
  row.addEventListener('click', () => window.watchpup.openActivityDetail(row.dataset.activityId))
  row.addEventListener('keydown', (event) => {
    if (event.target !== row || (event.key !== 'Enter' && event.key !== ' ')) return
    event.preventDefault()
    window.watchpup.openActivityDetail(row.dataset.activityId)
  })
  row.activityElements = { icon, title, state, context, elapsed }
  return row
}

function updateActivityRow(row, activity) {
  const { icon, title, state, context, elapsed } = row.activityElements
  row.dataset.activityId = activity.id
  row.className = `activity-row state-${activity.state || 'waiting'}`
  row.title = `Watchpup에서 보기 · ${activity.title || ''}`
  row.setAttribute('aria-label', `Watchpup에서 상세 보기: ${activity.title || ''}`)
  icon.src = ACTIVITY_ICONS[activity.source]
  title.textContent = activity.title || `${ACTIVITY_NAMES[activity.source]} 세션`
  state.textContent = activityStateLabel(activity.state)
  context.hidden = !Number.isFinite(activity.contextPercent)
  context.textContent = context.hidden ? '' : `${Math.round(activity.contextPercent)}%`
  elapsed.textContent = formatElapsed(activity.updatedAt)
}

function renderActivities(rows) {
  activities = Array.isArray(rows) ? rows.slice(0, 5) : []
  const visibleActivities = activities.filter((activity) => activity && ACTIVITY_ICONS[activity.source])
  const existingRows = new Map(
    Array.from(activityList.children).map((row) => [row.dataset.activityId, row]),
  )

  visibleActivities.forEach((activity, index) => {
    const row = existingRows.get(activity.id) || createActivityRow()
    updateActivityRow(row, activity)
    const rowAtIndex = activityList.children[index]
    if (rowAtIndex !== row) activityList.insertBefore(row, rowAtIndex || null)
    existingRows.delete(activity.id)
  })
  for (const staleRow of existingRows.values()) {
    staleRow.remove()
  }
  updateHudFoldControl()
  updateHudVisibility()
}

window.watchpup.activityList().then(renderActivities).catch(() => {})
window.watchpup.onActivitySessions(renderActivities)
setInterval(() => renderActivities(activities), 30_000)

let bubbleTimer = null
let chatStreaming = false
let chatBuf = ''
let chatStartTimer = null
const CHAT_START_TIMEOUT_MS = 60_000

function clearChatStartTimer() {
  if (!chatStartTimer) return
  clearTimeout(chatStartTimer)
  chatStartTimer = null
}

function finishChatStreaming() {
  clearChatStartTimer()
  chatStreaming = false
  bubble.classList.remove('streaming')
  hudMessage.classList.remove('streaming')
}

function renderBubbleSurface() {
  const state = bubbleSurfaceState({ active: bubbleActive, showActivityHud, activityCount: activityList.childElementCount })
  bubble.classList.toggle('hidden', !state.bubbleVisible)
  hudMessage.classList.toggle('hidden', !state.hudMessageVisible)
  updateHudFoldControl()
  updateHudVisibility()
}

function hideBubbleSurface() {
  bubbleActive = false
  renderBubbleSurface()
}

function renderBubbleText(text) {
  bubble.style.width = ''
  bubble.textContent = text
  if (bubble.scrollHeight <= bubble.clientHeight) return

  // 전체 문장으로 결정된 폭을 고정한 뒤, 가장 최근 4줄이 온전히 들어오는 접점을 찾는다.
  bubble.style.width = `${bubble.getBoundingClientRect().width}px`
  let low = 0
  let high = text.length
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    bubble.textContent = `…${text.slice(middle).trimStart()}`
    if (bubble.scrollHeight <= bubble.clientHeight) high = middle
    else low = middle + 1
  }

  const suffix = text.slice(low)
  const nextWord = suffix.search(/\s/)
  const start = nextWord >= 0 && nextWord < suffix.length - 1 ? low + nextWord + 1 : low
  bubble.textContent = `…${text.slice(start).trimStart()}`
}

function showBubble(text, hideAfterMs) {
  currentBubbleText = text
  hudMessageText.textContent = text
  hudMessage.title = text
  bubble.setAttribute('aria-label', text)
  bubbleActive = true
  renderBubbleSurface()
  renderBubbleText(text)
  if (bubbleTimer) clearTimeout(bubbleTimer)
  if (hideAfterMs) {
    bubbleTimer = setTimeout(hideBubbleSurface, hideAfterMs)
  }
}

let bubbleMentionId = null
let bubbleWorkItemId = null
let bubbleActivityId = null
let bubbleCalendarEvent = false
let bubbleCalendarPrivacy = false
let bubbleExternalUrl = null
let bubbleBuildTool = null
window.watchpup.onBubble((payload) => {
  // payload: string(구버전/idle) 또는 연결 대상이 포함된 말풍선 객체.
  const text = typeof payload === 'string' ? payload : payload && payload.text
  const id = typeof payload === 'object' && payload ? payload.mentionId : null
  const workItemId = typeof payload === 'object' && payload ? payload.workItemId : null
  const activityId = typeof payload === 'object' && payload ? payload.activityId : null
  const calendarEvent = typeof payload === 'object' && payload ? payload.calendarEvent === true : false
  const calendarPrivacy = typeof payload === 'object' && payload ? payload.calendarPrivacy === true : false
  const externalUrl = typeof payload === 'object' && payload ? (payload.externalUrl || payload.slackNewsUrl) : null
  const buildTool = typeof payload === 'object' && payload ? payload.buildTool : null
  if (typeof text !== 'string' || !text) return
  if (!canIncomingBubbleReplaceStream(chatStreaming, chatBuf)) return
  if (chatStreaming) finishChatStreaming()
  bubbleMentionId = id || null
  bubbleWorkItemId = workItemId || null
  bubbleActivityId = activityId || null
  bubbleCalendarEvent = calendarEvent
  bubbleCalendarPrivacy = calendarPrivacy
  bubbleExternalUrl = typeof externalUrl === 'string' ? externalUrl : null
  bubbleBuildTool = buildTool === 'xcode' || buildTool === 'android' ? buildTool : null
  bubble.classList.remove('streaming')
  hudMessage.classList.remove('streaming')
  const clickable = !!bubbleMentionId || !!bubbleWorkItemId || !!bubbleActivityId || bubbleCalendarEvent || bubbleCalendarPrivacy || !!bubbleExternalUrl || !!bubbleBuildTool
  bubble.classList.toggle('clickable', clickable)
  hudMessage.classList.toggle('clickable', clickable)
  showBubble(text, 30000)
})

// 채팅/액션 답변을 말풍선으로 스트리밍 (progress 누적, result 교체)
window.watchpup.onChatBubble((ev) => {
  if (!ev || typeof ev !== 'object') return
  const type = ev.type
  if (type === 'start') {
    clearChatStartTimer()
    chatStreaming = true
    chatBuf = ''
    bubble.classList.add('streaming')
    hudMessage.classList.add('streaming')
    showBubble('답변을 준비하고 있어요…', null)
    chatStartTimer = setTimeout(() => {
      chatStartTimer = null
      if (!chatStreaming || chatBuf) return
      finishChatStreaming()
      hideBubbleSurface()
    }, CHAT_START_TIMEOUT_MS)
    return
  }
  if (type === 'progress' || type === 'assistant_text') {
    clearChatStartTimer()
    chatStreaming = true
    chatBuf += ev.text || ''
    showBubble(chatBuf || '답변을 준비하고 있어요…', null)
  } else if (type === 'result') {
    finishChatStreaming()
    showBubble(ev.text || chatBuf || '(빈 응답)', 20000)
  } else if (type === 'error') {
    finishChatStreaming()
    showBubble('오류: ' + (ev.message || '알 수 없음'), 9000)
  }
})

bubble.addEventListener('mouseenter', () => window.watchpup.setMouseIgnore(false))
bubble.addEventListener('mouseleave', () => window.watchpup.setMouseIgnore(true))
activityHud.addEventListener('mouseenter', () => window.watchpup.setMouseIgnore(false))
activityHud.addEventListener('mouseleave', () => window.watchpup.setMouseIgnore(true))
activityHud.addEventListener('click', (event) => {
  if (event.target === activityHud || event.target === activityList) window.watchpup.openActivityDetail()
})
// 말풍선 클릭 → 스레드가 연결돼 있으면 그 스레드를 열고, 아니면 패널을 연다.
function openBubbleTarget() {
  const target = bubbleOpenTarget(bubbleMentionId, bubbleWorkItemId, bubbleActivityId, bubbleCalendarEvent, bubbleCalendarPrivacy, bubbleExternalUrl, bubbleBuildTool)
  if (target.kind === 'mention') window.watchpup.openMention(target.id)
  else if (target.kind === 'work') window.watchpup.openWorkItem(target.id)
  else if (target.kind === 'activity') window.watchpup.openActivityDetail(target.id)
  else if (target.kind === 'calendar-privacy') window.watchpup.openCalendarPrivacy()
  else if (target.kind === 'calendar') window.watchpup.openCalendar()
  else if (target.kind === 'build-tool') window.watchpup.openBuildTool(target.tool)
  else if (target.kind === 'external') window.watchpup.openExternal(target.url)
  else window.watchpup.showPanel()
  hideBubbleSurface()
}
bubble.addEventListener('click', openBubbleTarget)
hudMessage.addEventListener('click', openBubbleTarget)
hudFold.addEventListener('click', () => setHudFolded(!hudFolded))

// ---- click-through 토글 (몸통 위에서만 상호작용) ----
pet.addEventListener('mouseenter', () => {
  window.watchpup.setMouseIgnore(false)
})
pet.addEventListener('mouseleave', () => {
  window.watchpup.setMouseIgnore(true)
})

// ---- 드래그 이동 vs 클릭 구분 ----
let down = false
let moved = false
let startX = 0
let startY = 0
const DRAG_THRESHOLD = 3

pet.addEventListener('mousedown', (e) => {
  down = true
  moved = false
  startX = e.screenX
  startY = e.screenY
  pet.classList.add('dragging')
  window.watchpup.petDragStart()
})
window.addEventListener('mousemove', (e) => {
  if (!down) return
  if (Math.abs(e.screenX - startX) > DRAG_THRESHOLD || Math.abs(e.screenY - startY) > DRAG_THRESHOLD) moved = true
})
window.addEventListener('mouseup', () => {
  if (!down) return
  down = false
  pet.classList.remove('dragging')
  window.watchpup.petDragEnd()
})
pet.addEventListener('dblclick', () => {
  if (moved) return
  window.watchpup.showPanel()
  badge.classList.add('hidden')
})

// 초기 크기 동기화
syncSize()
