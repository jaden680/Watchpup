import { EventEmitter } from 'node:events'
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  statSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import type { ActivitySession } from '../types.js'
import {
  activityFromParsed,
  applyClaudeRecord,
  applyCodexRecord,
  compactText,
  newParsedSession,
  type ParsedSessionState,
} from './session-parser.js'

const POLL_MS = 1500
const INITIAL_HEAD_BYTES = 64 * 1024
const INITIAL_TAIL_BYTES = 512 * 1024
const HISTORY_TAIL_BYTES = 96 * 1024
const DISCOVERY_WINDOW_MS = 30 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000
const UUID_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i

export type ActivityHistoryRange = 'recent' | 'today' | '7d' | 'all'

export function activityHistoryCutoff(range: ActivityHistoryRange, now = Date.now()): number {
  if (range === 'all') return 0
  if (range === '7d') return now - 7 * DAY_MS
  if (range === 'today') {
    const start = new Date(now)
    start.setHours(0, 0, 0, 0)
    return start.getTime()
  }
  return now - DISCOVERY_WINDOW_MS
}

interface TrackedFile {
  path: string
  offset: number
  partial: string
  parsed: ParsedSessionState
  initialized: boolean
}

interface ClaudeRegistry {
  sessionId: string
  cwd?: string
  name?: string
}

interface HistoryCandidate {
  path: string
  source: 'codex' | 'claude'
  size: number
  mtimeMs: number
}

interface HistoryCacheEntry {
  size: number
  mtimeMs: number
  activity: ActivitySession | null
}

export interface LocalAgentPollerOptions {
  homeDir?: string
  intervalMs?: number
  now?: () => number
}

function safeStat(path: string): { size: number; mtimeMs: number } | null {
  try {
    const stat = statSync(path)
    return { size: stat.size, mtimeMs: stat.mtimeMs }
  } catch {
    return null
  }
}

function safeJson(path: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as unknown
    return value !== null && typeof value === 'object' ? value as Record<string, unknown> : null
  } catch {
    return null
  }
}

function uuidFromFile(path: string): string | null {
  return basename(path).match(UUID_RE)?.[1] ?? null
}

function localDateParts(now: number, daysAgo: number): [string, string, string] {
  const date = new Date(now)
  date.setDate(date.getDate() - daysAgo)
  return [String(date.getFullYear()), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')]
}

export class LocalAgentPoller extends EventEmitter {
  private readonly home: string
  private readonly intervalMs: number
  private readonly now: () => number
  private readonly tracked = new Map<string, TrackedFile>()
  private timer: ReturnType<typeof setInterval> | null = null
  private lastSignature = ''
  private codexTitles = new Map<string, string>()
  private lastIndexReadAt = 0
  private historyCache = new Map<string, HistoryCacheEntry>()

  constructor(options: LocalAgentPollerOptions = {}) {
    super()
    this.home = options.homeDir ?? homedir()
    this.intervalMs = options.intervalMs ?? POLL_MS
    this.now = options.now ?? (() => Date.now())
  }

  start(): void {
    if (this.timer) return
    this.scan()
    this.timer = setInterval(() => this.scan(), this.intervalMs)
  }

  stop(): void {
    if (!this.timer) return
    clearInterval(this.timer)
    this.timer = null
  }

  scan(): ActivitySession[] {
    const now = this.now()
    if (now - this.lastIndexReadAt > 10_000) this.readCodexTitles(now)

    const codexFiles = this.discoverCodexFiles(now)
    const claudeRegistries = this.readClaudeRegistries()
    const claudeFiles = this.discoverClaudeFiles(now, claudeRegistries)
    for (const path of codexFiles) this.pollFile(path, 'codex', now)
    for (const path of claudeFiles) this.pollFile(path, 'claude', now)

    const claudeNames = new Map(claudeRegistries.map((row) => [row.sessionId, row.name]))
    const activities = [...this.tracked.values()]
      .filter((entry) => !entry.parsed.headless)
      .map((entry) => activityFromParsed(
        entry.parsed,
        entry.parsed.source === 'codex'
          ? this.codexTitles.get(entry.parsed.sessionId)
          : claudeNames.get(entry.parsed.sessionId),
        now,
      ))
      .filter((activity) => now - activity.updatedAt <= DISCOVERY_WINDOW_MS || activity.state === 'running')
      .sort((a, b) => b.updatedAt - a.updatedAt)

    for (const [path, entry] of this.tracked) {
      if (now - entry.parsed.updatedAt > DISCOVERY_WINDOW_MS && entry.parsed.state !== 'running') this.tracked.delete(path)
    }

    const signature = JSON.stringify(activities)
    if (signature !== this.lastSignature) {
      this.lastSignature = signature
      this.emit('snapshot', activities)
    }
    return activities
  }

  async history(range: ActivityHistoryRange): Promise<ActivitySession[]> {
    if (range === 'recent') return this.scan()
    const now = this.now()
    this.readCodexTitles(now)
    const cutoff = activityHistoryCutoff(range, now)
    const claudeRegistries = this.readClaudeRegistries()
    const claudeNames = new Map(claudeRegistries.map((row) => [row.sessionId, row.name]))
    const candidates = [
      ...this.discoverCodexHistoryFiles(cutoff),
      ...this.discoverClaudeHistoryFiles(cutoff),
    ]
    const activities: ActivitySession[] = []

    for (const [index, candidate] of candidates.entries()) {
      if (index > 0 && index % 8 === 0) await new Promise<void>((resolve) => setImmediate(resolve))
      let cached = this.historyCache.get(candidate.path)
      if (!cached || cached.size !== candidate.size || cached.mtimeMs !== candidate.mtimeMs) {
        const sessionId = uuidFromFile(candidate.path)
        const title = sessionId
          ? candidate.source === 'codex'
            ? this.codexTitles.get(sessionId)
            : claudeNames.get(sessionId)
          : undefined
        cached = {
          size: candidate.size,
          mtimeMs: candidate.mtimeMs,
          activity: this.parseHistoryFile(candidate, title, now),
        }
        this.historyCache.set(candidate.path, cached)
      }
      if (cached.activity) activities.push(cached.activity)
    }

    return activities.sort((a, b) => b.updatedAt - a.updatedAt)
  }

  private discoverCodexFiles(now: number): string[] {
    const candidates: Array<{ path: string; mtimeMs: number }> = []
    for (let daysAgo = 0; daysAgo <= 1; daysAgo++) {
      const dir = join(this.home, '.codex', 'sessions', ...localDateParts(now, daysAgo))
      let names: string[] = []
      try { names = readdirSync(dir) } catch { continue }
      for (const name of names) {
        if (!name.startsWith('rollout-') || !name.endsWith('.jsonl')) continue
        const path = join(dir, name)
        const stat = safeStat(path)
        if (!stat || now - stat.mtimeMs > DISCOVERY_WINDOW_MS) continue
        candidates.push({ path, mtimeMs: stat.mtimeMs })
      }
    }
    return candidates.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, 16).map((row) => row.path)
  }

  private discoverCodexHistoryFiles(cutoff: number): HistoryCandidate[] {
    const root = join(this.home, '.codex', 'sessions')
    const candidates: HistoryCandidate[] = []
    let years: string[] = []
    try { years = readdirSync(root) } catch { return [] }
    for (const year of years) {
      const yearDir = join(root, year)
      let months: string[] = []
      try { months = readdirSync(yearDir) } catch { continue }
      for (const month of months) {
        const monthDir = join(yearDir, month)
        let days: string[] = []
        try { days = readdirSync(monthDir) } catch { continue }
        for (const day of days) {
          const dayDir = join(monthDir, day)
          let names: string[] = []
          try { names = readdirSync(dayDir) } catch { continue }
          for (const name of names) {
            if (!name.startsWith('rollout-') || !name.endsWith('.jsonl')) continue
            const path = join(dayDir, name)
            const stat = safeStat(path)
            if (!stat || stat.mtimeMs < cutoff) continue
            candidates.push({ path, source: 'codex', ...stat })
          }
        }
      }
    }
    return candidates
  }

  private readClaudeRegistries(): ClaudeRegistry[] {
    const dir = join(this.home, '.claude', 'sessions')
    let names: string[] = []
    try { names = readdirSync(dir) } catch { return [] }
    const rows: ClaudeRegistry[] = []
    for (const name of names) {
      if (!name.endsWith('.json')) continue
      const value = safeJson(join(dir, name))
      const sessionId = typeof value?.sessionId === 'string' ? value.sessionId : ''
      if (!sessionId) continue
      rows.push({
        sessionId,
        cwd: typeof value?.cwd === 'string' ? value.cwd : undefined,
        name: typeof value?.name === 'string' ? value.name : undefined,
      })
    }
    return rows
  }

  private discoverClaudeFiles(now: number, registries: ClaudeRegistry[]): string[] {
    const projectsDir = join(this.home, '.claude', 'projects')
    const paths = new Set<string>()
    for (const row of registries) {
      if (!row.cwd) continue
      const project = row.cwd.replaceAll('/', '-')
      const path = join(projectsDir, project, `${row.sessionId}.jsonl`)
      if (existsSync(path)) paths.add(path)
    }

    const recent: Array<{ path: string; mtimeMs: number }> = []
    let projects: string[] = []
    try { projects = readdirSync(projectsDir) } catch { return [...paths] }
    for (const project of projects) {
      const dir = join(projectsDir, project)
      let names: string[] = []
      try { names = readdirSync(dir) } catch { continue }
      for (const name of names) {
        if (!name.endsWith('.jsonl')) continue
        const path = join(dir, name)
        const stat = safeStat(path)
        if (!stat || now - stat.mtimeMs > DISCOVERY_WINDOW_MS) continue
        recent.push({ path, mtimeMs: stat.mtimeMs })
      }
    }
    for (const row of recent.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, 12)) paths.add(row.path)
    return [...paths]
  }

  private discoverClaudeHistoryFiles(cutoff: number): HistoryCandidate[] {
    const root = join(this.home, '.claude', 'projects')
    const candidates: HistoryCandidate[] = []
    let projects: string[] = []
    try { projects = readdirSync(root) } catch { return [] }
    for (const project of projects) {
      const dir = join(root, project)
      let names: string[] = []
      try { names = readdirSync(dir) } catch { continue }
      for (const name of names) {
        if (!name.endsWith('.jsonl')) continue
        const path = join(dir, name)
        const stat = safeStat(path)
        if (!stat || stat.mtimeMs < cutoff) continue
        candidates.push({ path, source: 'claude', ...stat })
      }
    }
    return candidates
  }

  private parseHistoryFile(
    candidate: HistoryCandidate,
    titleOverride: string | undefined,
    now: number,
  ): ActivitySession | null {
    const sessionId = uuidFromFile(candidate.path)
    if (!sessionId) return null
    let parsed = newParsedSession(candidate.source, sessionId, candidate.mtimeMs)
    const apply = (record: unknown): void => {
      parsed = candidate.source === 'codex'
        ? applyCodexRecord(parsed, record, now)
        : applyClaudeRecord(parsed, record, now)
    }

    const head = this.readRange(candidate.path, 0, Math.min(candidate.size, INITIAL_HEAD_BYTES))
    const firstLine = head?.split('\n', 1)[0]
    if (firstLine) {
      try { apply(JSON.parse(firstLine) as unknown) } catch { /* 손상된 메타는 tail에서 보완 */ }
    }
    if (parsed.headless) return null

    const start = Math.max(0, candidate.size - HISTORY_TAIL_BYTES)
    const tail = this.readRange(candidate.path, start, candidate.size - start)
    if (tail !== null) {
      const lines = tail.split('\n')
      if (start > 0) lines.shift()
      for (const line of lines) {
        if (!line.trim()) continue
        try { apply(JSON.parse(line) as unknown) } catch { /* 손상된 한 줄은 건너뜀 */ }
      }
    }
    if (parsed.headless) return null
    parsed.updatedAt = Math.max(parsed.updatedAt, candidate.mtimeMs)
    return activityFromParsed(parsed, titleOverride, now)
  }

  private readCodexTitles(now: number): void {
    this.lastIndexReadAt = now
    const path = join(this.home, '.codex', 'session_index.jsonl')
    const stat = safeStat(path)
    if (!stat || stat.size <= 0) return
    const start = Math.max(0, stat.size - INITIAL_TAIL_BYTES)
    const text = this.readRange(path, start, stat.size - start)
    if (text === null) return
    const lines = text.split('\n')
    if (start > 0) lines.shift()
    const titles = new Map<string, string>()
    for (const line of lines) {
      if (!line.trim()) continue
      try {
        const row = JSON.parse(line) as { id?: unknown; thread_name?: unknown }
        if (typeof row.id !== 'string') continue
        const title = compactText(row.thread_name)
        if (title) titles.set(row.id, title)
      } catch { /* 손상된 한 줄은 다음 폴링에서 건너뜀 */ }
    }
    this.codexTitles = titles
  }

  private pollFile(path: string, source: 'codex' | 'claude', now: number): void {
    const stat = safeStat(path)
    if (!stat) return
    let entry = this.tracked.get(path)
    if (!entry) {
      const sessionId = uuidFromFile(path)
      if (!sessionId) return
      entry = {
        path,
        offset: Math.max(0, stat.size - INITIAL_TAIL_BYTES),
        partial: '',
        parsed: newParsedSession(source, sessionId, stat.mtimeMs),
        initialized: false,
      }
      this.tracked.set(path, entry)
      if (entry.offset > 0) {
        const head = this.readRange(path, 0, Math.min(stat.size, INITIAL_HEAD_BYTES))
        const firstLine = head?.split('\n', 1)[0]
        if (firstLine) {
          try {
            const record = JSON.parse(firstLine) as unknown
            entry.parsed = source === 'codex'
              ? applyCodexRecord(entry.parsed, record, now)
              : applyClaudeRecord(entry.parsed, record, now)
          } catch { /* 세션 메타가 비정상이어도 최근 로그 폴링은 계속함 */ }
        }
      }
    }
    if (stat.size < entry.offset) {
      entry.offset = 0
      entry.partial = ''
      entry.parsed = newParsedSession(source, entry.parsed.sessionId, stat.mtimeMs)
      entry.initialized = false
    }
    if (stat.size <= entry.offset) return

    const start = entry.offset
    const initialRead = !entry.initialized
    const chunk = this.readRange(path, start, stat.size - start)
    if (chunk === null) return
    entry.offset = stat.size
    const combined = entry.partial + chunk
    const lines = combined.split('\n')
    entry.partial = lines.pop() || ''
    if (initialRead && start > 0 && lines.length) lines.shift()

    for (const line of lines) {
      if (!line.trim()) continue
      try {
        const record = JSON.parse(line) as unknown
        entry.parsed = source === 'codex'
          ? applyCodexRecord(entry.parsed, record, now)
          : applyClaudeRecord(entry.parsed, record, now)
      } catch { /* append 도중의 불완전한 JSON은 partial에서 다음 폴링에 이어 읽음 */ }
    }
    if (entry.partial.trim()) {
      try {
        const record = JSON.parse(entry.partial) as unknown
        entry.parsed = source === 'codex'
          ? applyCodexRecord(entry.parsed, record, now)
          : applyClaudeRecord(entry.parsed, record, now)
        entry.partial = ''
      } catch { /* 아직 쓰는 중인 마지막 줄이면 다음 폴링에서 이어 읽음 */ }
    }
    entry.initialized = true
    entry.parsed.updatedAt = Math.max(entry.parsed.updatedAt, stat.mtimeMs)
  }

  private readRange(path: string, start: number, length: number): string | null {
    let fd: number | undefined
    try {
      fd = openSync(path, 'r')
      const buffer = Buffer.alloc(length)
      readSync(fd, buffer, 0, length, start)
      return buffer.toString('utf8')
    } catch {
      return null
    } finally {
      if (fd !== undefined) {
        try { closeSync(fd) } catch { /* noop */ }
      }
    }
  }
}
