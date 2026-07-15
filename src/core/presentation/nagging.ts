import type { WorkItem } from '../work/types.js'
import type { ActivitySession } from '../types.js'

const MIN_INTERVAL_MINUTES = 1
const MAX_INTERVAL_MINUTES = 120
const RECENT_WORK_MS = 14 * 24 * 60 * 60 * 1000

export interface AgentNaggingPending {
  activityId: string
  title: string
  count: number
  completedAt: number
  dueAt: number
  repeatCount: number
  waiting: boolean
}

export interface NaggingCalendarEvent {
  id: string
  title: string
  startAt: number
  endAt: number
  calendarName: string
  location?: string
}

export interface SlackNewsNaggingItem {
  id: string
  channel: string
  channelName: string
  messageTs: string
  text: string
  permalink: string
  matchedBy: string
  postedAt: number
}

export type NaggingSource = 'github' | 'slack' | 'work' | 'general'

const TASK_LINES: ReadonlyArray<(title: string) => string> = [
  (title) => `“${title}” 아직 머릿속에 있죠?`,
  (title) => `잠깐! “${title}” 어디까지 했더라?`,
  (title) => `“${title}” 다시 이어갈 타이밍 아닌가요?`,
  (title) => `병렬 작업 체크! “${title}”도 아직 살아 있어요.`,
  (title) => `혹시 “${title}” 잊은 건 아니죠? 👀`,
]

export const GENERIC_NAGGING_LINES: readonly string[] = [
  '지금 벌여둔 작업 중 하나 잊은 건 없어요?',
  '하던 일 체크! 잠깐 멈춘 작업도 기억하고 있죠?',
  '작업 스택 한번 훑어볼까요? 👀',
  '새 일 전에 멈춰둔 일 하나만 떠올려봐요.',
]

const AGENT_DONE_LINES: ReadonlyArray<(pending: AgentNaggingPending) => string> = [
  (pending) => pending.count > 1
    ? `Agent 작업 ${pending.count}개 다 끝났는데 뭐해? 결과 확인해줘 👀`
    : `“${pending.title}” 끝났는데 아직 안 봤죠? 확인해줘 👀`,
  (pending) => pending.count > 1
    ? `Agent들이 일 다 끝내고 기다리는 중! ${pending.count}개 결과 슬슬 봐줘요.`
    : `Agent가 “${pending.title}” 끝내고 기다리는 중이에요.`,
  (pending) => pending.count > 1
    ? `병렬 작업 종료! ${pending.count}개 결과가 주인을 기다리고 있습니다.`
    : `완료된 “${pending.title}” 결과가 주인을 기다리고 있습니다.`,
]

const AGENT_WAITING_LINES: ReadonlyArray<(pending: AgentNaggingPending) => string> = [
  (pending) => pending.count > 1
    ? `Agent ${pending.count}개가 멈춰서 기다리는 중인데 뭐해? 한번 봐줘 👀`
    : `“${pending.title}” Agent가 기다리는 중이에요. 확인해줘!`,
  (pending) => `Agent 작업이 다음 반응을 기다리고 있어요. “${pending.title}”부터 볼까요?`,
]

function safeMinutes(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback
  return Math.max(MIN_INTERVAL_MINUTES, Math.min(MAX_INTERVAL_MINUTES, Math.round(value)))
}

export function nextNaggingDelayMs(
  minMinutes: number,
  maxMinutes: number,
  rand: () => number = Math.random,
): number {
  const min = safeMinutes(minMinutes, 5)
  const max = Math.max(min, safeMinutes(maxMinutes, 12))
  const ratio = Math.max(0, Math.min(0.999999, rand()))
  return Math.round((min + (max - min) * ratio) * 60_000)
}

export function pickNaggingWorkItem(
  items: WorkItem[],
  touchedAt: Record<string, number>,
  recentTaskIds: readonly string[] = [],
  now = Date.now(),
  rand: () => number = Math.random,
): WorkItem | null {
  const open = items.filter((item) => !item.completed && !item.parentId)
  if (!open.length) return null

  const cooldownSize = Math.min(3, Math.max(0, open.length - 1))
  const cooldown = new Set(recentTaskIds.slice(-cooldownSize))
  const available = open.filter((item) => !cooldown.has(item.id))
  const pool = available.length ? available : open
  const weighted = pool.flatMap((item) => {
    const touched = touchedAt[item.id]
    const isRecent = Number.isFinite(touched) && now - touched <= RECENT_WORK_MS
    return isRecent ? [item, item] : [item]
  })
  const index = Math.min(weighted.length - 1, Math.floor(Math.max(0, rand()) * weighted.length))
  return weighted[index] ?? null
}

export function chooseNaggingSource(
  hasWork: boolean,
  hasSlackNews: boolean,
  hasGithubPr: boolean,
  rand: () => number = Math.random,
): NaggingSource {
  const candidates: Array<{ source: NaggingSource; weight: number }> = [
    ...(hasGithubPr ? [{ source: 'github' as const, weight: 35 }] : []),
    ...(hasSlackNews ? [{ source: 'slack' as const, weight: 30 }] : []),
    ...(hasWork ? [{ source: 'work' as const, weight: 40 }] : []),
    { source: 'general', weight: 15 },
  ]
  const total = candidates.reduce((sum, candidate) => sum + candidate.weight, 0)
  let cursor = Math.max(0, Math.min(0.999999, rand())) * total
  for (const candidate of candidates) {
    cursor -= candidate.weight
    if (cursor < 0) return candidate.source
  }
  return 'general'
}

export function naggingLine(item: WorkItem | null, rand: () => number = Math.random): string {
  if (!item) {
    const index = Math.min(GENERIC_NAGGING_LINES.length - 1, Math.floor(Math.max(0, rand()) * GENERIC_NAGGING_LINES.length))
    return GENERIC_NAGGING_LINES[index]
  }
  const index = Math.min(TASK_LINES.length - 1, Math.floor(Math.max(0, rand()) * TASK_LINES.length))
  return TASK_LINES[index](item.title || '하던 작업')
}

export function agentNaggingPending(
  batchIds: Iterable<string>,
  activities: ActivitySession[],
  dueAt: number,
): AgentNaggingPending | null {
  const ids = new Set(batchIds)
  const finished = activities
    .filter((activity) => ids.has(activity.id) && activity.state !== 'running')
    .sort((a, b) => b.updatedAt - a.updatedAt)
  if (!finished.length) return null
  const representative = finished[0]
  return {
    activityId: representative.id,
    title: representative.title || 'Agent 작업',
    count: finished.length,
    completedAt: Math.max(...finished.map((activity) => activity.updatedAt)),
    dueAt,
    repeatCount: 0,
    waiting: finished.some((activity) => activity.state === 'waiting'),
  }
}

export function agentNaggingLine(pending: AgentNaggingPending, rand: () => number = Math.random): string {
  const lines = pending.waiting ? AGENT_WAITING_LINES : AGENT_DONE_LINES
  const index = Math.min(lines.length - 1, Math.floor(Math.max(0, rand()) * lines.length))
  return lines[index](pending)
}

export function calendarEventKey(event: NaggingCalendarEvent): string {
  return `${event.id}:${event.startAt}`
}

export function pickCalendarNaggingEvent(
  events: NaggingCalendarEvent[],
  notified: Record<string, number>,
  now = Date.now(),
  leadMs = 5 * 60_000,
): NaggingCalendarEvent | null {
  return events
    .filter((event) => {
      const untilStart = event.startAt - now
      return untilStart >= -60_000 && untilStart <= leadMs && !notified[calendarEventKey(event)]
    })
    .sort((a, b) => a.startAt - b.startAt)[0] ?? null
}

export function calendarNaggingLine(event: NaggingCalendarEvent, now = Date.now()): string {
  const minutes = Math.max(0, Math.ceil((event.startAt - now) / 60_000))
  const where = event.location ? ` · ${event.location}` : ''
  if (minutes <= 0) return `“${event.title}” 지금 시작해요! 이제 스케줄 가야 함~!${where}`
  return `${minutes}분 뒤 “${event.title}” 일정이에요. 이제 스케줄 갈 준비~!${where}`
}

export function pickSlackNewsNagging(
  items: SlackNewsNaggingItem[],
  rand: () => number = Math.random,
): SlackNewsNaggingItem | null {
  if (!items.length) return null
  const index = Math.min(items.length - 1, Math.floor(Math.max(0, rand()) * items.length))
  return items[index] ?? null
}

export function slackNewsNaggingLine(item: SlackNewsNaggingItem, maxLength = 82): string {
  const text = item.text.replace(/\s+/g, ' ').trim()
  const snippet = text.length > maxLength ? `${text.slice(0, Math.max(1, maxLength - 1)).trimEnd()}…` : text
  const channel = item.channelName.replace(/^#/, '') || item.channel
  return `#${channel} 새 소식! ${snippet || '새 글이 올라왔어요.'} · 보러갈래?`
}
