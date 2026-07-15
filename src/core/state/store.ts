/**
 * 로컬 상태 스토어 (휘발성 런타임): dedup/badge/thread매핑/창위치, JSON 영속.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { compareSlackTs } from '../slack/timestamp.js'
import type { AgentNaggingPending } from '../presentation/nagging.js'

export interface WindowBounds {
  x?: number
  y?: number
  width: number
  height: number
}

export interface WatchpupState {
  dedup: Record<string, number>
  badge: number
  windowPos?: { x: number; y: number }
  /** 창별(panel/detail) 마지막 크기·위치 기억 */
  windowBounds?: Record<string, WindowBounds>
  threadToMentionId: Record<string, string>
  /** threadKey(channel:threadTs) → 그 스레드에서 마지막으로 확인한 메시지 ts (후속 폴링 커서) */
  threadCursor: Record<string, string>
  /** Work 항목을 사용자가 마지막으로 열어본 시각. 잔소리 후보 우선순위에만 사용한다. */
  workTouchedAt?: Record<string, number>
  /** 잔소리 타이머와 이미 알린 우선순위 이벤트를 재실행 뒤에도 기억한다. */
  nagging?: {
    nextAt?: number
    lastTaskId?: string
    agent?: AgentNaggingPending
    calendarNotified?: Record<string, number>
  }
}

const EMPTY: WatchpupState = { dedup: {}, badge: 0, threadToMentionId: {}, threadCursor: {} }
const DEDUP_TTL_MS = 24 * 60 * 60 * 1000

export class StateStore {
  private state: WatchpupState
  constructor(private readonly path: string) {
    this.state = existsSync(path)
      ? { ...EMPTY, ...(JSON.parse(readFileSync(path, 'utf8')) as Partial<WatchpupState>) }
      : structuredClone(EMPTY)
    this.prune()
  }
  private prune(): void {
    const now = Date.now()
    for (const [k, ts] of Object.entries(this.state.dedup)) {
      if (now - ts >= DEDUP_TTL_MS) delete this.state.dedup[k]
    }
  }
  private persist(): void {
    mkdirSync(dirname(this.path), { recursive: true })
    writeFileSync(this.path, JSON.stringify(this.state), 'utf8')
  }
  get(): WatchpupState { return structuredClone(this.state) }
  seen(key: string): boolean { return key in this.state.dedup }
  markSeen(key: string): void { this.state.dedup[key] = Date.now(); this.persist() }
  setBadge(n: number): void { this.state.badge = n; this.persist() }
  linkThread(threadKey: string, mentionId: string): void {
    this.state.threadToMentionId[threadKey] = mentionId; this.persist()
  }
  mentionIdFor(threadKey: string): string | undefined { return this.state.threadToMentionId[threadKey] }
  /** 스레드 추적 해제 — 후속 폴링 대상(trackedThreads)에서 제외 */
  unlinkThread(threadKey: string): void {
    if (threadKey in this.state.threadToMentionId) {
      delete this.state.threadToMentionId[threadKey]
      this.persist()
    }
  }
  setWindowPos(p: { x: number; y: number }): void { this.state.windowPos = p; this.persist() }
  getWindowBounds(key: string): WindowBounds | undefined { return this.state.windowBounds?.[key] }
  setWindowBounds(key: string, b: WindowBounds): void {
    ;(this.state.windowBounds ??= {})[key] = b
    this.persist()
  }

  touchWorkItem(id: string, at = Date.now()): void {
    if (!id) return
    const touched = (this.state.workTouchedAt ??= {})
    touched[id] = at
    const cutoff = at - 30 * 24 * 60 * 60 * 1000
    for (const [key, value] of Object.entries(touched)) {
      if (!Number.isFinite(value) || value < cutoff) delete touched[key]
    }
    this.persist()
  }
  workTouchedAt(): Record<string, number> { return { ...(this.state.workTouchedAt ?? {}) } }
  setNagging(next: { nextAt?: number; lastTaskId?: string }): void {
    this.state.nagging = { ...(this.state.nagging ?? {}), ...next }
    this.persist()
  }
  setNaggingAgent(agent?: AgentNaggingPending): void {
    const nagging = (this.state.nagging ??= {})
    if (agent) nagging.agent = agent
    else delete nagging.agent
    this.persist()
  }
  naggingCalendarNotified(): Record<string, number> {
    return { ...(this.state.nagging?.calendarNotified ?? {}) }
  }
  markNaggingCalendar(key: string, at = Date.now()): void {
    const notified = ((this.state.nagging ??= {}).calendarNotified ??= {})
    notified[key] = at
    const cutoff = at - 24 * 60 * 60 * 1000
    for (const [eventKey, value] of Object.entries(notified)) {
      if (!Number.isFinite(value) || value < cutoff) delete notified[eventKey]
    }
    this.persist()
  }

  getThreadCursor(threadKey: string): string | undefined { return this.state.threadCursor[threadKey] }
  setThreadCursor(threadKey: string, ts: string): void {
    const current = this.state.threadCursor[threadKey]
    if (current && compareSlackTs(ts, current) <= 0) return
    this.state.threadCursor[threadKey] = ts
    this.persist()
  }

  /** 현재 추적 중인(멘션이 걸린) 스레드 목록 — threadKey(channel:threadTs)를 첫 ':' 기준으로 분해 */
  trackedThreads(): Array<{ channel: string; threadTs: string }> {
    return Object.keys(this.state.threadToMentionId).map((key) => {
      const idx = key.indexOf(':')
      return { channel: key.slice(0, idx), threadTs: key.slice(idx + 1) }
    })
  }
}
