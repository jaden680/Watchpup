import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { App, LogLevel } from '@slack/bolt'
import { WebClient } from '@slack/web-api'
import type { WatchpupConfig } from '../config/schema.js'
import type { Mention, PetState, AgentStreamEvent, ThreadMsg } from '../types.js'
import { MENTION_CATEGORIES } from '../types.js'
import { SessionStore, threadKey } from '../session/store.js'
import { Keychain } from '../secrets/keychain.js'
import { KeyedMutex } from '../session/locks.js'
import { Semaphore } from '../session/semaphore.js'
import { StateStore } from '../state/store.js'
import { MentionStore } from '../state/mentions.js'
import { classify, stripMention, mentionsUser, mentionsAnyGroup } from '../trigger/matcher.js'
import { analyzeMention, chatFollowup, runPlaybook } from '../watchpup/pipeline.js'
import { rewriteReply, type RewriteStyle } from '../watchpup/rewrite.js'
import { runDev } from '../watchpup/dev.js'
import { selfCritique, distillFeedback } from '../watchpup/reflect.js'
import type { LessonStore, Lesson } from '../state/lessons.js'
import { saveMentionNote } from '../knowledge/obsidian.js'
import { sanitizeOutput } from '../safety/redact.js'
import { fetchThreadMessages, resolveUserName, resolveChannelName, getPermalink, resolveMentions, resolveSubteams, formatSlackPlain } from './context.js'
import { logger } from '../observability/logger.js'
import { AuditStore } from '../observability/audit.js'
import { SearchPoller, type RawMention } from './search-poller.js'
import { ThreadFollowPoller } from './thread-poller.js'
import { decideIngest } from './ingest-filter.js'
import { compareSlackTs, latestSlackTs } from './timestamp.js'
import { parseSlackThreadPermalink } from './permalink.js'
import { SlackNewsPoller } from './news-poller.js'
import { threadText as buildThreadText, actionContext, devContext, devTitle } from '../watchpup/mention-context.js'

export interface GatewayDeps {
  config: WatchpupConfig
  sessions: SessionStore
  keychain: Keychain
  mutex: KeyedMutex
  semaphore: Semaphore
  state: StateStore
  mentions: MentionStore
  audit: AuditStore
  lessons: LessonStore
}

export interface ThreadImportResult {
  id: string
  existing: boolean
}

/**
 * 감지원 독립 엔진. 소켓(봇) / 검색 폴링(내 계정)을 attach로 붙이면 되고, 둘 다 붙여
 * 동시 사용 가능. 두 소스 모두 handleMention(raw, client)로 수렴한다.
 * - 읽기(스레드/이름/permalink)는 각 소스가 넘긴 client 사용.
 * - 답장 게시는 userClient가 있으면 "나"로, 없으면 botClient로.
 */
export class WatchpupGateway extends EventEmitter {
  private app: App | null = null
  private botClient: WebClient | null = null
  private userClient: WebClient | null = null
  private poller: SearchPoller | null = null
  private followPoller: ThreadFollowPoller | null = null
  private newsPoller: SlackNewsPoller | null = null
  private pendingThreadImports = new Map<string, string>()
  /** 내가 속한 유저그룹 ID/핸들(@team) — attachUserSearch에서 usergroups.list로 채워짐(usergroups:read 필요) */
  private myGroupIds: string[] = []
  private groupHandles: string[] = []

  constructor(private readonly deps: GatewayDeps) {
    super()
    this.applyGroupsFromConfig()
  }

  /** config.myGroups → 인메모리 그룹 감지 목록(소켓 classify + 검색 쿼리). groupHandles는 in-place 갱신. */
  private applyGroupsFromConfig(): void {
    const groups = this.cfg().myGroups ?? []
    this.myGroupIds = groups.map((g) => g.id)
    this.groupHandles.length = 0
    for (const g of groups) if (g.handle) this.groupHandles.push(`@${g.handle}`)
  }

  /** 설정 변경 후 그룹 목록 재적용(재시작 없이 즉시 반영) */
  reapplyGroups(): void {
    this.applyGroupsFromConfig()
  }

  /** 내가 속한 유저그룹 검색 — usergroups:read 필요. 실패 시 throw(호출부에서 안내). */
  async researchGroups(myUserId: string): Promise<{ id: string; handle: string; name: string }[]> {
    const client = this.replyClient()
    if (!client) throw new Error('연결된 Slack 클라이언트가 없습니다 (토큰/재시작 확인)')
    const res = (await client.usergroups.list({ include_users: true })) as {
      usergroups?: Array<{ id?: string; handle?: string; name?: string; users?: string[] }>
    }
    return (res.usergroups ?? [])
      .filter((g) => !!g.id && Array.isArray(g.users) && g.users.includes(myUserId))
      .map((g) => ({ id: g.id as string, handle: g.handle || '', name: g.name || g.handle || '' }))
  }

  private cfg(): WatchpupConfig {
    return this.deps.config
  }
  private pet(state: PetState): void {
    this.emit('pet', state)
  }
  private replyClient(): WebClient | null {
    return this.userClient ?? this.botClient
  }

  /** 쓰기 작업(답장·리액션)을 사용자 계정으로 실행할 수 있도록 User Token 클라이언트를 준비한다. */
  attachUserToken(userToken: string): void {
    this.userClient = new WebClient(userToken)
    this.attachFollowPoller(this.userClient, this.cfg().mySlackUserId, this.cfg().searchIntervalSec)
    this.attachNewsPoller(this.userClient, this.cfg().searchIntervalSec)
  }

  private attachNewsPoller(client: WebClient, intervalSec: number): void {
    if (this.newsPoller) return
    this.newsPoller = new SlackNewsPoller(
      client,
      intervalSec,
      () => ({
        enabled: this.cfg().naggingEnabled && this.cfg().slackNewsEnabled,
        channels: this.cfg().slackNewsChannels,
        keywords: this.cfg().slackNewsKeywords,
        myUserId: this.cfg().mySlackUserId,
      }),
      (key) => this.deps.state.getNaggingSlackNewsCursor(key),
      (key, ts) => this.deps.state.setNaggingSlackNewsCursor(key, ts),
      (candidate) => { this.emit('slack:news', candidate) },
    )
  }

  private attachFollowPoller(client: WebClient, myUserId: string, intervalSec: number): void {
    if (!this.cfg().followThreads || !myUserId || this.followPoller) return
    this.followPoller = new ThreadFollowPoller(
      client,
      () => this.deps.state.trackedThreads(),
      (channel, threadTs) => this.deps.state.getThreadCursor(threadKey(channel, threadTs)),
      (channel, threadTs, ts) => this.deps.state.setThreadCursor(threadKey(channel, threadTs), ts),
      myUserId,
      intervalSec,
      (raw) => { void this.handleMention(raw, client) },
    )
  }

  /** 봇(소켓) 소스 부착 — 봇이 초대된 채널의 @나 멘션/스레드 후속을 즉시 감지 */
  attachSocket(botToken: string, appToken: string): void {
    this.app = new App({ token: botToken, appToken, socketMode: true, logLevel: LogLevel.WARN })
    this.botClient = this.app.client
    this.app.message(async ({ message }) => {
      const m = message as {
        subtype?: string; bot_id?: string; user?: string; text?: string
        channel: string; ts: string; thread_ts?: string
      }
      if (m.subtype || m.bot_id || !m.user || !m.text) return
      const myId = this.cfg().mySlackUserId
      const threadTs = m.thread_ts || m.ts
      const isFollowup = m.thread_ts ? !!this.deps.state.mentionIdFor(threadKey(m.channel, threadTs)) : false
      const verdict = classify({
        text: m.text, myUserId: myId, isFollowupInMyThread: isFollowup,
        followThreads: this.cfg().followThreads, myGroupIds: this.myGroupIds,
      })
      if (!verdict.triggered) return
      void this.handleMention({ channel: m.channel, threadTs, messageTs: m.ts, authorId: m.user, text: m.text, direct: verdict.kind === 'my_mention' }, this.botClient!)
    })
  }

  /** 내 계정(User Token) 검색 폴링 소스 부착 — 전 채널의 @나 멘션 (+ 스레드 후속, 유저그룹 검색) */
  attachUserSearch(userToken: string, myUserId: string, intervalSec: number): void {
    if (!this.userClient) this.attachUserToken(userToken)
    const client = this.userClient!
    // groupHandles는 참조로 넘겨 resolveMyGroups()가 나중에(비동기) 채워도 다음 폴링부터 반영되게 한다.
    this.poller = new SearchPoller(client, myUserId, intervalSec, (raw) => {
      void this.handleMention(raw, client)
    }, this.groupHandles)
    this.applyGroupsFromConfig()

    this.attachFollowPoller(client, myUserId, intervalSec)
  }

  /** 사용자가 붙여넣은 과거 Slack 스레드를 나이·멘션 필터 없이 분석하고 추적한다. */
  async importThread(permalink: string): Promise<ThreadImportResult> {
    const target = parseSlackThreadPermalink(permalink)
    const key = threadKey(target.channel, target.threadTs)
    const linkedId = this.deps.state.mentionIdFor(key)
    const existing = (linkedId ? this.deps.mentions.get(linkedId) : undefined)
      ?? this.deps.mentions.all().find((mention) => mention.channel === target.channel && mention.threadTs === target.threadTs)
    if (existing) {
      if (existing.tracked === false || !linkedId) this.setTracked(existing.id, true)
      return { id: existing.id, existing: true }
    }
    if (linkedId) this.deps.state.unlinkThread(key)
    const pendingId = this.pendingThreadImports.get(key)
    if (pendingId) return { id: pendingId, existing: true }

    const clients = [this.userClient, this.botClient].filter((client): client is WebClient => !!client)
    if (!clients.length) throw new Error('Slack User Token 또는 Bot Token을 먼저 연결해주세요.')

    let client: WebClient | null = null
    let root: { ts?: string; user?: string; bot_id?: string; text?: string } | undefined
    let firstError: unknown
    for (const candidate of clients) {
      try {
        const response = await candidate.conversations.replies({
          channel: target.channel,
          ts: target.threadTs,
          limit: 1,
        })
        root = response.messages?.[0] as typeof root
        client = candidate
        break
      } catch (err) {
        firstError ??= err
      }
    }
    if (!client) throw firstError ?? new Error('Slack 스레드를 읽지 못했습니다.')
    if (!root?.ts) throw new Error('Slack 스레드의 첫 메시지를 찾지 못했습니다.')

    const id = randomUUID()
    const raw: RawMention = {
      channel: target.channel,
      threadTs: target.threadTs,
      messageTs: root.ts,
      authorId: root.user || root.bot_id || '',
      text: root.text || '(텍스트 없는 메시지)',
      requestId: id,
      permalink: permalink.trim(),
    }
    this.pendingThreadImports.set(key, id)
    const job = this.deps.mutex.run(key, () => this.deps.semaphore.run(() => this.ingest(raw, client!)))
    void job
      .catch((err) => logger.error('수동 스레드 가져오기 실패', { channel: target.channel, threadTs: target.threadTs, err: String(err) }))
      .finally(() => {
        if (this.pendingThreadImports.get(key) === id) this.pendingThreadImports.delete(key)
      })
    return { id, existing: false }
  }

  /** 두 소스의 공통 진입점: 수집·필터(dedup·나이컷) → (필요 시) 스레드 root 해석 → 스레드별 직렬화 → 분석 */
  private async handleMention(raw: RawMention, client: WebClient): Promise<void> {
    const dedupKey = `m:${raw.channel}:${raw.messageTs}`
    const alreadyTracked = !!this.deps.state.mentionIdFor(threadKey(raw.channel, raw.threadTs))
    const decision = decideIngest({
      messageTs: raw.messageTs,
      nowMs: Date.now(),
      maxAgeDays: this.cfg().ingestMaxAgeDays,
      alreadySeen: this.deps.state.seen(dedupKey),
      alreadyTracked,
    })
    if (decision.markSeen) this.deps.state.markSeen(dedupKey)
    if (!decision.ingest) {
      if (decision.reason === 'too-old') logger.info('오래된 메시지 수집 제외', { channel: raw.channel, ts: raw.messageTs })
      return
    }
    // 새 스레드(미추적)는 "진짜 멘션 토큰"(<@나> 또는 <!subteam^내그룹>)이 있을 때만 수집한다.
    // 검색 폴러가 평문 텍스트(예: GitHub의 @org/repo)를 그룹 핸들로 오탐하는 것 방지.
    // (이미 추적 중인 스레드의 후속은 토큰이 없어도 통과 — 따라가기 의도)
    if (!alreadyTracked) {
      const myId = this.cfg().mySlackUserId
      if (!mentionsUser(raw.text, myId) && !mentionsAnyGroup(raw.text, this.myGroupIds)) {
        logger.info('진짜 멘션 토큰 없음(텍스트 오탐 추정) — 수집 제외', { channel: raw.channel, ts: raw.messageTs })
        return
      }
    }
    // 검색(유저) 소스는 thread_ts가 없어 threadTs가 답글 ts일 수 있다.
    // replies로 실제 thread_ts(root)를 해석해야 스레드 전체 맥락을 읽는다.
    let threadTs = raw.threadTs
    if (raw.needsRootResolve) {
      try {
        const r = await client.conversations.replies({ channel: raw.channel, ts: raw.messageTs, limit: 1 })
        const root = (r.messages?.[0] as { thread_ts?: string } | undefined)?.thread_ts
        if (root) threadTs = root
      } catch (err) {
        logger.warn('thread root 해석 실패', { err: String(err) })
      }
    }
    const resolved: RawMention = { ...raw, threadTs }
    const key = threadKey(resolved.channel, threadTs)
    const cursor = this.deps.state.getThreadCursor(key)
    if (cursor && compareSlackTs(resolved.messageTs, cursor) <= 0) {
      logger.info('이미 읽은 스레드 메시지 수집 제외', { channel: resolved.channel, ts: resolved.messageTs })
      return
    }
    void this.deps.mutex.run(key, () => this.deps.semaphore.run(() => this.ingest(resolved, client)))
  }

  private async ingest(raw: RawMention, client: WebClient): Promise<void> {
    this.pet('thinking')
    const tKey = threadKey(raw.channel, raw.threadTs)
    const existingId = this.deps.state.mentionIdFor(tKey)
    const isNew = !existingId
    const id = existingId ?? raw.requestId ?? randomUUID()
    const myId = this.cfg().mySlackUserId
    try {
      const [thread, authorName, channelName, permalink, text] = await Promise.all([
        fetchThreadMessages(client, raw.channel, raw.threadTs, myId, { limit: this.cfg().threadFetchLimit }),
        resolveUserName(client, raw.authorId),
        resolveChannelName(client, raw.channel),
        raw.permalink ? Promise.resolve(raw.permalink) : getPermalink(client, raw.channel, raw.messageTs),
        resolveMentions(client, stripMention(raw.text, myId)).then((t) => resolveSubteams(client, t)).then(formatSlackPlain),
      ])
      const threadText = thread.map((m) => `${m.author}: ${m.text.replace(/\s+/g, ' ').trim()}`).join('\n')
      // fetchThreadMessages로 실제 읽은 최신 메시지까지 즉시 기록한다. 새 스레드를 추적 목록에
      // 넣기 전에 저장해 후속 폴러가 과거 답글을 새 메시지로 재수집하지 않게 한다.
      const latestReadTs = latestSlackTs([raw.messageTs, ...thread.map((m) => m.ts)]) ?? raw.messageTs
      this.deps.state.setThreadCursor(tKey, latestReadTs)
      const placeholder: Mention = {
        id, channel: raw.channel, channelName, threadTs: raw.threadTs, messageTs: raw.messageTs,
        permalink, authorId: raw.authorId, authorName, text, mentionedAt: Date.now(),
        status: 'analyzing', todos: [], thread,
      }
      this.deps.mentions.set(id, placeholder)
      if (isNew) this.deps.state.linkThread(tKey, id)
      this.emit('mention:new', placeholder)

      const mention = await analyzeMention(
        { config: this.cfg(), sessions: this.deps.sessions, keychain: this.deps.keychain, lessons: this.deps.lessons },
        { ...placeholder, threadText: threadText || raw.text, mentionedAt: placeholder.mentionedAt,
          onEvent: (e) => this.emit('chat:stream', { mentionId: id, event: e, source: 'analysis' }) },
      )
      if (typeof raw.direct === 'boolean') mention.direct = raw.direct
      mention.thread = thread
      this.deps.mentions.set(id, mention)
      saveMentionNote(this.cfg().obsidian, mention)
      // 자가발전: 백그라운드로 자가평가 → 교훈이 있으면 'analysis' 워크플로우에 자동 축적(다음 분석에 주입)
      void this.critiqueInBackground('analysis', threadText || raw.text, JSON.stringify(mention.analysis ?? {}))
      // 새 스레드/직접 멘션/후속 답글 모두 알림(배지↑) — 후속도 놓치지 않게. 구분은 direct로.
      this.deps.state.setBadge(this.deps.state.get().badge + 1)
      this.emit('badge', this.deps.state.get().badge)
      this.emit('mention:ready', mention)
      // 스레드 후속 폴링 커서 전진 — 소켓/검색 어느 경로로 처리됐든 다음 폴링에서 이 ts는 건너뛴다.
      this.deps.state.setThreadCursor(tKey, raw.messageTs)
      this.deps.audit.record({
        ts: Date.now(), requestId: id, channel: raw.channel, kind: 'mention',
        text, write: false, toolsUsed: [], outcome: 'ok',
      })
    } catch (err) {
      logger.error('ingest 실패', { err: String(err) })
      this.deps.audit.record({
        ts: Date.now(), requestId: id, channel: raw.channel, kind: 'mention',
        text: raw.text, write: false, toolsUsed: [], outcome: 'error',
      })
    } finally {
      this.pet('idle')
    }
  }

  /** 답장 초안 승인 → Slack 스레드에 게시 (유일한 chat.postMessage 경로) */
  async approveReply(mentionId: string): Promise<{ ts: string | null }> {
    const m = this.deps.mentions.get(mentionId)
    if (!m || !m.analysis?.draftReply) return { ts: null }
    if (m.status === 'replied') return { ts: null }
    const client = this.replyClient()
    if (!client) return { ts: null }
    const text = sanitizeOutput(m.analysis.draftReply).text
    const res = await client.chat.postMessage({ channel: m.channel, thread_ts: m.threadTs, text })
    m.status = 'replied'
    this.deps.mentions.set(mentionId, m)
    saveMentionNote(this.cfg().obsidian, m)
    this.deps.audit.record({
      ts: Date.now(), requestId: m.id, channel: m.channel, kind: 'reply',
      text, write: true, approved: true, outcome: 'ok',
    })
    return { ts: (res.ts as string) ?? null }
  }

  /** 스레드 메시지 리액션 추가/취소 — 사용자 토큰으로 실행해 내 Slack 계정의 반응으로 남긴다. */
  async setReaction(
    mentionId: string,
    messageTs: string,
    name: string,
    active: boolean,
  ): Promise<{ thread: ThreadMsg[] }> {
    const m = this.deps.mentions.get(mentionId)
    if (!m || !messageTs || !/^[a-z0-9_+-]{1,100}$/i.test(name)) return { thread: m?.thread ?? [] }
    if (!this.userClient) throw new Error('리액션에는 reactions:write 권한이 있는 User Token이 필요합니다.')

    try {
      if (active) await this.userClient.reactions.add({ channel: m.channel, timestamp: messageTs, name })
      else await this.userClient.reactions.remove({ channel: m.channel, timestamp: messageTs, name })
    } catch (err) {
      const code = (err as { data?: { error?: string } })?.data?.error
      const alreadyInDesiredState = (active && code === 'already_reacted') || (!active && code === 'no_reaction')
      if (!alreadyInDesiredState) throw err
    }

    const message = m.thread?.find((item) => item.ts === messageTs)
    if (message) {
      const reactions = message.reactions ?? (message.reactions = [])
      const existing = reactions.find((reaction) => reaction.name === name)
      if (existing) {
        if (existing.reacted !== active) existing.count += active ? 1 : -1
        existing.reacted = active
        if (existing.count <= 0) message.reactions = reactions.filter((reaction) => reaction !== existing)
      } else if (active) {
        reactions.push({ name, count: 1, reacted: true })
      }
    }
    this.deps.mentions.set(mentionId, m)
    this.deps.audit.record({
      ts: Date.now(), requestId: m.id, channel: m.channel, kind: active ? 'reaction.add' : 'reaction.remove',
      text: `:${name}:`, write: true, approved: true, outcome: 'ok',
    })
    return { thread: m.thread ?? [] }
  }

  /** 답장 초안을 요청 톤으로 리라이트 → 초안 갱신 후 새 텍스트 반환 */
  async rewriteDraft(mentionId: string, style: RewriteStyle): Promise<{ text: string }> {
    const m = this.deps.mentions.get(mentionId)
    if (!m || !m.analysis?.draftReply) return { text: '' }
    const text = await rewriteReply({ config: this.cfg(), keychain: this.deps.keychain }, m.analysis.draftReply, style)
    if (text) {
      m.analysis.draftReply = text
      this.deps.mentions.set(mentionId, m)
      saveMentionNote(this.cfg().obsidian, m)
    }
    return { text }
  }

  toggleTodo(mentionId: string, index: number): void {
    const m = this.deps.mentions.get(mentionId)
    if (!m || !m.todos[index]) return
    m.todos[index].done = !m.todos[index].done
    this.deps.mentions.set(mentionId, m)
    saveMentionNote(this.cfg().obsidian, m)
  }

  /** 스레드 추적 on/off. off면 후속 폴링 대상에서 제외(카드는 유지). */
  setTracked(mentionId: string, tracked: boolean): void {
    const m = this.deps.mentions.get(mentionId)
    if (!m) return
    m.tracked = tracked
    this.deps.mentions.set(mentionId, m)
    const key = threadKey(m.channel, m.threadTs)
    if (tracked) this.deps.state.linkThread(key, mentionId)
    else this.deps.state.unlinkThread(key)
    this.emit('mentions:refresh')
  }

  /** 카테고리 수동 이동(분류 수정). 분석이 없으면 스텁 생성. */
  setCategory(mentionId: string, category: string): void {
    const m = this.deps.mentions.get(mentionId)
    if (!m) return
    const a = m.analysis ?? { headline: '', summary: '', advice: '', todos: [], draftReply: '', actions: [] }
    a.category = (MENTION_CATEGORIES as string[]).includes(category) ? (category as never) : undefined
    m.analysis = a
    this.deps.mentions.set(mentionId, m)
    this.emit('mentions:refresh')
  }

  /**
   * 오탐 일괄 정리 — 저장된 멘션들의 스레드를 재검사해, 어떤 메시지에도 진짜 멘션 토큰
   * (<@나> · <!subteam^내그룹>)이 없는 스레드를 제거한다(예: GitHub 평문 @org/repo 오탐).
   * API 오류로 확인 못 한 건은 안전하게 보존. 반환: { removed, checked }.
   */
  async cleanupFalseMentions(): Promise<{ removed: number; checked: number }> {
    const client = this.replyClient()
    const myId = this.cfg().mySlackUserId
    if (!client) return { removed: 0, checked: 0 }
    let removed = 0
    let checked = 0
    for (const m of this.deps.mentions.all()) {
      try {
        const r = await this.deps.semaphore.run(() =>
          client.conversations.replies({ channel: m.channel, ts: m.threadTs, limit: 50 }),
        )
        const msgs = (r.messages ?? []) as Array<{ text?: string }>
        checked++
        const genuine = msgs.some((x) => mentionsUser(x.text ?? '', myId) || mentionsAnyGroup(x.text ?? '', this.myGroupIds))
        if (!genuine) {
          this.deps.state.unlinkThread(threadKey(m.channel, m.threadTs))
          this.deps.mentions.remove(m.id)
          removed++
        }
      } catch (err) {
        logger.warn('cleanup 재검사 실패(보존)', { id: m.id, err: String(err) })
      }
    }
    if (removed) this.emit('mentions:refresh')
    return { removed, checked }
  }

  /** 목록에서 제거 + 후속 추적 해제. */
  removeMention(mentionId: string): void {
    const m = this.deps.mentions.get(mentionId)
    if (!m) return
    this.deps.state.unlinkThread(threadKey(m.channel, m.threadTs))
    this.deps.mentions.remove(mentionId)
    this.emit('mentions:refresh')
  }

  async chat(mentionId: string, text: string, onEvent?: (e: AgentStreamEvent) => void): Promise<{ text: string }> {
    const m = this.deps.mentions.get(mentionId)
    if (!m) return { text: '' }
    this.pet('chatting')
    try {
      const key = threadKey(m.channel, m.threadTs)
      return await this.deps.mutex.run(key, () => this.deps.semaphore.run(() => chatFollowup(
        { config: this.cfg(), sessions: this.deps.sessions, keychain: this.deps.keychain },
        { channel: m.channel, threadTs: m.threadTs, prompt: text,
          onEvent: (e) => { onEvent?.(e); this.emit('chat:stream', { mentionId, event: e, source: 'chat' }) } },
      )))
    } finally {
      this.pet('idle')
    }
  }

  /**
   * 액션(playbook 워크플로우) 실행. 진행은 'action:stream', 완료는 'action:done'으로 방출.
   * write playbook은 UI에서 승인 후 호출되는 것을 전제(여기선 그대로 실행).
   */
  async runAction(mentionId: string, playbookId: string, extra = ''): Promise<{ text: string }> {
    const m = this.deps.mentions.get(mentionId)
    if (!m) return { text: '' }
    const playbook = this.cfg().playbooks.find((p) => p.id === playbookId && p.enabled)
    if (!playbook) {
      this.emit('action:done', { mentionId, playbookId, text: '해당 워크플로우를 찾을 수 없습니다.', error: true })
      return { text: '' }
    }
    const context = actionContext(m)
    this.pet('chatting')
    const key = threadKey(m.channel, m.threadTs)
    try {
      const result = await this.deps.mutex.run(key, () => this.deps.semaphore.run(() => runPlaybook(
        { config: this.cfg(), sessions: this.deps.sessions, keychain: this.deps.keychain, lessons: this.deps.lessons },
        { channel: m.channel, threadTs: m.threadTs, playbook, context, extra,
          onEvent: (e) => this.emit('action:stream', { mentionId, playbookId, event: e }) },
      )))
      this.deps.audit.record({
        ts: Date.now(), requestId: m.id, channel: m.channel, kind: `action:${playbookId}`,
        text: playbook.name, write: playbook.write, approved: playbook.write ? true : undefined, outcome: 'ok',
      })
      this.emit('action:done', { mentionId, playbookId, text: result.text, error: false })
      // 자가발전: 이 워크플로우(playbookId)의 실행 품질 자가평가 → 교훈 축적
      void this.critiqueInBackground(playbookId, context, result.text)
      return result
    } catch (err) {
      logger.error('runAction 실패', { playbookId, err: String(err) })
      this.emit('action:done', { mentionId, playbookId, text: '실행 실패: ' + String(err), error: true })
      return { text: '' }
    } finally {
      this.pet('idle')
    }
  }

  /** 백그라운드 자가평가 → lesson이 있으면 해당 워크플로우 key에 축적(사용자 방해 없음). lowScore가 있으면 그 맥락을 전달. */
  private async critiqueInBackground(key: string, threadText: string, output: string, lowScore?: number): Promise<void> {
    try {
      const { lesson } = await this.deps.semaphore.run(() =>
        selfCritique({ config: this.cfg() }, { threadText, output, lowScore }),
      )
      if (lesson) {
        this.deps.lessons.add(key, lesson, 'self')
        this.emit('lessons:changed')
      }
    } catch (err) {
      logger.warn('critiqueInBackground 실패', { key, err: String(err) })
    }
  }

  /** 교훈을 반영해 이 멘션을 즉시 재분석(스레드 세션 유지). rating은 초기화. */
  async reanalyze(mentionId: string): Promise<void> {
    const m = this.deps.mentions.get(mentionId)
    if (!m) return
    const threadText = buildThreadText(m)
    try {
      this.pet('thinking')
      m.status = 'analyzing'
      this.deps.mentions.set(mentionId, m)
      this.emit('mention:new', m)
      const fresh = await analyzeMention(
        { config: this.cfg(), sessions: this.deps.sessions, keychain: this.deps.keychain, lessons: this.deps.lessons },
        {
          id: m.id, channel: m.channel, channelName: m.channelName, threadTs: m.threadTs, messageTs: m.messageTs,
          authorId: m.authorId, authorName: m.authorName, text: m.text, threadText, permalink: m.permalink,
          mentionedAt: m.mentionedAt,
          onEvent: (e) => this.emit('chat:stream', { mentionId, event: e, source: 'analysis' }),
        },
      )
      fresh.direct = m.direct
      fresh.thread = m.thread
      fresh.readAt = m.readAt
      fresh.rating = undefined // 새 분석이므로 만족도 리셋
      this.deps.mentions.set(mentionId, fresh)
      this.emit('mention:ready', fresh)
    } catch (err) {
      logger.error('reanalyze 실패', { err: String(err) })
    } finally {
      this.pet('idle')
    }
  }

  /**
   * 사용자 피드백 → 교훈 증류·축적('analysis' 워크플로우) → 즉시 재분석해 반영 결과를 보여줌.
   * 반환: 반영된 새 교훈(있으면).
   */
  async feedback(mentionId: string, text: string): Promise<{ lesson: string | null }> {
    const m = this.deps.mentions.get(mentionId)
    if (!m) return { lesson: null }
    const threadText = buildThreadText(m)
    const lesson = await this.deps.semaphore.run(() =>
      distillFeedback({ config: this.cfg() }, { threadText, output: JSON.stringify(m.analysis ?? {}), feedback: text }),
    )
    if (lesson) {
      this.deps.lessons.add('analysis', lesson, 'user')
      this.emit('lessons:changed')
    }
    await this.reanalyze(mentionId)
    return { lesson }
  }

  /**
   * 만족도 평가(1~5). 학습에 사용:
   *  - 점수를 멘션에 기록(표시·집계용)
   *  - 낮은 점수(≤2)면 백그라운드 자가평가로 개선 교훈을 뽑아 'analysis'에 축적
   */
  async rate(mentionId: string, score: number): Promise<void> {
    const m = this.deps.mentions.get(mentionId)
    if (!m) return
    const s = Math.max(1, Math.min(5, Math.round(score)))
    m.rating = s
    this.deps.mentions.set(mentionId, m)
    this.deps.audit.record({
      ts: Date.now(), requestId: m.id, channel: m.channel, kind: 'rating',
      text: String(s), write: false, outcome: 'ok',
    })
    this.emit('rating:changed', { mentionId, score: s })
    if (s <= 2) {
      const threadText = buildThreadText(m)
      void this.critiqueInBackground('analysis', threadText, JSON.stringify(m.analysis ?? {}), s)
    }
  }

  /** 학습한 교훈 전체(key → 교훈들) — 설정 화면용. */
  listLessons(): Record<string, Lesson[]> {
    return this.deps.lessons.all()
  }

  /** 교훈 삭제(key 하나/전체, 또는 특정 인덱스). */
  clearLessons(key?: string, index?: number): void {
    this.deps.lessons.clear(key, index)
    this.emit('lessons:changed')
  }

  /** 교훈 직접 추가(내 피드백). */
  addLesson(key: string, text: string): void {
    this.deps.lessons.add(key, text, 'user')
    this.emit('lessons:changed')
  }

  /** 교훈 텍스트 수정(최신순 index). */
  editLesson(key: string, index: number, text: string): void {
    this.deps.lessons.edit(key, index, text)
    this.emit('lessons:changed')
  }

  /** 예전 멘션의 채널 라벨 재해석(DM/그룹/#채널). raw ID인 것만 갱신. 변경 수 반환. */
  async refreshMentionLabels(): Promise<number> {
    const client = this.replyClient()
    if (!client) return 0
    let changed = 0
    for (const m of this.deps.mentions.all()) {
      // 이미 정리된 라벨(#채널 / DM… / 그룹 DM)은 건너뛰고, raw 채널 ID만 재해석
      if (m.channelName && !/^[CDGW][A-Z0-9]{6,}$/.test(m.channelName)) continue
      try {
        const label = await resolveChannelName(client, m.channel)
        if (label && label !== m.channelName) {
          m.channelName = label
          this.deps.mentions.set(m.id, m)
          changed++
        }
      } catch {
        /* skip */
      }
    }
    return changed
  }

  /** 멘션의 스레드 대화를 (없으면) 즉석 조회해 캐시 — 예전에 저장돼 thread가 없는 멘션 대비 */
  async getThread(mentionId: string, refresh = false): Promise<ThreadMsg[]> {
    const m = this.deps.mentions.get(mentionId)
    const client = this.replyClient()
    if (!m || !client) return m?.thread ?? []
    if (!refresh && m.thread && m.thread.length) return m.thread
    const thread = await fetchThreadMessages(client, m.channel, m.threadTs, this.cfg().mySlackUserId, { limit: this.cfg().threadFetchLimit })
    m.thread = thread
    this.deps.mentions.set(mentionId, m)
    return thread
  }

  /** 개발 → PR: 선택한 레포들 각각 격리 worktree에서 자율 수정·커밋·푸시·Draft PR. */
  async runDev(mentionId: string, repoPaths: string[], extraContext: string): Promise<void> {
    const m = this.deps.mentions.get(mentionId)
    if (!m || !repoPaths.length) return
    const context = devContext(m)
    const title = devTitle(m)
    this.pet('chatting')
    const summaries: string[] = []
    try {
      for (const repoPath of repoPaths) {
        const repoName = repoPath.split('/').filter(Boolean).pop() || repoPath
        this.emit('action:stream', { mentionId, playbookId: 'dev', event: { type: 'progress', text: `\n\n════ ${repoName} ════\n` } })
        const res = await this.deps.semaphore.run(() =>
          runDev(
            { config: this.cfg(), keychain: this.deps.keychain },
            {
              repoPath,
              context,
              extraContext,
              idShort: mentionId.slice(0, 6),
              title,
              onEvent: (e) => this.emit('action:stream', { mentionId, playbookId: 'dev', event: e }),
            },
          ),
        )
        this.deps.audit.record({
          ts: Date.now(), requestId: m.id, channel: m.channel, kind: 'dev',
          text: `${repoName}:${res.branch}`, write: true, approved: true, outcome: res.error ? 'error' : 'ok',
        })
        summaries.push(res.error ? `❌ ${repoName}: ${res.error}` : `✅ ${repoName}: ${res.prUrl || res.branch}`)
      }
      this.emit('action:done', { mentionId, playbookId: 'dev', text: '개발 → PR 결과\n' + summaries.join('\n'), error: false })
    } catch (err) {
      logger.error('runDev 게이트웨이 실패', { err: String(err) })
      this.emit('action:done', { mentionId, playbookId: 'dev', text: '개발 실패: ' + String(err), error: true })
    } finally {
      this.pet('idle')
    }
  }

  /** 부착된 소스가 하나라도 있으면 true */
  hasSource(): boolean {
    return !!this.app || !!this.poller || !!this.followPoller || !!this.newsPoller
  }

  async refreshSlackNews(): Promise<void> {
    await this.newsPoller?.pollNow()
  }

  async start(): Promise<void> {
    if (this.app) {
      await this.app.start()
      logger.info('소켓(봇) 소스 시작')
    }
    if (this.poller) {
      this.poller.start()
    }
    if (this.followPoller) {
      this.followPoller.start()
    }
    if (this.newsPoller) {
      this.newsPoller.start()
    }
    if (!this.hasSource()) logger.warn('감지원 없음 — 봇/검색 소스가 부착되지 않았습니다')
  }

  async stop(): Promise<void> {
    if (this.poller) this.poller.stop()
    if (this.followPoller) this.followPoller.stop()
    if (this.newsPoller) this.newsPoller.stop()
    if (this.app) await this.app.stop()
  }
}
