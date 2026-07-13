const pet = document.getElementById('pet')
const petImg = document.getElementById('pet-img')
const petSprite = document.getElementById('pet-sprite')
const face = pet.querySelector('.face')
const badge = document.getElementById('badge')
const bubble = document.getElementById('bubble')
const STATES = ['idle', 'thinking', 'ready', 'chatting']

// ---- 테마(글리프) / 커스텀 이미지 / Codex Pet 팩 ----
const THEMES = window.PET_THEMES || {}
let theme = THEMES.paw || { idle: '🐾', thinking: '🐾', ready: '🐾', chatting: '🐾' }
let images = {} // 상태별 file:// 경로 (하나라도 있으면 이미지 모드)
let codex = null // { spritesheet, displayName } | null (설정 시 gif/이모지보다 우선)
let currentState = 'idle'
let petSizePercent = 100

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

window.watchpup.settingsGet().then((cfg) => {
  setTheme(cfg?.petTheme)
  setPetSize(cfg?.petSizePercent)
}).catch(() => {})
window.watchpup.petImages().then(setImages).catch(() => {})
window.watchpup.petCodex().then(setCodex).catch(() => {})
if (window.watchpup.onPetTheme) window.watchpup.onPetTheme((n) => setTheme(typeof n === 'string' ? n : undefined))
if (window.watchpup.onPetImages) window.watchpup.onPetImages(setImages)
if (window.watchpup.onPetCodex) window.watchpup.onPetCodex(setCodex)
if (window.watchpup.onPetSize) window.watchpup.onPetSize(setPetSize)

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
    const need = petArea + (visible ? bubbleH + 19 : 0) + PET_CHROME
    window.watchpup.petResize(Math.ceil(need))
  })
}

let bubbleTimer = null
let chatStreaming = false
let chatBuf = ''

function showBubble(text, hideAfterMs) {
  bubble.textContent = text
  bubble.classList.remove('hidden')
  syncSize()
  if (bubbleTimer) clearTimeout(bubbleTimer)
  if (hideAfterMs) {
    bubbleTimer = setTimeout(() => {
      bubble.classList.add('hidden')
      syncSize()
    }, hideAfterMs)
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
  bubble.classList.toggle('clickable', !!bubbleMentionId)
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
    showBubble(ev.text || chatBuf || '(빈 응답)', 20000)
    bubble.scrollTop = bubble.scrollHeight
  } else if (type === 'error') {
    chatStreaming = false
    bubble.classList.remove('streaming')
    showBubble('오류: ' + (ev.message || '알 수 없음'), 9000)
  }
})

bubble.addEventListener('mouseenter', () => window.watchpup.setMouseIgnore(false))
bubble.addEventListener('mouseleave', () => window.watchpup.setMouseIgnore(true))
// 말풍선 클릭 → 스레드가 연결돼 있으면 그 스레드를 열고, 아니면 패널 토글
bubble.addEventListener('click', () => {
  if (bubbleMentionId) window.watchpup.openMention(bubbleMentionId)
  else window.watchpup.togglePanel()
  bubble.classList.add('hidden')
  syncSize()
})

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
