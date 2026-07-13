import { app, ipcMain, Tray, nativeImage, clipboard, screen, shell, dialog, BrowserWindow } from 'electron'
import { join, basename } from 'node:path'
import { existsSync, readdirSync, readFileSync, statSync, cpSync } from 'node:fs'
import { homedir } from 'node:os'
import { keychain, SecretKeys } from '../src/core/secrets/keychain.js'
import { ConfigStore } from '../src/core/config/store.js'
import { SessionStore } from '../src/core/session/store.js'
import { KeyedMutex } from '../src/core/session/locks.js'
import { Semaphore } from '../src/core/session/semaphore.js'
import { StateStore } from '../src/core/state/store.js'
import { AuditStore } from '../src/core/observability/audit.js'
import { MentionStore } from '../src/core/state/mentions.js'
import { LessonStore } from '../src/core/state/lessons.js'
import { bubbleReady as bubbleReadyText, bubbleFollowup as bubbleFollowupText, bubbleAnalyzing as bubbleAnalyzingText, type BubbleStyle } from '../src/core/presentation/bubble.js'
import { pickIdleLine } from '../src/core/presentation/idle.js'
import { WatchpupGateway } from '../src/core/slack/gateway.js'
import { generateQuips } from '../src/core/watchpup/quips.js'
import { parseSkillMd } from '../src/core/watchpup/skill-import.js'
import type { Mention, PetState, AgentStreamEvent } from '../src/core/types.js'
import { CMD, EVT } from './ipc.js'
import type { ChatSendArgs, TodoToggleArgs, SettingsPatch, TokensPatch, TokensStatus, Playbook, ActionRunArgs } from './ipc.js'
import { createPetWindow, createPanelWindow } from './windows.js'
import { petImagesFromDir, listCodexPets as listCodexPetsAt, resolveCodexPet } from './pets.js'
import { readGlobalMcpCandidates } from './mcp-import.js'
import { addGithubRepo } from './repos-github.js'
import { integrationStatus, connectNotion, connectJira, disconnectIntegration } from './integrations.js'
import { localRelaunchArgs } from '../src/core/watchpup/relaunch.js'

let pet: BrowserWindow | null = null
let panel: BrowserWindow | null = null
let gateway: WatchpupGateway | null = null
let unread = 0
let lastActivity = Date.now()

function send(win: BrowserWindow | null, channel: string, payload: unknown): void {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
}

// 멘션/채팅/액션 이벤트는 (단일 마스터-디테일) 패널로 보낸다.
function broadcast(channel: string, payload: unknown): void {
  send(panel, channel, payload)
}

const listCodexPets = (): Array<{ id: string; displayName: string; dir: string }> => listCodexPetsAt(app.getPath('userData'))

// 펫 말풍선 텍스트는 표현 레이어(src/core/presentation/bubble)로 분리. 여기선 현재 표시 방식만 보관.
let bubbleStyle: BubbleStyle = 'status'
const bubbleReady = (m: Mention): string => bubbleReadyText(m, bubbleStyle)
const bubbleFollowup = (m: Mention): string => bubbleFollowupText(m, bubbleStyle)
const bubbleAnalyzing = (m: Mention): string => bubbleAnalyzingText(m, bubbleStyle)

// idle 상태여도 읽지 않은 멘션이 있으면 ready로 유지 — core가 finally에서 항상
// pet('idle')을 보내므로, 여기서 unread 여부로 실제 표시 상태를 결정한다.
function sendPetState(s: PetState): void {
  send(pet, EVT.pet, (s === 'idle' && unread > 0) ? 'ready' : s)
}

async function main(): Promise<void> {
  // 1) deps 구성 (src/core/cli/run.ts와 동일 방식)
  const configStore = new ConfigStore()
  const config = configStore.get()
  bubbleStyle = config.bubbleStyle
  const mentions = new MentionStore(join(config.dataDir, 'mentions'))
  const sessions = new SessionStore(join(config.dataDir, 'sessions.json'), config.sessionCacheMax, config.sessionIdleMs)
  const state = new StateStore(join(config.dataDir, 'watchpup-state.json'))
  const audit = new AuditStore(join(config.dataDir, 'audit.jsonl'))
  const lessons = new LessonStore(join(config.dataDir, 'lessons.json'))
  const deps = {
    config,
    sessions,
    keychain,
    mutex: new KeyedMutex(),
    semaphore: new Semaphore(config.maxConcurrency),
    state,
    audit,
    mentions,
    lessons,
  }

  // 창 크기·위치 기억: resize/move 시 디바운스 저장, 생성 시 복원
  const boundsTimers = new Map<string, NodeJS.Timeout>()
  function rememberBounds(win: import('electron').BrowserWindow, key: string): void {
    const save = (): void => {
      const prev = boundsTimers.get(key)
      if (prev) clearTimeout(prev)
      boundsTimers.set(
        key,
        setTimeout(() => {
          if (win.isDestroyed() || win.isMinimized()) return
          const b = win.getBounds()
          state.setWindowBounds(key, { x: b.x, y: b.y, width: b.width, height: b.height })
        }, 400),
      )
    }
    win.on('resize', save)
    win.on('move', save)
  }

  // 2) 창 + 트레이 생성
  pet = createPetWindow(config.petAlwaysOnTop)
  panel = createPanelWindow(state.getWindowBounds('panel'))


  rememberBounds(panel, 'panel')

  // 펫 창 위치 복원 (드래그로 옮긴 마지막 위치)
  const savedPos = state.get().windowPos
  if (savedPos) pet.setPosition(savedPos.x, savedPos.y)

  // 펫 드래그 이동: 렌더러 mousedown→dragStart, mouseup→dragEnd.
  // 커서를 폴링해 창을 따라 옮긴다(grab 지점을 커서 아래에 고정). CSS -webkit-app-region
  // 대신 JS로 처리해 클릭(패널 토글)과 드래그를 렌더러에서 구분할 수 있게 한다.
  let dragOffset: { x: number; y: number } | null = null
  let dragTimer: ReturnType<typeof setInterval> | null = null
  ipcMain.on('pet.dragStart', () => {
    if (!pet) return
    const cursor = screen.getCursorScreenPoint()
    const [wx, wy] = pet.getPosition()
    dragOffset = { x: cursor.x - wx, y: cursor.y - wy }
    if (dragTimer) clearInterval(dragTimer)
    dragTimer = setInterval(() => {
      if (!pet || !dragOffset) return
      const c = screen.getCursorScreenPoint()
      pet.setPosition(c.x - dragOffset.x, c.y - dragOffset.y)
    }, 16)
  })
  ipcMain.on('pet.dragEnd', () => {
    if (dragTimer) {
      clearInterval(dragTimer)
      dragTimer = null
    }
    dragOffset = null
    if (pet) {
      const [x, y] = pet.getPosition()
      state.setWindowPos({ x, y })
    }
  })

  // 트레이/펫 클릭 시 blur가 먼저 발생해 패널을 숨기고, 뒤이어 togglePanel이 실행되면
  // 마스터-디테일 패널은 옆에 두고 참조하는 창 → 포커스 잃어도 자동으로 닫지 않는다.
  // 닫기는 ESC / X 버튼 / 펫(트레이) 토글로만.

  const tray = new Tray(nativeImage.createEmpty())
  tray.setTitle('🐾')

  function togglePanel(): void {
    if (!panel) return
    if (panel.isVisible()) {
      panel.hide()
    } else {
      panel.show()
      panel.focus()
      send(panel, 'panel.shown', {}) // 열 때 항상 멘션 목록부터(직전 설정 탭 잔상 방지)
      unread = 0
      state.setBadge(0)
      send(pet, EVT.pet, 'idle')
      send(pet, EVT.badge, 0)
      if (process.platform === 'darwin') app.dock?.setBadge('')
    }
  }
  tray.on('click', () => togglePanel())

  // 펫 창 전용 IPC (window.watchpup.togglePanel / setMouseIgnore)
  ipcMain.on('pet.togglePanel', () => togglePanel())
  // 말풍선 클릭 → 패널 열고 해당 스레드 선택
  ipcMain.on('pet.openMention', (_e, id: string) => {
    if (!panel || typeof id !== 'string' || !id) return
    if (!panel.isVisible()) {
      panel.show()
      unread = 0
      state.setBadge(0)
      send(pet, EVT.badge, 0)
      if (process.platform === 'darwin') app.dock?.setBadge('')
    }
    panel.focus()
    send(panel, 'mention.focus', id)
  })
  ipcMain.on('pet.setMouseIgnore', (_e, ignore: boolean) => {
    if (pet) pet.setIgnoreMouseEvents(!!ignore, { forward: true })
  })
  // permalink 등 외부 링크는 기본 브라우저로 (창 네비게이션 방지)
  ipcMain.on('open.external', (_e, url: string) => {
    if (typeof url === 'string' && /^https?:\/\//.test(url)) void shell.openExternal(url)
  })

  // 맥 스타일 창 컨트롤 (프레임리스 → 커스텀 신호등)
  ipcMain.on('panel.hide', () => { panel?.hide() })
  ipcMain.on('panel.minimize', () => { panel?.minimize() })
  ipcMain.on('panel.maximize', () => {
    if (!panel) return
    if (panel.isMaximized()) panel.unmaximize()
    else panel.maximize()
  })

  // 스레드 추적 on/off · 목록에서 제거
  ipcMain.handle('mention.setTracked', (_e, a: { mentionId: string; tracked: boolean }) => {
    gateway?.setTracked(a.mentionId, a.tracked)
  })
  ipcMain.handle('mention.remove', (_e, id: string) => {
    gateway?.removeMention(id)
  })
  ipcMain.handle('mention.cleanupFalse', () => (gateway ? gateway.cleanupFalseMentions() : Promise.resolve({ removed: 0, checked: 0 })))
  ipcMain.handle('mention.setCategory', (_e, a: { mentionId: string; category: string }) => {
    gateway?.setCategory(a.mentionId, a.category)
  })

  // 설정 저장 후 재시작 반영
  ipcMain.on('app.restart', () => {
    const args = app.isPackaged ? undefined : localRelaunchArgs(process.argv, process.cwd())
    if (args) app.relaunch({ args })
    else app.relaunch()
    app.exit(0)
  })

  // 커스텀 펫 이미지: 폴더 선택 / 현재 맵 조회
  // 다운로드/외부 폴더를 앱 관리 폴더(userData/<sub>/<name>)로 복사 → 원본 삭제 가능, 앱 자체 완결
  function importIntoApp(srcDir: string, sub: string, name: string): string {
    const dest = join(app.getPath('userData'), sub, name)
    if (dest !== srcDir) cpSync(srcDir, dest, { recursive: true })
    return dest
  }

  ipcMain.handle('pet.images.get', () => petImagesFromDir(configStore.get().petImageDir))
  ipcMain.handle('obsidian.pickVault', async () => {
    const r = await dialog.showOpenDialog({ properties: ['openDirectory'] })
    return r.canceled ? null : r.filePaths[0]
  })
  // Claude Skill(SKILL.md) 골라 → 워크플로우 필드로 파싱해 반환
  ipcMain.handle('skill.pick', async () => {
    const r = await dialog.showOpenDialog({ properties: ['openFile'], filters: [{ name: 'Skill', extensions: ['md'] }] })
    if (r.canceled || !r.filePaths[0]) return null
    try {
      return parseSkillMd(readFileSync(r.filePaths[0], 'utf8'))
    } catch {
      return null
    }
  })
  ipcMain.handle('pet.pickImageDir', async () => {
    const r = await dialog.showOpenDialog({ properties: ['openDirectory'] })
    const src = r.canceled ? null : r.filePaths[0]
    if (!src) return null
    try {
      return importIntoApp(src, 'petimg', basename(src) || 'set') // 앱 폴더로 복사해 사용
    } catch (e) {
      console.error('이미지 폴더 복사 실패', e)
      return src
    }
  })
  // Codex Pet 팩: ~/.codex/pets 목록 / 폴더 선택 / 사용(앱 폴더 복사) / 현재 선택 조회
  ipcMain.handle('codex.list', () => listCodexPets())
  ipcMain.handle('codex.pickDir', async () => {
    const r = await dialog.showOpenDialog({ properties: ['openDirectory'] })
    return r.canceled || !r.filePaths[0] ? null : r.filePaths[0]
  })
  // 선택한 codex 펫(다운로드/설치 폴더)을 앱 폴더로 복사 → 복사본 경로 반환(원본 삭제 가능)
  ipcMain.handle('codex.use', (_e, srcDir: string) => {
    if (!srcDir || typeof srcDir !== 'string') return null
    if (!existsSync(join(srcDir, 'pet.json'))) return null
    try {
      const raw = JSON.parse(readFileSync(join(srcDir, 'pet.json'), 'utf8'))
      const id = typeof raw?.id === 'string' && raw.id ? raw.id : basename(srcDir)
      return importIntoApp(srcDir, 'pets', id)
    } catch (e) {
      console.error('codex pet 복사 실패', e)
      return null
    }
  })
  ipcMain.handle('pet.codex.get', () => resolveCodexPet(configStore.get().petCodexDir))
  // 스레드 대화 즉석 조회(예전 멘션은 thread가 없을 수 있음)
  ipcMain.handle('thread.get', (_e, id: string) => (gateway ? gateway.getThread(id) : Promise.resolve([])))

  // 코드 레포: 목록·추가(폴더 선택)·삭제 — 코드 원인 조사에 사용(claude --add-dir)
  ipcMain.handle('repos.list', () => configStore.get().repos)
  ipcMain.handle('repos.add', async () => {
    const r = await dialog.showOpenDialog({ properties: ['openDirectory'] })
    if (r.canceled || !r.filePaths[0]) return configStore.get().repos
    const path = r.filePaths[0]
    const cur = configStore.get().repos
    const next = cur.includes(path) ? cur : [...cur, path]
    const c = configStore.update({ repos: next })
    deps.config = c
    return c.repos
  })
  ipcMain.handle('repos.addGithub', async (_e, spec: string) => {
    try {
      const { path, action } = await addGithubRepo(spec, join(app.getPath('userData'), 'repos'))
      const cur = configStore.get().repos
      const next = cur.includes(path) ? cur : [...cur, path]
      const c = configStore.update({ repos: next })
      deps.config = c
      return { repos: c.repos, action }
    } catch (e) {
      return { error: String((e as Error)?.message || e) }
    }
  })
  ipcMain.handle('repos.remove', (_e, path: string) => {
    const c = configStore.update({ repos: configStore.get().repos.filter((p) => p !== path) })
    deps.config = c
    return c.repos
  })

  // 내 유저그룹: 검색(등록)·목록·삭제 — 등록된 그룹의 멘션도 감지
  ipcMain.handle('groups.list', () => configStore.get().myGroups)
  ipcMain.handle('groups.research', async () => {
    const cfg = configStore.get()
    if (!gateway) return { error: '먼저 슬랙 연결이 필요합니다 (재시작 후).' }
    if (!cfg.mySlackUserId) return { error: 'mySlackUserId 를 먼저 저장하세요.' }
    try {
      const found = await gateway.researchGroups(cfg.mySlackUserId)
      const myGroups = found.map((g) => ({ id: g.id, handle: g.handle }))
      const c = configStore.update({ myGroups })
      deps.config = c
      gateway.reapplyGroups()
      return { groups: myGroups }
    } catch (e) {
      const err = e as { data?: { error?: string } }
      const code = err?.data?.error || String(e)
      return { error: code === 'missing_scope' ? 'usergroups:read 스코프가 필요합니다 (앱 재설치).' : code }
    }
  })
  ipcMain.handle('groups.remove', (_e, id: string) => {
    const c = configStore.update({ myGroups: configStore.get().myGroups.filter((g) => g.id !== id) })
    deps.config = c
    gateway?.reapplyGroups()
    return c.myGroups
  })
  // 말풍선 크기에 맞춰 펫 창 높이를 동적으로 (하단 고정 → 위로 확장)
  ipcMain.on('pet.resize', (_e, height: number) => {
    if (!pet || pet.isDestroyed() || typeof height !== 'number') return
    const b = pet.getBounds()
    const h = Math.max(164, Math.min(680, Math.round(height)))
    if (h === b.height) return
    const bottom = b.y + b.height
    pet.setBounds({ x: b.x, y: bottom - h, width: b.width, height: h })
  })

  // 3) 엔진 생성(토큰 불필요) + 이벤트 브리지. 소스(봇/검색)는 아래에서 config·토큰에 따라 부착.
  gateway = new WatchpupGateway(deps)
  gateway.on('pet', (s: PetState) => {
    if (s !== 'idle') lastActivity = Date.now()
    sendPetState(s)
  })
  gateway.on('mention:new', (m: Mention) => {
    lastActivity = Date.now()
    broadcast(EVT.mentionNew, m)
    // 즉시 "분석 중" 상태를 말풍선으로 (준비되면 아래에서 교체). 클릭하면 해당 스레드로.
    send(pet, EVT.bubble, { text: bubbleAnalyzing(m), mentionId: m.id })
  })
  gateway.on('mention:ready', (m: Mention) => {
    lastActivity = Date.now()
    broadcast(EVT.mentionReady, m)
    // 펫 말풍선: 내가 해야 할 행동 유도. 클릭하면 해당 스레드가 열림.
    send(pet, EVT.bubble, { text: m.direct === false ? bubbleFollowup(m) : bubbleReady(m), mentionId: m.id })
  })
  gateway.on('chat:stream', (p: { mentionId: string; event: AgentStreamEvent; source?: string }) => {
    lastActivity = Date.now()
    broadcast(EVT.chatStream, p)
    // 내가 건 채팅 답변만 말풍선으로 흘려보낸다. 분석 스트리밍은 말풍선에 노출하지 않음(상태만 표시).
    if (p.source !== 'analysis') send(pet, EVT.chatBubble, p.event)
  })
  gateway.on('action:stream', (p: { mentionId: string; playbookId: string; event: AgentStreamEvent }) => {
    broadcast(EVT.actionStream, p)
    // 액션 진행도 펫 말풍선으로도 흘려보낸다.
    send(pet, EVT.chatBubble, p.event)
  })
  gateway.on('action:done', (p: { mentionId: string; playbookId: string; text: string; error?: boolean }) => {
    broadcast(EVT.actionDone, p)
  })
  gateway.on('lessons:changed', () => {
    broadcast('lessons.changed', {})
  })
  gateway.on('rating:changed', (p: { mentionId: string; score: number }) => {
    broadcast('rating.changed', p)
  })
  gateway.on('mentions:refresh', () => {
    broadcast('mentions.refresh', null)
  })
  gateway.on('badge', (n: number) => {
    unread = n
    send(pet, EVT.badge, n)
    if (process.platform === 'darwin') app.dock?.setBadge(n > 0 ? String(n) : '')
  })

  // 심심할 때(오래 조용하면) 펫이 혼잣말 — 재미 + 안 읽은 멘션 리마인드. 라인 선택은 presentation/idle.
  // LLM이 상황(안읽음·시간대)에 맞춰 위트 한 줄들을 배치 생성해 캐시 → idle 때 꺼내 씀(비용 최소).
  const quipCache: string[] = []
  let quipBusy = false
  function refillQuips(): void {
    if (quipBusy || quipCache.length >= 3) return
    quipBusy = true
    generateQuips({ config: deps.config, keychain }, { unread: mentions.unreadCount(), hour: new Date().getHours() })
      .then((lines) => { if (lines.length) quipCache.push(...lines) })
      .catch(() => {})
      .finally(() => { quipBusy = false })
  }
  const idleLine = (): string => pickIdleLine(mentions.unreadCount(), quipCache)
  const IDLE_MS = 8 * 60 * 1000
  refillQuips() // 시작 시 한 배치 미리 생성
  setInterval(() => {
    if (!pet || pet.isDestroyed()) return
    if (panel?.isVisible()) return
    if (Date.now() - lastActivity < IDLE_MS) return
    refillQuips() // 캐시 보충(비동기)
    send(pet, EVT.bubble, idleLine())
    lastActivity = Date.now() // 다음 혼잣말까지 간격 확보
  }, 4 * 60 * 1000)

  // 4) 감지원 부착: 봇(소켓) / 내 계정 검색 폴링 — config 플래그 + 토큰 존재 시
  const botToken = await keychain.get(SecretKeys.slackBotToken)
  const appToken = await keychain.get(SecretKeys.slackAppToken)
  const userToken = await keychain.get(SecretKeys.slackUserToken)
  if (config.enableBot && botToken && appToken) {
    try {
      gateway.attachSocket(botToken, appToken)
    } catch (e) {
      console.error('소켓 소스 부착 실패', e)
    }
  }
  if (config.enableUserSearch && userToken && config.mySlackUserId) {
    gateway.attachUserSearch(userToken, config.mySlackUserId, config.searchIntervalSec)
  }

  // 5) 명령 핸들러 (gateway 생성 이후 등록; gateway가 null이면 안전하게 무동작/기본값 반환)
  ipcMain.handle(CMD.mentionsList, () => mentions.all())
  ipcMain.handle(CMD.mentionGet, (_e, id: string) => mentions.get(id) ?? null)
  ipcMain.handle(CMD.mentionRead, (_e, id: string) => {
    mentions.markRead(id)
  })
  ipcMain.handle(CMD.todoToggle, (_e, a: TodoToggleArgs) => {
    gateway?.toggleTodo(a.mentionId, a.index)
  })
  ipcMain.handle(CMD.replyApprove, (_e, id: string) => (gateway ? gateway.approveReply(id) : Promise.resolve({ ts: null })))
  ipcMain.handle('dev.run', (_e, a: { mentionId: string; repoPaths: string[]; extraContext: string }) => {
    if (!gateway) return Promise.resolve()
    send(pet, EVT.chatBubble, { type: 'start' })
    return gateway.runDev(a.mentionId, a.repoPaths || [], a.extraContext || '')
  })
  ipcMain.handle('reply.rewrite', (_e, a: { mentionId: string; style: string }) =>
    gateway ? gateway.rewriteDraft(a.mentionId, a.style as never) : Promise.resolve({ text: '' }),
  )
  // 자가발전: 사용자 피드백 반영(→ 교훈 축적 + 즉시 재분석) / 교훈 목록·삭제
  ipcMain.handle('feedback.send', (_e, a: { mentionId: string; text: string }) =>
    gateway ? gateway.feedback(a.mentionId, a.text || '') : Promise.resolve({ lesson: null }),
  )
  ipcMain.handle('mention.reanalyze', (_e, id: string) => (gateway ? gateway.reanalyze(id) : Promise.resolve()))
  ipcMain.handle('mention.rate', (_e, a: { mentionId: string; score: number }) =>
    gateway ? gateway.rate(a.mentionId, a.score) : Promise.resolve(),
  )
  ipcMain.handle('lessons.list', () => (gateway ? gateway.listLessons() : {}))
  ipcMain.handle('lessons.clear', (_e, a: { key?: string; index?: number }) => {
    gateway?.clearLessons(a?.key, a?.index)
  })
  ipcMain.handle('lessons.add', (_e, a: { key: string; text: string }) => {
    if (a?.key && a?.text) gateway?.addLesson(a.key, a.text)
  })
  ipcMain.handle('lessons.edit', (_e, a: { key: string; index: number; text: string }) => {
    if (a?.key && typeof a.index === 'number' && a?.text) gateway?.editLesson(a.key, a.index, a.text)
  })
  ipcMain.handle(CMD.replyCopy, (_e, id: string) => {
    const m = mentions.get(id)
    if (m?.analysis?.draftReply) clipboard.writeText(m.analysis.draftReply)
  })
  ipcMain.handle(CMD.chatSend, (_e, a: ChatSendArgs) => {
    if (!gateway) return Promise.resolve({ text: '' })
    // 펫 말풍선에 새 답변 시작을 알려 이전 내용을 비운다.
    send(pet, EVT.chatBubble, { type: 'start' })
    return gateway.chat(a.mentionId, a.text)
  })
  ipcMain.handle(CMD.settingsGet, () => configStore.get())
  ipcMain.handle(CMD.settingsSet, (_e, patch: SettingsPatch) => {
    const current = configStore.get()
    const merged = {
      ...patch,
      obsidian: { ...current.obsidian, ...(patch.obsidian ?? {}) },
    }
    const c = configStore.update(merged)
    deps.config = c
    bubbleStyle = c.bubbleStyle // 말풍선 표시 방식 즉시 반영 (persona는 다음 분석부터 config로 자동 반영)
    // 펫 테마·크기·커스텀 이미지·Codex Pet 팩은 재시작 없이 즉시 반영
    send(pet, EVT.petTheme, c.petTheme)
    send(pet, EVT.petSize, c.petSizePercent)
    send(pet, EVT.petImages, petImagesFromDir(c.petImageDir))
    send(pet, EVT.petCodex, resolveCodexPet(c.petCodexDir))
    if (pet && !pet.isDestroyed()) pet.setAlwaysOnTop(c.petAlwaysOnTop) // 즉시 반영
  })
  // 토큰: 존재 여부만 조회 / 값 저장은 Keychain에만 (설정 변경은 재시작 후 반영)
  ipcMain.handle(CMD.tokensGet, async (): Promise<TokensStatus> => ({
    bot: await keychain.has(SecretKeys.slackBotToken),
    app: await keychain.has(SecretKeys.slackAppToken),
    user: await keychain.has(SecretKeys.slackUserToken),
  }))
  ipcMain.handle(CMD.tokensSet, async (_e, patch: TokensPatch) => {
    if (patch.botToken) await keychain.set(SecretKeys.slackBotToken, patch.botToken.trim())
    if (patch.appToken) await keychain.set(SecretKeys.slackAppToken, patch.appToken.trim())
    if (patch.userToken) await keychain.set(SecretKeys.slackUserToken, patch.userToken.trim())
  })
  ipcMain.handle(CMD.actionRun, (_e, a: ActionRunArgs) => {
    if (!gateway) return Promise.resolve({ text: '' })
    // 펫 말풍선에 새 실행 시작을 알려 이전 내용을 비운다.
    send(pet, EVT.chatBubble, { type: 'start' })
    return gateway.runAction(a.mentionId, a.playbookId, a.extra || '')
  })
  ipcMain.handle(CMD.playbooksList, () => configStore.get().playbooks)
  ipcMain.handle(CMD.playbookUpsert, (_e, pb: Playbook) => {
    const c = configStore.upsertPlaybook(pb)
    deps.config = c
  })
  ipcMain.handle(CMD.playbookDelete, (_e, id: string) => {
    const c = configStore.removePlaybook(id)
    deps.config = c
  })
  // MCP 서버 CRUD — 다음 분석/워크플로우부터 즉시 반영(prepare가 config에서 --mcp-config 생성)
  ipcMain.handle('mcp.list', () => configStore.get().mcpServers)
  ipcMain.handle('mcp.upsert', (_e, s: unknown) => {
    const c = configStore.upsertMcpServer(s as never)
    deps.config = c
    return c.mcpServers
  })
  ipcMain.handle('mcp.remove', (_e, id: string) => {
    const c = configStore.removeMcpServer(id)
    deps.config = c
    return c.mcpServers
  })
  // 글로벌 Claude(~/.claude.json) MCP 후보 — 이미 등록된 것은 already 플래그
  ipcMain.handle('mcp.importCandidates', () => {
    const existing = new Set(configStore.get().mcpServers.map((s) => s.id))
    return readGlobalMcpCandidates().map((c) => ({ ...c, already: existing.has(c.id) }))
  })
  // 간편 연동 (노션·지라) — 토큰 Keychain 저장 + MCP 서버 자동 구성
  ipcMain.handle('integration.status', () => integrationStatus(configStore))
  ipcMain.handle('integration.connectNotion', async (_e, token: string) => {
    deps.config = await connectNotion(configStore, keychain, token || '')
  })
  ipcMain.handle('integration.connectJira', async (_e, a: { site: string; email: string; token: string }) => {
    deps.config = await connectJira(configStore, keychain, { site: a.site || '', email: a.email || '', token: a.token || '' })
  })
  ipcMain.handle('integration.disconnect', (_e, id: 'notion' | 'jira') => {
    deps.config = disconnectIntegration(configStore, id)
  })

  // 6) 감지원이 하나라도 붙었고 mySlackUserId가 있으면 기동
  if (gateway.hasSource() && config.mySlackUserId) {
    try {
      await gateway.start()
      // 예전 멘션의 채널 라벨(raw ID → DM/#채널) 일괄 갱신 후 열린 목록 새로고침
      void gateway.refreshMentionLabels().then((n) => {
        if (n) broadcast('mentions.refresh', null)
      })
    } catch (e) {
      console.error('gateway start 실패', e)
    }
  } else {
    const missing: string[] = []
    if (!gateway.hasSource()) missing.push('슬랙 연결(봇 토큰 또는 User Token+검색 활성화)')
    if (!config.mySlackUserId) missing.push('mySlackUserId')
    console.warn(`미설정 — Slack 감시 대기 중: ${missing.join(', ')}. 설정 탭에서 저장 후 앱 재시작.`)
  }
}

app.whenReady().then(main)
app.on('window-all-closed', () => {
  /* 트레이 상주: macOS에서 유지 */
})
app.on('before-quit', () => {
  gateway?.stop().catch(() => {})
})

// 자동업데이트 체크 — 패키징된 빌드에서만, publish 피드 미설정/실패는 무시
if (app.isPackaged) {
  app.whenReady().then(() => {
    import('electron-updater')
      .then(({ autoUpdater }) => autoUpdater.checkForUpdatesAndNotify())
      .catch(() => {})
  })
}
