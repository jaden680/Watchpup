/**
 * Slack 컨텍스트 수집 (스레드 내용, permalink, 이름 해석).
 * 하나의 책임: 에이전트 프롬프트 시드용 최소 맥락 조회.
 */
import type { WebClient } from '@slack/web-api'
import type { ThreadMsg, ThreadReaction } from '../types.js'
import { logger } from '../observability/logger.js'

const nameCache = new Map<string, string>()

export async function resolveUserName(client: WebClient, userId: string): Promise<string> {
  const cached = nameCache.get(`u:${userId}`)
  if (cached) return cached
  try {
    const res = await client.users.info({ user: userId })
    const name = res.user?.real_name || res.user?.name || userId
    nameCache.set(`u:${userId}`, name)
    return name
  } catch {
    return userId
  }
}

/** 슬랙 mrkdwn을 사람이 읽는 평문으로: 링크/채널/그룹/특수멘션/HTML엔티티 정리 */
export function formatSlackPlain(text: string): string {
  if (!text) return ''
  return (
    text
      // <url|label> → label,  <url> → url
      .replace(/<(https?:\/\/[^|>]+)\|([^>]+)>/g, '$2')
      .replace(/<(https?:\/\/[^>]+)>/g, '$1')
      // <mailto:x|label> → label
      .replace(/<mailto:[^|>]+\|([^>]+)>/g, '$1')
      // <#C123|name> → #name,  <#C123> → #채널
      .replace(/<#[A-Z0-9]+\|([^>]+)>/g, '#$1')
      .replace(/<#[A-Z0-9]+>/g, '#채널')
      // <!subteam^G|@handle> → @handle
      .replace(/<!subteam\^[A-Z0-9]+(?:\|@?([^>]*))?>/g, (_m, h) => (h ? `@${h}` : '@그룹'))
      // <!here|label> / <!channel> / <!everyone> → @here 등
      .replace(/<!(here|channel|everyone)(?:\|[^>]*)?>/g, '@$1')
      // 남은 유저 멘션(이름 해석 실패) fallback
      .replace(/<@[A-Z0-9]+(?:\|([^>]*))?>/g, (_m, label) => (label ? `@${label}` : '@사용자'))
      // HTML 엔티티
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      // mrkdwn 서식 문자 제거(*볼드* ~취소선~ `코드`) — 표시용
      .replace(/\*([^*\n]+)\*/g, '$1')
      .replace(/~([^~\n]+)~/g, '$1')
      .replace(/`([^`\n]+)`/g, '$1')
  )
}

// <!subteam^GID> → @handle (usergroups:read 필요). 미해석 토큰은 그대로 둬 formatSlackPlain이 @그룹으로 폴백.
// 동시 호출이 같은 로드를 공유하도록 프로미스 캐시. 실패 시 프로미스를 비워 다음에 재시도(스코프 추가 후 복구).
let subteamPromise: Promise<Map<string, string>> | null = null
function loadSubteams(client: WebClient): Promise<Map<string, string>> {
  if (!subteamPromise) {
    subteamPromise = (async () => {
      try {
        const r = (await client.usergroups.list({})) as { usergroups?: Array<{ id?: string; handle?: string; name?: string }> }
        const m = new Map<string, string>()
        for (const g of r.usergroups ?? []) if (g.id) m.set(g.id, `@${g.handle || g.name || 'group'}`)
        return m
      } catch {
        subteamPromise = null // missing_scope 등 → 다음 호출에서 재시도
        return new Map<string, string>()
      }
    })()
  }
  return subteamPromise
}
export async function resolveSubteams(client: WebClient, text: string): Promise<string> {
  if (!text || !text.includes('<!subteam^')) return text
  const map = await loadSubteams(client)
  // 해석된 실제 핸들을 우선(인라인 핸들이 ID로 들어오는 경우 방지), 없으면 인라인 핸들, 그것도 없으면 토큰 유지.
  return text.replace(/<!subteam\^([A-Z0-9]+)(?:\|@?([^>]*))?>/g, (full, gid: string, handle: string) =>
    map.get(gid) || (handle ? `@${handle}` : full),
  )
}

const MENTION_RE = /<@([A-Z0-9]+)(?:\|[^>]*)?>/g

/** 메시지 본문 속 `<@Uxxx>` / `<@Uxxx|label>` 멘션 토큰을 `@실제이름`으로 치환 */
export async function resolveMentions(client: WebClient, text: string): Promise<string> {
  if (!text || !text.includes('<@')) return text
  const ids = new Set<string>()
  let mm: RegExpExecArray | null
  MENTION_RE.lastIndex = 0
  while ((mm = MENTION_RE.exec(text)) !== null) ids.add(mm[1])
  const names = new Map<string, string>()
  for (const id of ids) names.set(id, await resolveUserName(client, id))
  return text.replace(MENTION_RE, (_full, id: string) => `@${names.get(id) ?? id}`)
}

export async function resolveChannelName(client: WebClient, channelId: string): Promise<string> {
  const cached = nameCache.get(`c:${channelId}`)
  if (cached) return cached
  try {
    const res = (await client.conversations.info({ channel: channelId })) as {
      channel?: { name?: string; is_im?: boolean; is_mpim?: boolean; user?: string }
    }
    const ch = res.channel
    let label: string
    if (ch?.is_im) {
      // DM: 상대 이름으로 "DM · @name"
      const who = ch.user ? await resolveUserName(client, ch.user) : ''
      label = who ? `DM · ${who}` : 'DM'
    } else if (ch?.is_mpim) {
      label = '그룹 DM'
    } else if (ch?.name) {
      label = `#${ch.name}`
    } else {
      label = channelId
    }
    nameCache.set(`c:${channelId}`, label)
    return label
  } catch {
    // 조회 실패(스코프 등) — 최소한 ID 접두어로 종류 추정
    if (channelId.startsWith('D')) return 'DM'
    if (channelId.startsWith('G')) return '비공개'
    return channelId
  }
}

export async function getPermalink(
  client: WebClient,
  channel: string,
  messageTs: string,
): Promise<string | undefined> {
  try {
    const res = await client.chat.getPermalink({ channel, message_ts: messageTs })
    return res.permalink
  } catch {
    return undefined
  }
}

/** 스레드 메시지 필터링 (순수 함수). 델타 주입용 선택 로직 */
export interface ThreadMsgLite {
  ts?: string
  user?: string
  bot_id?: string
  text?: string
  reactions?: Array<{ name?: string; count?: number; users?: string[] }>
}

export function mapThreadReactions(
  reactions: ThreadMsgLite['reactions'],
  myUserId: string,
): ThreadReaction[] {
  return (reactions ?? [])
    .filter((reaction): reaction is { name: string; count?: number; users?: string[] } => !!reaction.name)
    .map((reaction) => ({
      name: reaction.name,
      count: Math.max(0, reaction.count ?? 0),
      reacted: !!myUserId && (reaction.users ?? []).includes(myUserId),
    }))
    .filter((reaction) => reaction.count > 0)
}
export interface SelectOpts {
  /** 이 ts 이후(초과) 메시지만 */
  afterTs?: string
  /** 이 ts 메시지 제외 (보통 현재 요청 메시지) */
  excludeTs?: string
  /** 봇 작성 메시지 제외 (이미 세션 transcript에 있음) */
  excludeBots?: boolean
}
export function selectThreadMessages(messages: ThreadMsgLite[], opts: SelectOpts = {}): ThreadMsgLite[] {
  const after = opts.afterTs ? parseFloat(opts.afterTs) : -Infinity
  return messages.filter((m) => {
    if (!m.text || !m.text.trim()) return false
    if (opts.excludeBots && m.bot_id) return false
    if (opts.excludeTs && m.ts === opts.excludeTs) return false
    if (m.ts && parseFloat(m.ts) <= after) return false
    return true
  })
}

/** 스레드를 "작성자/텍스트/내것여부" 구조로 (상세 뷰의 슬랙식 대화 표시용) */
export async function fetchThreadMessages(
  client: WebClient,
  channel: string,
  threadTs: string,
  myUserId: string,
  opts: { limit?: number } = {},
): Promise<ThreadMsg[]> {
  try {
    const raw = await fetchReplyMessages(client, channel, threadTs, { limit: opts.limit ?? 100 })
    const selected = selectThreadMessages(raw, {})
    const out: ThreadMsg[] = []
    for (const m of selected) {
      const author = m.user ? await resolveUserName(client, m.user) : m.bot_id ? 'bot' : '?'
      const text = formatSlackPlain(await resolveSubteams(client, await resolveMentions(client, m.text ?? '')))
      out.push({
        author,
        text: text.trim(),
        mine: m.user === myUserId,
        ts: m.ts,
        reactions: mapThreadReactions(m.reactions, myUserId),
      })
    }
    return out
  } catch (err) {
    logger.warn('스레드 구조 조회 실패', { channel, threadTs, err: String(err) })
    return []
  }
}

/** 긴 스레드에서 최신 우선 tail을 얻기 위한 페이지 상한 */
const MAX_PAGES = 15

/** 스레드 원시 메시지 조회. afterTs면 델타(최신 이후 단일 페이지), 아니면 최신 limit개(tail) */
async function fetchReplyMessages(
  client: WebClient,
  channel: string,
  threadTs: string,
  opts: { limit: number } & SelectOpts,
): Promise<ThreadMsgLite[]> {
  // 델타: 지난 턴 이후 메시지를 API에서 직접 (최신 방향)
  if (opts.afterTs) {
    const res = await client.conversations.replies({
      channel,
      ts: threadTs,
      limit: opts.limit,
      oldest: opts.afterTs,
      inclusive: false,
    })
    return res.messages ?? []
  }
  // 첫 턴: 오래된 순으로 페이지네이션 후 최신 limit개(직전 맥락)만 취함
  let cursor: string | undefined
  let acc: ThreadMsgLite[] = []
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await client.conversations.replies({ channel, ts: threadTs, limit: 200, cursor })
    acc.push(...(res.messages ?? []))
    cursor = (res.response_metadata as { next_cursor?: string } | undefined)?.next_cursor
    if (!cursor) break
  }
  return acc.slice(-opts.limit)
}

/** 스레드 내용을 "이름: 텍스트" 라인으로 포맷. 첫 턴=최신 tail, 델타=지난 턴 이후 */
export async function fetchThreadText(
  client: WebClient,
  channel: string,
  threadTs: string,
  opts: { limit?: number } & SelectOpts = {},
): Promise<string> {
  try {
    const raw = await fetchReplyMessages(client, channel, threadTs, { ...opts, limit: opts.limit ?? 100 })
    const selected = selectThreadMessages(raw, opts)
    const lines: string[] = []
    for (const m of selected) {
      const who = m.user ? await resolveUserName(client, m.user) : m.bot_id ? 'bot' : '?'
      const body = await resolveMentions(client, m.text ?? '')
      lines.push(`${who}: ${body.replace(/\s+/g, ' ').trim()}`)
    }
    return lines.join('\n')
  } catch (err) {
    logger.warn('스레드 조회 실패', { channel, threadTs, err: String(err) })
    return ''
  }
}
