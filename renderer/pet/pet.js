import { activityStateLabel, formatElapsed } from './activity-format.js'
import { bubbleSurfaceState } from './bubble-surface.js'

const pet = document.getElementById('pet')
const petImg = document.getElementById('pet-img')
const petSprite = document.getElementById('pet-sprite')
const face = pet.querySelector('.face')
const badge = document.getElementById('badge')
const bubble = document.getElementById('bubble')
const activityHud = document.getElementById('activity-hud')
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
let hudSizePercent = 100
let showActivityHud = true
let bubbleActive = false

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
  root.setProperty('--bubble-max-width', `${Math.round(320 * scale)}px`)
  root.setProperty('--bubble-padding-y', `${Math.round(9 * scale)}px`)
  root.setProperty('--bubble-padding-x', `${Math.round(14 * scale)}px`)
  root.setProperty('--bubble-radius', `${Math.round(20 * scale)}px`)
  root.setProperty('--bubble-font-size', `${Math.max(10, Math.round(13 * scale))}px`)
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
  syncSize()
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
// 상단패딩(10) + 스프라이트(128) + 하단패딩(12) + 그림자/발 여유(14) — 코덱스 스프라이트가 잘리지 않도록 여유 확보
const PET_CHROME = 10 + 12 + 14
function syncSize() {
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
    const hudWidth = hudVisible ? Math.ceil(532 * hudSizePercent / 100 + 28) : 0
    window.watchpup.petResize({ width: hudVisible ? Math.max(340, hudWidth) : 340, height: Math.ceil(need) })
  })
}

const ACTIVITY_ICONS = {
  claude: './assets/claude.png',
  codex: './assets/codex.png',
  slack: './assets/slack.png',
}
const ACTIVITY_NAMES = { claude: 'Claude', codex: 'Codex', slack: 'Slack' }
let activities = []

function renderActivities(rows) {
  activities = Array.isArray(rows) ? rows.slice(0, 5) : []
  activityList.replaceChildren()
  for (const activity of activities) {
    if (!activity || !ACTIVITY_ICONS[activity.source]) continue
    const row = document.createElement('button')
    row.type = 'button'
    row.className = `activity-row state-${activity.state || 'waiting'}`
    row.title = `${ACTIVITY_NAMES[activity.source]} · ${activity.title || ''}`
    row.setAttribute('aria-label', `${ACTIVITY_NAMES[activity.source]} 세션 열기: ${activity.title || ''}`)

    const dot = document.createElement('span')
    dot.className = 'activity-dot'
    dot.setAttribute('aria-hidden', 'true')
    const icon = document.createElement('img')
    icon.className = 'activity-icon'
    icon.src = ACTIVITY_ICONS[activity.source]
    icon.alt = ''
    const title = document.createElement('span')
    title.className = 'activity-title'
    title.textContent = activity.title || `${ACTIVITY_NAMES[activity.source]} 세션`
    const state = document.createElement('span')
    state.className = 'activity-state'
    state.textContent = activityStateLabel(activity.state)
    row.append(dot, icon, title, state)
    if (Number.isFinite(activity.contextPercent)) {
      const context = document.createElement('span')
      context.className = 'activity-context'
      context.textContent = `${Math.round(activity.contextPercent)}%`
      row.append(context)
    }
    const elapsed = document.createElement('span')
    elapsed.className = 'activity-elapsed'
    elapsed.textContent = formatElapsed(activity.updatedAt)
    row.append(elapsed)
    row.addEventListener('click', () => window.watchpup.openActivity(activity.id))
    activityList.append(row)
  }
  updateHudVisibility()
}

window.watchpup.activityList().then(renderActivities).catch(() => {})
window.watchpup.onActivitySessions(renderActivities)
setInterval(() => renderActivities(activities), 30_000)

let bubbleTimer = null
let chatStreaming = false
let chatBuf = ''

function renderBubbleSurface() {
  const state = bubbleSurfaceState({ active: bubbleActive, showActivityHud, activityCount: activityList.childElementCount })
  bubble.classList.toggle('hidden', !state.bubbleVisible)
  hudMessage.classList.toggle('hidden', !state.hudMessageVisible)
  updateHudVisibility()
}

function hideBubbleSurface() {
  bubbleActive = false
  renderBubbleSurface()
}

function showBubble(text, hideAfterMs) {
  bubble.textContent = text
  hudMessageText.textContent = text
  hudMessage.title = text
  bubbleActive = true
  renderBubbleSurface()
  if (bubbleTimer) clearTimeout(bubbleTimer)
  if (hideAfterMs) {
    bubbleTimer = setTimeout(hideBubbleSurface, hideAfterMs)
  }
}

let bubbleMentionId = null
window.watchpup.onBubble((payload) => {
  // payload: string(구버전/idle) 또는 { text, mentionId }
  const text = typeof payload === 'string' ? payload : payload && payload.text
  const id = typeof payload === 'object' && payload ? payload.mentionId : null
  if (typeof text !== 'string' || !text) return
  if (chatStreaming) return
  bubbleMentionId = id || null
  bubble.classList.remove('streaming')
  hudMessage.classList.remove('streaming')
  bubble.classList.toggle('clickable', !!bubbleMentionId)
  hudMessage.classList.toggle('clickable', !!bubbleMentionId)
  showBubble(text, 30000)
})

// 채팅/액션 답변을 말풍선으로 스트리밍 (progress 누적, result 교체)
window.watchpup.onChatBubble((ev) => {
  if (!ev || typeof ev !== 'object') return
  const type = ev.type
  if (type === 'start') {
    chatStreaming = true
    chatBuf = ''
    bubble.classList.add('streaming')
    hudMessage.classList.add('streaming')
    showBubble('…', null)
    return
  }
  if (type === 'progress' || type === 'assistant_text') {
    chatStreaming = true
    chatBuf += ev.text || ''
    showBubble(chatBuf || '…', null)
    bubble.scrollTop = bubble.scrollHeight
  } else if (type === 'result') {
    chatStreaming = false
    bubble.classList.remove('streaming')
    hudMessage.classList.remove('streaming')
    showBubble(ev.text || chatBuf || '(빈 응답)', 20000)
    bubble.scrollTop = bubble.scrollHeight
  } else if (type === 'error') {
    chatStreaming = false
    bubble.classList.remove('streaming')
    hudMessage.classList.remove('streaming')
    showBubble('오류: ' + (ev.message || '알 수 없음'), 9000)
  }
})

bubble.addEventListener('mouseenter', () => window.watchpup.setMouseIgnore(false))
bubble.addEventListener('mouseleave', () => window.watchpup.setMouseIgnore(true))
activityHud.addEventListener('mouseenter', () => window.watchpup.setMouseIgnore(false))
activityHud.addEventListener('mouseleave', () => window.watchpup.setMouseIgnore(true))
// 말풍선/HUD 상태 줄 클릭 → 스레드가 연결돼 있으면 그 스레드를 열고, 아니면 패널 토글
function openBubbleTarget() {
  if (bubbleMentionId) window.watchpup.openMention(bubbleMentionId)
  else window.watchpup.togglePanel()
  hideBubbleSurface()
}
bubble.addEventListener('click', openBubbleTarget)
hudMessage.addEventListener('click', openBubbleTarget)

// ---- click-through 토글 (몸통 위에서만 상호작용) ----
pet.addEventListener('mouseenter', () => window.watchpup.setMouseIgnore(false))
pet.addEventListener('mouseleave', () => window.watchpup.setMouseIgnore(true))

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
pet.addEventListener('click', () => {
  if (moved) {
    moved = false
    return
  }
  window.watchpup.togglePanel()
  badge.classList.add('hidden')
})

// 초기 크기 동기화
syncSize()
