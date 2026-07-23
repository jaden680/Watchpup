import { app, ipcMain, Tray, nativeImage, clipboard, screen, shell, dialog, BrowserWindow } from 'electron'
import { join, basename } from 'node:path'
import { existsSync, readdirSync, readFileSync, statSync, cpSync } from 'node:fs'
import { homedir } from 'node:os'
import { execFile } from 'node:child_process'
import { keychain, SecretKeys } from '../src/core/secrets/keychain.js'
import { ConfigStore } from '../src/core/config/store.js'
import { SessionStore } from '../src/core/session/store.js'
import { KeyedMutex } from '../src/core/session/locks.js'
import { Semaphore } from '../src/core/session/semaphore.js'
import { StateStore, type NaggingLogEntry, type NaggingLogKind } from '../src/core/state/store.js'
import { AuditStore } from '../src/core/observability/audit.js'
import { MentionStore } from '../src/core/state/mentions.js'
import { ReminderLinkStore, reminderKey } from '../src/core/state/reminder-links.js'
import { parseSlackThreadPermalink } from '../src/core/slack/permalink.js'
import { removeWorkLinkFromNotes, replaceWorkLinkInNotes } from '../src/core/work/links.js'
import { buildMentionReminder, type MentionReminderLink } from '../src/core/work/mention-reminder.js'
import { LessonStore } from '../src/core/state/lessons.js'
import { bubbleReady as bubbleReadyText, bubbleFollowup as bubbleFollowupText, bubbleAnalyzing as bubbleAnalyzingText, type BubbleStyle } from '../src/core/presentation/bubble.js'
import { pickIdleLine } from '../src/core/presentation/idle.js'
import {
  agentNaggingLine,
  agentNaggingPending,
  calendarEventKey,
  calendarNaggingLine,
  naggingLine,
  nextNaggingDelayMs,
  chooseNaggingSource,
  pickCalendarNaggingEvent,
  pickNaggingWorkItem,
  pickSlackNewsNagging,
  slackNewsNaggingLine,
  type SlackNewsNaggingItem,
} from '../src/core/presentation/nagging.js'
import { WatchpupGateway } from '../src/core/slack/gateway.js'
import { generateReminderDraft } from '../src/core/watchpup/pipeline.js'
import type { ReminderDraftText } from '../src/core/agent/analysis.js'
import { generateQuips } from '../src/core/watchpup/quips.js'
import { parseSkillMd } from '../src/core/watchpup/skill-import.js'
import type { Mention, PetState, AgentStreamEvent, ActivitySession } from '../src/core/types.js'
import type { WorkItem } from '../src/core/work/types.js'
import { CMD, EVT } from './ipc.js'
import type { ChatSendArgs, TodoToggleArgs, SettingsPatch, TokensPatch, TokensStatus, Playbook, ActionRunArgs, ReactionSetArgs, MentionToWorkResult } from './ipc.js'
import { createPetWindow, createPanelWindow } from './windows.js'
import { petImagesFromDir, listCodexPets as listCodexPetsAt, resolveCodexPet } from './pets.js'
import { readGlobalMcpCandidates } from './mcp-import.js'
import { addGithubRepo } from './repos-github.js'
import { integrationStatus, connectNotion, connectJira, disconnectIntegration } from './integrations.js'
import { localRelaunchArgs } from '../src/core/watchpup/relaunch.js'
import { LocalAgentPoller, type ActivityHistoryRange } from '../src/core/activity/session-poller.js'
import { mergeActivities, slackActivities } from '../src/core/activity/merge.js'
import { activityTarget } from './activity-link.js'
import { resolveWatchpupConfigPath } from '../src/core/config/path.js'
import { ReminderGateway } from './reminders.js'
import { WorkStatusService } from './work-status.js'
import { focusVisiblePanel, setPanelSwitcherVisibility } from './panel-activation.js'
import { ClaudeModelCatalogService } from '../src/core/agent/model-catalog.js'
import { ensureOpenAtLogin } from './login-item.js'
import { openExternalLink } from './external-link.js'
import { GithubPrNotificationPoller, githubPrNaggingLine } from '../src/core/github/notifications.js'
import { BuildCompletionPoller, buildCompletionLine, type BuildTool } from '../src/core/build/completion-poller.js'
import { WorkAgentStore } from '../src/core/workagent/store.js'
import { WorkAgentPoller } from '../src/core/workagent/poller.js'
import { runWorkProposal, cleanupWorkProposal, chatWorkProposal } from '../src/core/workagent/run.js'
import { PLAN_FILE } from '../src/core/workagent/prompt.js'
import type { WorkProposal, WorkTaskPrefs } from '../src/core/workagent/types.js'
import { openProposalSession, resolveWorkAgentRepo } from './work-agent.js'
import { runWorkProposalInOrca, switchToOrcaTerminal } from './work-agent-orca.js'
import { isGitRepo, scanGitRepos } from './repos-scan.js'
import { startupSlackSecrets } from '../src/core/startup/access.js'
import type { CalendarAuthorizationStatus } from './reminders.js'

let pet: BrowserWindow | null = null
let panel: BrowserWindow | null = null
let gateway: WatchpupGateway | null = null
let agentPoller: LocalAgentPoller | null = null
let githubPrPoller: GithubPrNotificationPoller | null = null
let buildCompletionPoller: BuildCompletionPoller | null = null
let workAgentPoller: WorkAgentPoller | null = null
let unread = 0
let lastActivity = Date.now()
let isQuitting = false

function send(win: BrowserWindow | null, channel: string, payload: unknown): void {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
}

function activePanel(): BrowserWindow | null {
  return panel && !panel.isDestroyed() ? panel : null
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
  const configStore = new ConfigStore(resolveWatchpupConfigPath())
  const config = configStore.get()
  bubbleStyle = config.bubbleStyle
  const mentions = new MentionStore(join(config.dataDir, 'mentions'))
  const reminderLinks = new ReminderLinkStore(join(config.dataDir, 'reminder-links.json'))
  const sessions = new SessionStore(join(config.dataDir, 'sessions.json'), config.sessionCacheMax, config.sessionIdleMs)
  const state = new StateStore(join(config.dataDir, 'watchpup-state.json'))
  const audit = new AuditStore(join(config.dataDir, 'audit.jsonl'))
  const lessons = new LessonStore(join(config.dataDir, 'lessons.json'))
  const reminders = new ReminderGateway()
  const workStatus = new WorkStatusService(configStore, keychain)
  const modelCatalog = new ClaudeModelCatalogService(join(config.dataDir, 'claude-models.json'))
  const openExternalUrl = (url: string): void => {
    void openExternalLink(url, {
      openExternal: (target) => shell.openExternal(target),
      resolveSlackTeamId: async () => {
        await ensureSlackUserToken()
        return gateway?.resolveTeamId() ?? null
      },
    }).catch((error) => logger.warn('외부 링크 열기 실패', { url, error: String(error) }))
  }
  let calendarAccessStatus: CalendarAuthorizationStatus | null = null
  githubPrPoller = new GithubPrNotificationPoller(
    () => {
      const current = configStore.get()
      return { enabled: current.naggingEnabled && current.githubPrNaggingEnabled }
    },
    (item) => state.enqueueNaggingGithubPr(item),
  )
  buildCompletionPoller = new BuildCompletionPoller(
    () => {
      const current = configStore.get()
      return {
        enabled: current.buildAlertsEnabled,
        xcodeEnabled: current.xcodeBuildAlertsEnabled,
        androidEnabled: current.androidBuildAlertsEnabled,
      }
    },
    (event) => {
      const key = `build:${event.id}`
      if (state.seen(key)) return
      state.markSeen(key)
      send(pet, EVT.bubble, { text: buildCompletionLine(event), buildTool: event.tool })
      lastActivity = Date.now()
    },
  )
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

  // Work 자동 제안: Work 상위 작업을 격리 worktree에서 미리 진행하고 제안. 한 번에 하나만 실행.
  const workAgent = new WorkAgentStore(join(config.dataDir, 'work-agent.json'))
  let workAgentBusy = false
  const broadcastWorkAgent = (reminderId: string): void => {
    broadcast(EVT.workAgentChanged, { reminderId, proposal: workAgent.proposal(reminderId) ?? null })
  }
  async function runWorkAgentFor(item: WorkItem, subtasks: WorkItem[], source: 'auto' | 'manual'): Promise<void> {
    if (workAgentBusy) throw new Error('이미 다른 제안 작업이 실행 중이에요.')
    const current = configStore.get()
    const prefs = workAgent.prefs(item.id)
    const provider = prefs.provider || current.workAgentProvider
    const model = (prefs.model?.trim() || (provider === 'codex' ? current.workAgentCodexModel : current.workAgentModel)).trim()
    const repoPath = resolveWorkAgentRepo(item, current, prefs.repo)
    if (!repoPath) throw new Error('작업할 레포가 없어요. 설정 → 저장소에서 코드 레포를 등록해주세요.')
    workAgentBusy = true
    try {
      // 재실행이면 이전 worktree를 먼저 정리
      const previous = workAgent.proposal(item.id)
      if (previous && previous.status !== 'running') await cleanupWorkProposal(previous)
      let live: WorkProposal = {
        reminderId: item.id,
        status: 'running',
        source,
        provider,
        model: model || undefined,
        branch: '',
        worktreePath: '',
        repoPath,
        startedAt: Date.now(),
      }
      workAgent.setProposal(live)
      broadcastWorkAgent(item.id)
      // 실행 중 확보되는 정보(worktree·세션 id·Orca 터미널)를 즉시 저장 — 재시작해도 세션을 찾아갈 수 있게
      const onUpdate = (patch: Partial<WorkProposal>): void => {
        live = { ...live, ...patch }
        workAgent.setProposal(live)
        broadcastWorkAgent(item.id)
      }
      const worktreeRoot = join(current.dataDir, 'work-worktrees')
      // Orca 모드(claude 전용): Orca가 실행 중이면 터미널에서 눈에 보이게 실행, 아니면 headless 폴백
      let result = provider === 'claude' && current.workAgentUseOrca
        ? await runWorkProposalInOrca({ config: deps.config }, { item, subtasks, repoPath, model, worktreeRoot, source, onUpdate })
        : null
      result ??= await runWorkProposal({ config: deps.config, keychain }, {
        item,
        subtasks,
        repoPath,
        provider,
        model,
        worktreeRoot,
        source,
        onUpdate,
      })
      workAgent.setProposal(result)
      broadcastWorkAgent(item.id)
      if (result.status === 'ready') {
        send(pet, EVT.bubble, { text: `“${item.title}” 계획을 미리 세워봤어요. 논의해볼래요? 📝`, workItemId: item.id })
        lastActivity = Date.now()
      }
    } finally {
      workAgentBusy = false
    }
  }
  workAgentPoller = new WorkAgentPoller(
    () => {
      const current = configStore.get()
      return {
        enabled: current.workAgentEnabled,
        listId: current.reminderListId,
        intervalMinutes: current.workAgentIntervalMinutes,
        sortOrder: current.reminderTaskSortOrder,
        manualOrder: current.reminderTaskManualOrder,
      }
    },
    {
      fetchTasks: (listId) => reminders.tasks(listId, false),
      store: workAgent,
      run: (target) => runWorkAgentFor(target.item, target.subtasks, 'auto'),
    },
  )

  // 렌더러가 창 로드 직후 요청하는 초기 설정 핸들러는 창을 만들기 전에 등록한다.
  // 늦게 등록하면 첫 요청이 실패한 뒤 기본 UI 값(100%)이 그대로 남을 수 있다.
  ipcMain.handle(CMD.settingsGet, () => configStore.get())
  ipcMain.handle(CMD.modelCatalogGet, () => modelCatalog.get())
  ipcMain.handle(CMD.modelCatalogRefresh, () => modelCatalog.refresh())
  ipcMain.handle(CMD.naggingLogList, () => state.naggingLog())
  ipcMain.handle(CMD.naggingLogClear, () => {
    state.clearNaggingLog()
    broadcast(EVT.naggingLogChanged, null)
    return { ok: true }
  })
  ipcMain.handle(CMD.workLists, async () => {
    const lists = await reminders.lists()
    const current = configStore.get()
    const selected = current.reminderListSelectionExplicit
      ? lists.find((list) => list.id === current.reminderListId)
      : undefined
    return { lists, selectedId: selected?.id ?? '' }
  })
  ipcMain.handle(CMD.workItems, async (_e, args: { listId?: string; includeCompleted?: boolean } = {}) => {
    const current = configStore.get()
    const listId = args.listId || current.reminderListId
    if (!listId) return []
    return reminders.tasks(listId, args.includeCompleted ?? current.showCompletedReminders)
  })
  ipcMain.handle(CMD.workListSelect, async (_e, listId: string) => {
    const selected = (await reminders.lists()).find((list) => list.id === listId)
    if (!selected) throw new Error('선택한 Reminder 목록을 찾지 못했습니다.')
    deps.config = configStore.update({
      reminderListId: selected.id,
      reminderListName: selected.name,
      reminderAccountName: selected.account,
      reminderListSelectionExplicit: true,
    })
    return selected
  })
  ipcMain.handle(CMD.workReminderCreate, async (_e, args: { listId: string; title: string; notes?: string }) => {
    const list = (await reminders.lists()).find((candidate) => candidate.id === args.listId)
    if (!list) throw new Error('선택한 Reminder 목록을 찾지 못했습니다.')
    const id = await reminders.create(list.id, args.title, args.notes)
    return { id }
  })
  ipcMain.handle(CMD.workReminderSubtaskAdd, async (_e, args: { parentReminderId: string; title: string }) => {
    const id = await reminders.addSubtask(args.parentReminderId, args.title)
    return { id }
  })
  ipcMain.handle(CMD.workReminderTitleUpdate, async (_e, args: { reminderId: string; title: string }) => {
    await reminders.updateTitle(args.reminderId, args.title)
    return { ok: true }
  })
  ipcMain.handle(CMD.workReminderNoteUpdate, async (_e, args: { reminderId: string; note: string }) => {
    await reminders.updateUserNote(args.reminderId, args.note)
    return { ok: true }
  })
  ipcMain.handle(CMD.workReminderComplete, async (_e, args: { reminderId: string; completed: boolean }) => {
    await reminders.setCompleted(args.reminderId, args.completed)
    return { ok: true }
  })
  ipcMain.handle(CMD.workReminderLinkAdd, async (_e, args: { reminderId: string; title: string; url: string }) => {
    await reminders.appendLink(args.reminderId, args.title, args.url)
    return { ok: true }
  })
  // 링크 제거·수정: notes에서 해당 링크만 바꾼다 (<note> 사용자 메모는 보존)
  async function findWorkItemById(reminderId: string): Promise<WorkItem> {
    const listId = configStore.get().reminderListId
    if (!listId) throw new Error('먼저 Work 목록을 선택해주세요.')
    const item = (await reminders.tasks(listId, true)).find((candidate) => candidate.id === reminderId)
    if (!item) throw new Error('작업을 찾지 못했어요.')
    return item
  }
  ipcMain.handle(CMD.workReminderLinkRemove, async (_e, args: { reminderId: string; url: string }) => {
    const item = await findWorkItemById(args.reminderId)
    const next = removeWorkLinkFromNotes(item.notes, args.url)
    if (next === item.notes) throw new Error('메모에서 해당 링크를 찾지 못했어요.')
    await reminders.setNotes(args.reminderId, next)
    return { ok: true }
  })
  ipcMain.handle(CMD.workReminderLinkUpdate, async (_e, args: { reminderId: string; url: string; title: string; newUrl: string }) => {
    const parsed = new URL(args.newUrl)
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('http 또는 https 링크만 사용할 수 있어요.')
    const item = await findWorkItemById(args.reminderId)
    const title = (args.title || '').trim().replace(/[[\]]/g, '') || parsed.hostname
    const next = replaceWorkLinkInNotes(item.notes, args.url, { title, url: parsed.toString() })
    if (next === item.notes) throw new Error('메모에서 해당 링크를 찾지 못했어요.')
    await reminders.setNotes(args.reminderId, next)
    return { ok: true }
  })
  ipcMain.handle(CMD.workItemTouch, (_e, reminderId: string) => {
    if (typeof reminderId === 'string' && reminderId) state.touchWorkItem(reminderId)
    return { ok: true }
  })
  ipcMain.handle(CMD.workLinkStatus, (_e, url: string) => workStatus.status(url))
  ipcMain.handle(CMD.workLinkAction, (_e, args: { url: string; actionId: string }) => workStatus.runAction(args.url, args.actionId))
  ipcMain.handle(CMD.workRemindersOpen, () => shell.openPath('/System/Applications/Reminders.app'))
  // Work 자동 제안: 조회·태스크별 설정·수동 실행·지우기·세션 열기
  ipcMain.handle(CMD.workAgentGet, (_e, reminderId: string) => {
    const current = configStore.get()
    return {
      proposal: workAgent.proposal(reminderId) ?? null,
      prefs: workAgent.prefs(reminderId),
      busy: workAgentBusy,
      defaults: { provider: current.workAgentProvider, model: current.workAgentModel, codexModel: current.workAgentCodexModel },
    }
  })
  ipcMain.handle(CMD.workAgentList, () => workAgent.proposals())
  ipcMain.handle(CMD.workAgentPrefsSet, (_e, args: { reminderId: string; prefs: WorkTaskPrefs }) =>
    workAgent.setPrefs(args.reminderId, args.prefs ?? {}))
  ipcMain.handle(CMD.workAgentRun, async (_e, reminderId: string) => {
    if (workAgentBusy) throw new Error('이미 다른 제안 작업이 실행 중이에요.')
    const current = configStore.get()
    if (!current.reminderListId) throw new Error('먼저 Work 목록을 선택해주세요.')
    const items = await reminders.tasks(current.reminderListId, false)
    const item = items.find((candidate) => candidate.id === reminderId)
    if (!item) throw new Error('작업을 찾지 못했어요.')
    if (!resolveWorkAgentRepo(item, current, workAgent.prefs(reminderId).repo)) throw new Error('작업할 레포가 없어요. 설정 → 저장소에서 코드 레포를 등록해주세요.')
    // 실행은 수 분 걸릴 수 있어 시작만 하고, 결과는 workagent.changed 이벤트로 전달한다.
    void runWorkAgentFor(item, items.filter((candidate) => candidate.parentId === item.id), 'manual')
      .catch((e) => console.error('workagent 수동 실행 실패', e))
    return { ok: true }
  })
  ipcMain.handle(CMD.workAgentDismiss, async (_e, reminderId: string) => {
    const proposal = workAgent.proposal(reminderId)
    if (proposal) {
      if (proposal.status === 'running') throw new Error('실행 중인 제안은 지울 수 없어요. 끝날 때까지 기다려주세요.')
      await cleanupWorkProposal(proposal)
    }
    workAgent.removeProposal(reminderId)
    broadcastWorkAgent(reminderId)
    return { ok: true }
  })
  ipcMain.handle(CMD.workAgentOpen, async (_e, reminderId: string) => {
    const proposal = workAgent.proposal(reminderId)
    if (!proposal) throw new Error('열 수 있는 제안이 없어요.')
    // 실행 중에는 새 세션을 만들면 안 되므로 Orca 터미널 전환만 허용
    if (proposal.status === 'running') {
      if (await switchToOrcaTerminal(proposal)) return { via: 'orca' as const }
      throw new Error('실행 중인 세션은 Orca 모드에서만 바로 열 수 있어요. 끝나면 세션 열기로 이어가주세요.')
    }
    return openProposalSession(proposal)
  })
  // 계획 본문 읽기 — worktree의 WATCHPUP-PLAN.md
  ipcMain.handle(CMD.workAgentPlan, (_e, reminderId: string) => {
    const proposal = workAgent.proposal(reminderId)
    if (!proposal?.worktreePath) return { content: '' }
    try {
      return { content: readFileSync(join(proposal.worktreePath, PLAN_FILE), 'utf8') }
    } catch {
      return { content: '' }
    }
  })
  // 계획 파일을 기본 앱(에디터)으로 열기 — 카드 밖에서 전문을 읽고 싶을 때
  ipcMain.handle(CMD.workAgentPlanOpen, (_e, reminderId: string) => {
    const proposal = workAgent.proposal(reminderId)
    const planPath = proposal?.worktreePath ? join(proposal.worktreePath, PLAN_FILE) : ''
    if (!planPath || !existsSync(planPath)) throw new Error('계획 파일을 찾지 못했어요.')
    return shell.openPath(planPath)
  })
  // 계획 논의(채팅): 제안 세션을 resume해 이어간다. 계획 파일 수정은 카드가 다시 읽는다.
  ipcMain.handle(CMD.workAgentChat, async (_e, args: { reminderId: string; text: string }) => {
    const proposal = workAgent.proposal(args.reminderId)
    if (!proposal || proposal.status !== 'ready') throw new Error('논의할 제안이 없어요.')
    const result = await chatWorkProposal({ config: deps.config, keychain }, {
      proposal,
      text: String(args.text || '').trim(),
      onEvent: (event) => broadcast(EVT.workAgentChatStream, { reminderId: args.reminderId, event }),
    })
    return { text: result.text }
  })
  ipcMain.handle('pet.images.get', () => petImagesFromDir(configStore.get().petImageDir))
  ipcMain.handle('pet.codex.get', () => resolveCodexPet(configStore.get().petCodexDir))

  let localActivities: ActivitySession[] = []
  const currentActivities = (): ActivitySession[] => mergeActivities(localActivities, slackActivities(mentions.all()))
  const broadcastActivities = (): void => {
    const activities = currentActivities()
    send(pet, EVT.activitySessions, activities)
    send(panel, EVT.activitySessions, activities)
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
  setPanelSwitcherVisibility(app, false)
  panel.on('close', (event) => {
    if (isQuitting) return
    event.preventDefault()
    activePanel()?.hide()
  })
  panel.on('hide', () => setPanelSwitcherVisibility(app, false))
  panel.on('focus', () => acknowledgeAgentNagging())
  // Cmd+Tab으로 Watchpup이 다시 활성화될 때 이미 열려 있는 상세 패널을 앞으로 가져온다.
  // 숨겨진 패널은 건드리지 않아 펫 더블클릭으로만 여는 동작을 유지한다.
  app.on('did-become-active', () => focusVisiblePanel(activePanel()))


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

  // 마스터-디테일 패널은 옆에 두고 참조하는 창 → 포커스 잃어도 자동으로 닫지 않는다.
  // 닫기는 ESC / X 버튼 / 트레이 토글로만. 펫 더블클릭은 열기만 한다.

  const tray = new Tray(nativeImage.createEmpty())
  tray.setTitle('🐾')

  function clearPanelBadge(): void {
    unread = 0
    state.setBadge(0)
    send(pet, EVT.pet, 'idle')
    send(pet, EVT.badge, 0)
    if (process.platform === 'darwin') app.dock?.setBadge('')
  }

  function activatePanel(win: BrowserWindow): void {
    setPanelSwitcherVisibility(app, true)
    // 활성 디스플레이(커서가 있는 화면)에 없으면 그 화면 중앙으로 재배치.
    // 이미 활성 화면에 있으면 사용자가 옮겨둔 위치를 존중해 이동하지 않는다.
    const cursor = screen.getCursorScreenPoint()
    const target = screen.getDisplayNearestPoint(cursor)
    const b = win.getBounds()
    if (screen.getDisplayMatching(b).id !== target.id) {
      const wa = target.workArea
      const x = Math.round(wa.x + (wa.width - b.width) / 2)
      const y = Math.round(wa.y + (wa.height - b.height) / 2)
      win.setBounds({ x, y, width: b.width, height: b.height })
    }
    // 패널은 생성 시 setVisibleOnAllWorkspaces(true)로 모든 Space에 소속돼 있어,
    // 어느 Space에서 열어도 현재 Space에 그대로 뜬다(원래 Space로 전환되지 않음).
    if (!win.isVisible()) win.show()
    else win.moveTop()
    // BrowserWindow.focus()만 호출하면 비활성 NSPanel인 펫에서 열었을 때
    // macOS 앱 자체는 비활성 상태로 남을 수 있다.
    if (process.platform === 'darwin') app.focus({ steal: true })
    win.focus()
  }

  function showPanelHome(): void {
    const win = activePanel()
    if (!win) return
    activatePanel(win)
    clearPanelBadge()
  }

  function togglePanel(): void {
    const win = activePanel()
    if (!win) return
    if (win.isVisible()) win.hide()
    else showPanelHome()
  }

  function openActivityPanel(id: string): void {
    const win = activePanel()
    if (!win) return
    acknowledgeAgentNagging()
    activatePanel(win)
    clearPanelBadge()
    send(win, 'activity.focus', id)
  }
  tray.on('click', () => togglePanel())

  // 펫 창 전용 IPC (더블클릭은 패널 열기 전용)
  ipcMain.on('pet.showPanel', () => showPanelHome())
  // 말풍선 클릭 → 패널 열고 해당 스레드 선택
  const openMentionPanel = (id: string): void => {
    const win = activePanel()
    if (!win || typeof id !== 'string' || !id) return
    if (!win.isVisible()) {
      clearPanelBadge()
    }
    activatePanel(win)
    send(win, 'mention.focus', id)
  }
  ipcMain.on('pet.openMention', (_e, id: string) => openMentionPanel(id))
  ipcMain.on('pet.openWorkItem', (_e, id: string) => {
    const win = activePanel()
    if (!win || typeof id !== 'string' || !id) return
    activatePanel(win)
    send(win, 'work.focus', id)
  })
  ipcMain.handle(CMD.activityList, (_e, requestedRange?: ActivityHistoryRange) => {
    const range: ActivityHistoryRange = ['recent', 'today', '7d', 'all'].includes(requestedRange || '')
      ? requestedRange as ActivityHistoryRange
      : 'recent'
    if (range === 'recent') return currentActivities()
    return agentPoller?.history(range) ?? localActivities
  })
  ipcMain.on('activity.detail', (_e, id?: string) => {
    const target = typeof id === 'string' ? activityTarget(id) : null
    if (target?.kind === 'mention') openMentionPanel(target.id)
    else if (target?.kind === 'external' && id) openActivityPanel(id)
    else showPanelHome()
  })
  ipcMain.on('activity.open', (_e, id: string) => {
    const target = activityTarget(id)
    if (!target) return
    acknowledgeAgentNagging()
    if (target.kind === 'external') {
      openExternalUrl(target.url)
    } else {
      const mention = mentions.get(target.id)
      if (mention?.permalink) openExternalUrl(mention.permalink)
      else openMentionPanel(target.id)
    }
  })
  ipcMain.on('pet.setMouseIgnore', (_e, ignore: boolean) => {
    if (pet) pet.setIgnoreMouseEvents(!!ignore, { forward: true })
  })
  ipcMain.on('pet.openCalendar', () => {
    void shell.openPath('/System/Applications/Calendar.app')
  })
  ipcMain.on('calendar.privacy.open', () => {
    void shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Calendars')
  })
  ipcMain.handle(CMD.calendarAccessRequest, async () => {
    calendarAccessStatus = await reminders.requestCalendarAccess()
    return calendarAccessStatus
  })
  ipcMain.on('build.tool.open', (_e, tool: BuildTool) => {
    const bundleId = tool === 'xcode' ? 'com.apple.dt.Xcode' : tool === 'android' ? 'com.google.android.studio' : ''
    if (bundleId) execFile('/usr/bin/open', ['-b', bundleId], () => {})
  })
  // Slack permalink는 데스크톱 앱으로, 나머지는 기본 외부 앱으로 연다(창 네비게이션 방지).
  ipcMain.on('open.external', (_e, url: string) => {
    if (typeof url === 'string' && /^https?:\/\//.test(url)) openExternalUrl(url)
  })

  // 맥 스타일 창 컨트롤 (프레임리스 → 커스텀 신호등)
  ipcMain.on('panel.hide', () => { activePanel()?.hide() })
  ipcMain.on('panel.minimize', () => { activePanel()?.minimize() })
  ipcMain.on('panel.maximize', () => {
    const win = activePanel()
    if (!win) return
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
  })

  // 스레드 추적 on/off · 목록에서 제거
  ipcMain.handle('mention.setTracked', (_e, a: { mentionId: string; tracked: boolean }) => {
    gateway?.setTracked(a.mentionId, a.tracked)
  })
  ipcMain.handle('mention.remove', (_e, id: string) => {
    gateway?.removeMention(id)
  })
  ipcMain.handle('mention.cleanupFalse', async () => {
    if (!gateway) return { removed: 0, checked: 0 }
    await ensureSlackUserToken()
    return gateway.cleanupFalseMentions()
  })
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
  // 스레드 대화 즉석 조회(예전 멘션은 thread가 없을 수 있음)
  ipcMain.handle('thread.get', async (_e, id: string, refresh = false) => {
    if (!gateway) return []
    if (refresh) await ensureSlackUserToken()
    return gateway.getThread(id, !!refresh)
  })

  // 코드 레포: 목록·추가(폴더 선택)·삭제 — 코드 원인 조사에 사용(claude --add-dir)
  ipcMain.handle('repos.list', () => configStore.get().repos)
  // 폴더 선택: git 레포면 바로 등록, 레포들을 모아둔 상위 폴더면 하위 레포 후보를 돌려줘 선택 등록
  ipcMain.handle('repos.add', async () => {
    const r = await dialog.showOpenDialog({ properties: ['openDirectory'] })
    if (r.canceled || !r.filePaths[0]) return null
    const dir = r.filePaths[0]
    if (isGitRepo(dir)) {
      const cur = configStore.get().repos
      const next = cur.includes(dir) ? cur : [...cur, dir]
      deps.config = configStore.update({ repos: next })
      return { repos: deps.config.repos }
    }
    return { candidates: scanGitRepos(dir, configStore.get().repos), dir }
  })
  ipcMain.handle('repos.addMany', (_e, paths: string[]) => {
    const valid = (Array.isArray(paths) ? paths : []).filter((path) => typeof path === 'string' && isGitRepo(path))
    const next = [...configStore.get().repos]
    for (const path of valid) if (!next.includes(path)) next.push(path)
    deps.config = configStore.update({ repos: next })
    return deps.config.repos
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
      await ensureSlackUserToken()
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
  // 말풍선은 하단을, HUD 접기·펼치기는 펫이 있는 상단을 기준으로 창 크기를 조절한다.
  ipcMain.on('pet.resize', (_e, value: number | {
    width?: number
    height?: number
    anchor?: 'left' | 'right'
    verticalAnchor?: 'top' | 'bottom'
  }) => {
    if (!pet || pet.isDestroyed()) return
    const b = pet.getBounds()
    const requestedHeight = typeof value === 'number' ? value : value?.height
    const requestedWidth = typeof value === 'number' ? b.width : value?.width
    if (typeof requestedHeight !== 'number' || typeof requestedWidth !== 'number') return
    const workArea = screen.getDisplayMatching(b).workArea
    const h = Math.max(164, Math.min(workArea.height, 1200, Math.round(requestedHeight)))
    const w = Math.max(340, Math.min(workArea.width, 860, Math.round(requestedWidth)))
    if (h === b.height && w === b.width) return
    const bottom = b.y + b.height
    const requestedX = typeof value === 'object' && value?.anchor === 'left'
      ? b.x
      : b.x + b.width - w
    const x = Math.max(workArea.x, Math.min(workArea.x + workArea.width - w, Math.round(requestedX)))
    const requestedY = typeof value === 'object' && value?.verticalAnchor === 'top'
      ? b.y
      : bottom - h
    const y = Math.max(workArea.y, Math.min(workArea.y + workArea.height - h, Math.round(requestedY)))
    pet.setBounds({ x, y, width: w, height: h })
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
    broadcastActivities()
  })
  gateway.on('mention:ready', (m: Mention) => {
    lastActivity = Date.now()
    broadcast(EVT.mentionReady, m)
    // 펫 말풍선: 내가 해야 할 행동 유도. 클릭하면 해당 스레드가 열림.
    send(pet, EVT.bubble, { text: m.direct === false ? bubbleFollowup(m) : bubbleReady(m), mentionId: m.id })
    broadcastActivities()
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
    broadcastActivities()
  })
  gateway.on('slack:news', (item: SlackNewsNaggingItem) => {
    state.enqueueNaggingSlackNews(item)
  })

  const agentBatchIds = new Set<string>()
  agentPoller = new LocalAgentPoller()
  agentPoller.on('snapshot', (activities: ActivitySession[]) => {
    const running = activities.filter((activity) => activity.state === 'running')
    if (running.length) {
      for (const activity of running) agentBatchIds.add(activity.id)
      const pending = state.get().nagging?.agent
      if (pending && running.some((activity) => activity.id === pending.activityId && activity.messages?.at(-1)?.role === 'user')) {
        acknowledgeAgentNagging()
      }
    } else if (agentBatchIds.size) {
      const current = configStore.get()
      const dueAt = Date.now() + Math.max(1, current.naggingMinMinutes) * 60_000
      const pending = agentNaggingPending(agentBatchIds, activities, dueAt)
      const previous = state.get().nagging?.agent
      if (pending && current.naggingEnabled && !activePanel()?.isFocused()) {
        state.setNaggingAgent(previous ? {
          ...pending,
          count: previous.count + pending.count,
          dueAt: Math.min(previous.dueAt, pending.dueAt),
          repeatCount: previous.repeatCount,
          waiting: previous.waiting || pending.waiting,
        } : pending)
      }
      agentBatchIds.clear()
    }
    localActivities = activities
    broadcastActivities()
  })
  agentPoller.start()
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
    if (configStore.get().naggingEnabled) return
    if (activePanel()?.isVisible()) return
    if (Date.now() - lastActivity < IDLE_MS) return
    refillQuips() // 캐시 보충(비동기)
    send(pet, EVT.bubble, idleLine())
    lastActivity = Date.now() // 다음 혼잣말까지 간격 확보
  }, 4 * 60 * 1000)

  // 베타 `잔소리`: 캘린더 임박 일정 → 확인하지 않은 Agent 완료 → GitHub PR/Slack 소식/Work 순서로 상기한다.
  // 다음 예정 시각과 이미 알린 대상을 저장해 앱 재실행 뒤에도 중복 알림을 피한다.
  let naggingTimer: NodeJS.Timeout | null = null
  let priorityNaggingBusy = false
  let calendarRetryAt = 0

  function showNagging(kind: NaggingLogKind, text: string, payload: Record<string, unknown>, context?: string): void {
    const entry: NaggingLogEntry = { at: Date.now(), kind, text, ...(context ? { context } : {}) }
    state.appendNaggingLog(entry)
    send(pet, EVT.bubble, { text, ...payload })
    broadcast(EVT.naggingLogChanged, entry)
  }

  function acknowledgeAgentNagging(): void {
    if (state.get().nagging?.agent) state.setNaggingAgent(undefined)
  }

  function scheduleNagging(reset = false): void {
    if (naggingTimer) clearTimeout(naggingTimer)
    naggingTimer = null
    const current = configStore.get()
    if (!current.naggingEnabled) {
      state.setNagging({ nextAt: undefined })
      acknowledgeAgentNagging()
      return
    }
    const now = Date.now()
    const savedNextAt = reset ? undefined : state.get().nagging?.nextAt
    const nextAt = savedNextAt && savedNextAt > now
      ? savedNextAt
      : now + nextNaggingDelayMs(current.naggingMinMinutes, current.naggingMaxMinutes)
    state.setNagging({ nextAt })
    naggingTimer = setTimeout(() => { void runNagging() }, Math.max(1000, nextAt - now))
  }

  async function runPriorityNagging(): Promise<boolean> {
    if (priorityNaggingBusy || !configStore.get().naggingEnabled || !pet || pet.isDestroyed()) return false
    priorityNaggingBusy = true
    try {
      const now = Date.now()
      if (now >= calendarRetryAt) {
        try {
          calendarAccessStatus ??= await reminders.calendarAuthorizationStatus()
          if (calendarAccessStatus === 'authorized') {
            const events = await reminders.upcomingEvents(now - 60_000, now + 6 * 60_000)
            const event = pickCalendarNaggingEvent(events, state.naggingCalendarNotified(), now)
            if (event) {
              state.markNaggingCalendar(calendarEventKey(event), now)
              showNagging('calendar', calendarNaggingLine(event, now), { calendarEvent: true }, event.title)
              lastActivity = now
              return true
            }
          }
        } catch (error) {
          calendarRetryAt = now + 15 * 60_000
          console.warn('잔소리 캘린더 조회 실패', error)
        }
      }

      const pending = state.get().nagging?.agent
      if (pending && pending.dueAt <= now) {
        showNagging('agent', agentNaggingLine(pending), { activityId: pending.activityId }, pending.title)
        state.setNaggingAgent({
          ...pending,
          dueAt: now + nextNaggingDelayMs(configStore.get().naggingMinMinutes, configStore.get().naggingMaxMinutes),
          repeatCount: pending.repeatCount + 1,
        })
        lastActivity = now
        return true
      }
      return false
    } finally {
      priorityNaggingBusy = false
    }
  }

  async function runNagging(): Promise<void> {
    try {
      const current = configStore.get()
      if (!current.naggingEnabled || !pet || pet.isDestroyed()) return
      if (await runPriorityNagging()) return
      const items = current.reminderListId
        ? await reminders.tasks(current.reminderListId, false).catch((error) => {
          console.warn('잔소리 Work 작업 조회 실패', error)
          return []
        })
        : []
      if (!configStore.get().naggingEnabled) return
      const item = pickNaggingWorkItem(items, state.workTouchedAt(), state.naggingRecentTaskIds())
      const news = current.slackNewsEnabled ? pickSlackNewsNagging(state.naggingSlackNews()) : null
      const githubPr = current.githubPrNaggingEnabled ? state.naggingGithubPr()[0] ?? null : null
      const source = chooseNaggingSource(!!item, !!news, !!githubPr)
      if (source === 'github' && githubPr) {
        state.dismissNaggingGithubPr(githubPr.id)
        showNagging('github', githubPrNaggingLine(githubPr), { externalUrl: githubPr.url }, `${githubPr.repository} #${githubPr.number}`)
        lastActivity = Date.now()
        return
      }
      if (source === 'slack' && news) {
        state.dismissNaggingSlackNews(news.id)
        showNagging('slack', slackNewsNaggingLine(news), { externalUrl: news.permalink }, `#${news.channelName}`)
        lastActivity = Date.now()
        return
      }
      if (source === 'work' && item) {
        state.rememberNaggingTask(item.id)
        showNagging('work', naggingLine(item), { workItemId: item.id }, item.title)
      } else {
        showNagging('general', naggingLine(null), {})
      }
      lastActivity = Date.now()
    } catch (error) {
      console.warn('잔소리 작업 조회 실패', error)
    } finally {
      scheduleNagging(true)
    }
  }

  scheduleNagging()
  githubPrPoller.start()
  buildCompletionPoller.start()
  workAgentPoller.start()
  setInterval(() => { void runPriorityNagging() }, 30_000)
  setTimeout(() => { void runPriorityNagging() }, 2_000)

  // 4) 감지원 부착: 봇(소켓) / 내 계정 검색 폴링 — config 플래그 + 토큰 존재 시
  const startupSecrets = startupSlackSecrets(config)
  const botToken = startupSecrets.bot ? await keychain.get(SecretKeys.slackBotToken) : null
  const appToken = startupSecrets.app ? await keychain.get(SecretKeys.slackAppToken) : null
  let userToken = startupSecrets.user ? await keychain.get(SecretKeys.slackUserToken) : null
  if (userToken) gateway.attachUserToken(userToken)
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

  async function ensureSlackUserToken(): Promise<string | null> {
    if (userToken) return userToken
    userToken = await keychain.get(SecretKeys.slackUserToken)
    if (userToken) gateway?.attachUserToken(userToken)
    return userToken
  }

  // 5) 명령 핸들러 (gateway 생성 이후 등록; gateway가 null이면 안전하게 무동작/기본값 반환)
  ipcMain.handle(CMD.mentionsList, () => mentions.all())
  ipcMain.handle(CMD.mentionGet, (_e, id: string) => mentions.get(id) ?? null)
  ipcMain.handle(CMD.mentionRead, (_e, id: string) => {
    mentions.markRead(id)
    broadcastActivities()
  })
  // 이 멘션 스레드에 매핑된 Reminder가 아직 살아있으면 id 반환, 아니면 null(외부 삭제 대비 재검증)
  ipcMain.handle(CMD.mentionReminderLink, async (_e, mentionId: string): Promise<string | null> => {
    const mention = mentions.get(mentionId)
    if (!mention) return null
    const current = configStore.get()
    const listId = current.reminderListId
    if (!listId) return null
    const key = reminderKey(mention.channel, mention.threadTs)
    let tasks: WorkItem[]
    try {
      tasks = await reminders.tasks(listId, true)
    } catch (e) {
      console.error('mention.reminder.link 조회 실패', e)
      return null
    }
    // 1차: 로컬 매핑(reminder-links.json) fast path
    const candidate = reminderLinks.get(key)
    if (candidate && candidate.listId === listId && tasks.some((t) => t.id === candidate.reminderId)) {
      return candidate.reminderId
    }
    // 2차: 로컬 매핑이 없거나 stale이면 미리알림 notes의 슬랙 링크를 파싱해 매칭 (기존/외부 생성 TODO 대비)
    for (const t of tasks) {
      for (const link of t.links) {
        if (link.kind !== 'slack') continue
        let target
        try {
          target = parseSlackThreadPermalink(link.url)
        } catch {
          continue
        }
        if (target.channel === mention.channel.toUpperCase() && target.threadTs === mention.threadTs) {
          reminderLinks.set(key, { reminderId: t.id, listId })
          return t.id
        }
      }
    }
    if (candidate) reminderLinks.delete(key)
    return null
  })
  // 멘션 스레드 → Reminder 생성/갱신 공용 로직: 같은 스레드에 이미 매핑된 Reminder가
  // 살아있으면(같은 목록 소속 + 아직 존재) 새로 만들지 않고 링크·서브태스크·마감일만 갱신한다.
  async function upsertMentionReminder(input: {
    mention: Mention
    listId: string
    title: string
    notes: string
    links: MentionReminderLink[]
    subtasks: string[]
    dueAt?: number
  }): Promise<MentionToWorkResult> {
    const { mention, listId, title, notes, links, subtasks, dueAt } = input
    const key = reminderKey(mention.channel, mention.threadTs)
    const candidate = reminderLinks.get(key)
    let existingId: string | undefined
    let existingTasks: WorkItem[] | undefined
    if (candidate && candidate.listId === listId) {
      try {
        existingTasks = await reminders.tasks(listId, true)
        if (existingTasks.some((t) => t.id === candidate.reminderId)) existingId = candidate.reminderId
      } catch (e) {
        console.error('reminders.tasks 조회 실패', e)
      }
    }
    if (existingId) {
      for (const link of links) await reminders.appendLink(existingId, link.title, link.url)
      const existingChildTitles = new Set(
        (existingTasks ?? []).filter((t) => t.parentId === existingId).map((t) => t.title),
      )
      for (const sub of subtasks) {
        if (!existingChildTitles.has(sub)) await reminders.addSubtask(existingId, sub)
      }
      if (typeof dueAt === 'number' && Number.isFinite(dueAt) && dueAt > 0) {
        await reminders.setDue(existingId, dueAt)
      }
      broadcast('work.focus', existingId)
      return { ok: true, id: existingId, updated: true }
    }
    const id = await reminders.create(listId, title, notes, dueAt)
    reminderLinks.set(key, { reminderId: id, listId })
    for (const link of links) await reminders.appendLink(id, link.title, link.url)
    for (const sub of subtasks) await reminders.addSubtask(id, sub)
    broadcast('work.focus', id)
    return { ok: true, id }
  }
  // 멘션 → work(Reminder) 변환: 목록 미선택이면 생성하지 않고 work 탭 전환만 안내
  ipcMain.handle(CMD.mentionToWork, async (_e, mentionId: string, dueAt?: number): Promise<MentionToWorkResult> => {
    const mention = mentions.get(mentionId)
    if (!mention) throw new Error('멘션을 찾지 못했습니다.')
    const current = configStore.get()
    if (!current.reminderListSelectionExplicit || !current.reminderListId) {
      broadcast('work.focus', 'no-list')
      return { ok: false, reason: 'no-list' }
    }
    const { title, notes, links, subtasks } = buildMentionReminder(mention)
    return upsertMentionReminder({
      mention,
      listId: current.reminderListId,
      title,
      notes,
      links,
      subtasks,
      dueAt: typeof dueAt === 'number' && Number.isFinite(dueAt) && dueAt > 0 ? dueAt : undefined,
    })
  })
  // 멘션 → work(Reminder) 변환(LLM 생성): 스레드 내용을 claude로 요약해 초안 생성.
  // LLM 결과가 비면 buildMentionReminder(고정 템플릿)로 필드별 폴백. 링크는 항상 템플릿 규칙 그대로.
  ipcMain.handle(CMD.mentionToWorkAI, async (_e, mentionId: string, extra?: string, dueAt?: number): Promise<MentionToWorkResult> => {
    const mention = mentions.get(mentionId)
    if (!mention) throw new Error('멘션을 찾지 못했습니다.')
    const current = configStore.get()
    if (!current.reminderListSelectionExplicit || !current.reminderListId) {
      broadcast('work.focus', 'no-list')
      return { ok: false, reason: 'no-list' }
    }
    const fallback = buildMentionReminder(mention)
    let draft: ReminderDraftText = { title: '', notes: '', subtasks: [] }
    try {
      draft = await generateReminderDraft({ config: deps.config, sessions, keychain, lessons }, { mention, extra })
    } catch (e) {
      console.error('generateReminderDraft 실패', e)
    }
    const title = draft.title.trim() || fallback.title
    const notes = draft.notes.trim() ? `<note>${draft.notes.trim()}</note>` : fallback.notes
    const subtasks = draft.subtasks.length ? draft.subtasks : fallback.subtasks
    const userDueAt = typeof dueAt === 'number' && Number.isFinite(dueAt) && dueAt > 0 ? dueAt : undefined
    const llmDueAt = typeof draft.dueAt === 'number' && Number.isFinite(draft.dueAt) && draft.dueAt > 0 ? draft.dueAt : undefined
    return upsertMentionReminder({
      mention,
      listId: current.reminderListId,
      title,
      notes,
      links: fallback.links,
      subtasks,
      dueAt: userDueAt ?? llmDueAt,
    })
  })
  ipcMain.handle(CMD.threadImport, async (_e, permalink: string) => {
    if (!gateway) return Promise.reject(new Error('Slack 연결을 초기화하지 못했습니다.'))
    await ensureSlackUserToken()
    return gateway.importThread(permalink)
  })
  ipcMain.handle(CMD.todoToggle, (_e, a: TodoToggleArgs) => {
    gateway?.toggleTodo(a.mentionId, a.index)
  })
  ipcMain.handle(CMD.replyApprove, async (_e, id: string) => {
    if (!gateway) return { ts: null }
    await ensureSlackUserToken()
    return gateway.approveReply(id)
  })
  ipcMain.handle(CMD.reactionSet, async (_e, a: ReactionSetArgs) => {
    if (!gateway) return { thread: [] }
    await ensureSlackUserToken()
    return gateway.setReaction(a.mentionId, a.messageTs, a.name, a.active)
  })
  ipcMain.handle('dev.run', (_e, a: { mentionId: string; repoPaths: string[]; extraContext: string }) => {
    if (!gateway) return Promise.resolve()
    send(pet, EVT.chatBubble, { type: 'start' })
    return gateway.runDev(a.mentionId, a.repoPaths || [], a.extraContext || '')
  })
  ipcMain.handle('reply.rewrite', async (_e, a: { mentionId: string; style: string }) => {
    if (!gateway) return { text: '' }
    return gateway.rewriteDraft(a.mentionId, a.style as never)
  })
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
  ipcMain.handle(CMD.settingsSet, (_e, patch: SettingsPatch) => {
    const current = configStore.get()
    const slackNewsChanged = ('slackNewsEnabled' in patch && patch.slackNewsEnabled !== current.slackNewsEnabled)
      || ('slackNewsChannels' in patch && JSON.stringify(patch.slackNewsChannels) !== JSON.stringify(current.slackNewsChannels))
      || ('slackNewsKeywords' in patch && JSON.stringify(patch.slackNewsKeywords) !== JSON.stringify(current.slackNewsKeywords))
    const merged = {
      ...patch,
      obsidian: { ...current.obsidian, ...(patch.obsidian ?? {}) },
    }
    const c = configStore.update(merged)
    deps.config = c
    bubbleStyle = c.bubbleStyle // 말풍선 표시 방식 즉시 반영 (persona는 다음 분석부터 config로 자동 반영)
    // 펫 테마·크기·말풍선·HUD·커스텀 이미지·Codex Pet 팩은 재시작 없이 즉시 반영
    send(pet, EVT.petTheme, c.petTheme)
    send(pet, EVT.petSize, c.petSizePercent)
    send(pet, EVT.bubbleSize, c.bubbleSizePercent)
    send(pet, EVT.bubbleStackCount, c.bubbleStackCount)
    send(pet, EVT.bubbleDuration, c.bubbleDurationSeconds)
    send(pet, EVT.hudSize, c.hudSizePercent)
    send(pet, EVT.hudAlignment, c.hudAlignment)
    send(pet, EVT.hudVisibility, c.showActivityHud)
    send(pet, EVT.petImages, petImagesFromDir(c.petImageDir))
    send(pet, EVT.petCodex, resolveCodexPet(c.petCodexDir))
    if (pet && !pet.isDestroyed()) pet.setAlwaysOnTop(c.petAlwaysOnTop) // 즉시 반영
    if ('naggingEnabled' in patch || 'naggingMinMinutes' in patch || 'naggingMaxMinutes' in patch || 'githubPrNaggingEnabled' in patch || 'slackNewsEnabled' in patch) {
      scheduleNagging(true)
      if (c.naggingEnabled) void runPriorityNagging()
    }
    if ('naggingEnabled' in patch || 'githubPrNaggingEnabled' in patch) {
      if (!c.naggingEnabled || !c.githubPrNaggingEnabled) state.clearNaggingGithubPr()
      else void githubPrPoller?.pollNow()
    }
    if ('buildAlertsEnabled' in patch || 'xcodeBuildAlertsEnabled' in patch || 'androidBuildAlertsEnabled' in patch) {
      void buildCompletionPoller?.pollNow()
    }
    if ('naggingEnabled' in patch || 'slackNewsEnabled' in patch || 'slackNewsChannels' in patch || 'slackNewsKeywords' in patch) {
      if (slackNewsChanged) state.clearNaggingSlackNews()
      void gateway?.refreshSlackNews()
    }
    // Work 자동 제안을 켜면 바로 한 번 후보를 확인한다
    if ('workAgentEnabled' in patch && c.workAgentEnabled) void workAgentPoller?.pollNow(true)
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
  ipcMain.handle('integration.status', async (_e, verify = false) => {
    const status = await integrationStatus(configStore)
    if (!verify || !status.jira.connected) return status
    const auth = await workStatus.jiraConnectionStatus()
    return { ...status, jira: { ...status.jira, ...auth } }
  })
  ipcMain.handle('integration.connectNotion', async (_e, token: string) => {
    deps.config = await connectNotion(configStore, keychain, token || '')
  })
  ipcMain.handle('integration.connectJira', async (_e, a: { site: string; email: string; token: string }) => {
    deps.config = await connectJira(configStore, keychain, { site: a.site || '', email: a.email || '', token: a.token || '' })
    workStatus.resetJiraAuth()
  })
  ipcMain.handle('integration.disconnect', (_e, id: 'notion' | 'jira') => {
    deps.config = disconnectIntegration(configStore, id)
    if (id === 'jira') workStatus.resetJiraAuth()
  })

  // 6) 일반 감지는 mySlackUserId, Slack 소식 구독은 User Token만 있어도 기동
  if (gateway.hasSource() && (config.mySlackUserId || !!userToken)) {
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
    if (!gateway.hasSource()) missing.push('슬랙 연결(봇 토큰 또는 User Token)')
    if (!config.mySlackUserId && !userToken) missing.push('mySlackUserId')
    console.warn(`미설정 — Slack 감시 대기 중: ${missing.join(', ')}. 설정 탭에서 저장 후 앱 재시작.`)
  }
}

app.whenReady().then(() => {
  ensureOpenAtLogin(app)
  return main()
})
app.on('window-all-closed', () => {
  /* 트레이 상주: macOS에서 유지 */
})
app.on('before-quit', () => {
  isQuitting = true
  agentPoller?.stop()
  githubPrPoller?.stop()
  buildCompletionPoller?.stop()
  workAgentPoller?.stop()
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
