import { execFile } from 'node:child_process'
import { existsSync, openSync, closeSync, readSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { promisify } from 'node:util'
import { logger } from '../observability/logger.js'

const execFileAsync = promisify(execFile)
const CF_ABSOLUTE_TIME_EPOCH_MS = 978_307_200_000

export type BuildTool = 'xcode' | 'android'
export type BuildResult = 'success' | 'failure'

export interface BuildCompletion {
  id: string
  tool: BuildTool
  title: string
  project?: string
  result: BuildResult
  finishedAt: number
  durationMs?: number
  durationText?: string
  warnings?: number
  errors?: number
}

export interface BuildCompletionConfig {
  enabled: boolean
  xcodeEnabled: boolean
  androidEnabled: boolean
}

interface XcodeLogRecord {
  uniqueIdentifier?: string
  title?: string
  signature?: string
  timeStartedRecording?: number
  timeStoppedRecording?: number
  'schemeIdentifier-containerName'?: string
  primaryObservable?: {
    highLevelStatus?: string
    totalNumberOfErrors?: number
    totalNumberOfWarnings?: number
  }
}

interface AndroidPendingBuild {
  title: string
  project?: string
  startedAt: number
}

interface AndroidLogState {
  offset: number
  remainder: string
  pending?: AndroidPendingBuild
}

export interface AndroidBuildParseState {
  pending?: AndroidPendingBuild
}

type ManifestReader = (path: string) => Promise<unknown>

function directories(path: string): string[] {
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(path, entry.name))
  } catch {
    return []
  }
}

function xcodeManifestPaths(homeDir: string): string[] {
  return directories(join(homeDir, 'Library', 'Developer', 'Xcode', 'DerivedData'))
    .map((dir) => join(dir, 'Logs', 'Build', 'LogStoreManifest.plist'))
    .filter(existsSync)
}

function androidIdeaLogPaths(homeDir: string): string[] {
  return [join(homeDir, 'Library', 'Logs', 'Google'), join(homeDir, 'Library', 'Logs', 'JetBrains')]
    .flatMap(directories)
    .filter((dir) => basename(dir).startsWith('AndroidStudio'))
    .map((dir) => join(dir, 'idea.log'))
    .filter(existsSync)
}

async function readXcodeManifest(path: string): Promise<unknown> {
  const { stdout } = await execFileAsync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', path], {
    timeout: 10_000,
    maxBuffer: 8 * 1024 * 1024,
  })
  return JSON.parse(stdout)
}

function compactXcodeTitle(value: string): string {
  return value.replace(/^Build\s+/i, '').replace(/^Testing project\s+/i, '').trim() || 'Xcode'
}

export function parseXcodeBuildManifest(value: unknown): BuildCompletion[] {
  if (!value || typeof value !== 'object') return []
  const logs = (value as { logs?: Record<string, XcodeLogRecord> }).logs
  if (!logs || typeof logs !== 'object') return []
  return Object.entries(logs).flatMap(([key, record]): BuildCompletion[] => {
    const stopped = Number(record.timeStoppedRecording)
    if (!Number.isFinite(stopped) || stopped <= 0) return []
    const started = Number(record.timeStartedRecording)
    const observable = record.primaryObservable ?? {}
    const errors = Number(observable.totalNumberOfErrors) || 0
    const warnings = Number(observable.totalNumberOfWarnings) || 0
    const status = observable.highLevelStatus || ''
    const result: BuildResult = status === 'E' || errors > 0 ? 'failure' : 'success'
    return [{
      id: `xcode:${record.uniqueIdentifier || key}`,
      tool: 'xcode',
      title: compactXcodeTitle(record.title || record.signature || 'Xcode'),
      project: record['schemeIdentifier-containerName']?.replace(/\s+project$/i, ''),
      result,
      finishedAt: CF_ABSOLUTE_TIME_EPOCH_MS + stopped * 1000,
      ...(Number.isFinite(started) && started > 0 ? { durationMs: Math.max(0, (stopped - started) * 1000) } : {}),
      warnings,
      errors,
    }]
  })
}

function lineTime(line: string): number {
  const match = line.match(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}),(\d{3})/)
  if (!match) return Date.now()
  return new Date(`${match[1]}T${match[2]}.${match[3]}`).getTime()
}

function androidTaskTitle(raw: string): string {
  const tasks = raw.split(',').map((task) => task.trim()).filter(Boolean)
  return tasks.slice(0, 2).join(', ') || 'Gradle'
}

export function parseAndroidBuildLog(
  text: string,
  state: AndroidBuildParseState = {},
  source = 'AndroidStudio',
): { events: BuildCompletion[]; state: AndroidBuildParseState } {
  let pending = state.pending
  const events: BuildCompletion[] = []
  for (const line of text.split(/\r?\n/)) {
    const start = line.match(/GradleBuildInvoker - About to execute Gradle tasks: \[(.*)]/)
    if (start) {
      pending = { title: androidTaskTitle(start[1]), startedAt: lineTime(line) }
      continue
    }
    if (pending) {
      const project = line.match(/-Pandroid\.injected\.attribution\.file\.location=(.+?)\/\.gradle(?:\s|$)/)
      if (project) pending.project = project[1]
    }
    const end = line.match(/GradleBuildInvoker - Gradle build (finished|failed) in (.+)$/)
    if (!end) continue
    const finishedAt = lineTime(line)
    const title = pending?.title || 'Gradle'
    const result: BuildResult = end[1] === 'failed' ? 'failure' : 'success'
    events.push({
      id: `android:${source}:${finishedAt}:${result}:${title}`,
      tool: 'android',
      title,
      project: pending?.project,
      result,
      finishedAt,
      durationText: end[2].trim(),
      ...(pending ? { durationMs: Math.max(0, finishedAt - pending.startedAt) } : {}),
    })
    pending = undefined
  }
  return { events, state: { pending } }
}

export function buildCompletionLine(event: BuildCompletion): string {
  if (event.result === 'failure') {
    return event.tool === 'xcode'
      ? `${event.title} 빌드 실패했어요. Xcode 확인하러 가야 할 듯 👀`
      : `${event.title} 빌드 실패했어요. Android Studio 한번 봐줘요 👀`
  }
  return event.tool === 'xcode'
    ? `${event.title} 빌드 끝! Xcode 확인하러 가자 👀`
    : `${event.title} 빌드 끝! Android Studio 확인하러 가자 👀`
}

export class BuildCompletionPoller {
  private timer: ReturnType<typeof setInterval> | null = null
  private polling = false
  private xcodeInitialized = false
  private androidInitialized = false
  private xcodeBaselineAt = 0
  private androidBaselineAt = 0
  private readonly xcodeMtimes = new Map<string, number>()
  private readonly androidLogs = new Map<string, AndroidLogState>()

  constructor(
    private readonly config: () => BuildCompletionConfig,
    private readonly onCompletion: (event: BuildCompletion) => void | Promise<void>,
    private readonly options: {
      homeDir?: string
      intervalMs?: number
      manifestReader?: ManifestReader
    } = {},
  ) {}

  start(): void {
    if (this.timer) return
    void this.pollNow()
    this.timer = setInterval(() => void this.pollNow(), this.options.intervalMs ?? 3_000)
    logger.info('IDE 빌드 완료 감지 시작', { intervalMs: this.options.intervalMs ?? 3_000 })
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  async pollNow(): Promise<void> {
    if (this.polling) return
    const config = this.config()
    if (!config.enabled) {
      this.resetXcode()
      this.resetAndroid()
      return
    }
    this.polling = true
    try {
      const events: BuildCompletion[] = []
      if (config.xcodeEnabled) events.push(...await this.scanXcode())
      else this.resetXcode()
      if (config.androidEnabled) events.push(...this.scanAndroid())
      else this.resetAndroid()
      for (const event of events.sort((a, b) => a.finishedAt - b.finishedAt)) await this.onCompletion(event)
    } catch (error) {
      logger.warn('IDE 빌드 완료 감지 실패', { err: error instanceof Error ? error.message : String(error) })
    } finally {
      this.polling = false
    }
  }

  private async scanXcode(): Promise<BuildCompletion[]> {
    const paths = xcodeManifestPaths(this.options.homeDir ?? homedir())
    if (!this.xcodeInitialized) {
      for (const path of paths) this.xcodeMtimes.set(path, statSync(path).mtimeMs)
      this.xcodeBaselineAt = Date.now()
      this.xcodeInitialized = true
      return []
    }
    const events: BuildCompletion[] = []
    for (const path of paths) {
      const mtime = statSync(path).mtimeMs
      const previous = this.xcodeMtimes.get(path)
      this.xcodeMtimes.set(path, mtime)
      if (previous !== undefined && mtime <= previous) continue
      const manifest = await (this.options.manifestReader ?? readXcodeManifest)(path)
      events.push(...parseXcodeBuildManifest(manifest).filter((event) => event.finishedAt >= this.xcodeBaselineAt))
    }
    return events
  }

  private scanAndroid(): BuildCompletion[] {
    const paths = androidIdeaLogPaths(this.options.homeDir ?? homedir())
    if (!this.androidInitialized) {
      for (const path of paths) this.androidLogs.set(path, { offset: statSync(path).size, remainder: '' })
      this.androidBaselineAt = Date.now()
      this.androidInitialized = true
      return []
    }
    const events: BuildCompletion[] = []
    for (const path of paths) {
      const size = statSync(path).size
      let state = this.androidLogs.get(path)
      if (!state) state = { offset: 0, remainder: '' }
      if (size < state.offset) state = { offset: 0, remainder: '' }
      if (size === state.offset) {
        this.androidLogs.set(path, state)
        continue
      }
      const length = size - state.offset
      const buffer = Buffer.alloc(length)
      const fd = openSync(path, 'r')
      try {
        readSync(fd, buffer, 0, length, state.offset)
      } finally {
        closeSync(fd)
      }
      const combined = state.remainder + buffer.toString('utf8')
      const lastNewline = combined.lastIndexOf('\n')
      const complete = lastNewline >= 0 ? combined.slice(0, lastNewline + 1) : ''
      const remainder = lastNewline >= 0 ? combined.slice(lastNewline + 1) : combined
      const parsed = parseAndroidBuildLog(complete, { pending: state.pending }, basename(join(path, '..')))
      events.push(...parsed.events.filter((event) => event.finishedAt >= this.androidBaselineAt))
      this.androidLogs.set(path, { offset: size, remainder, pending: parsed.state.pending })
    }
    return events
  }

  private resetXcode(): void {
    this.xcodeInitialized = false
    this.xcodeBaselineAt = 0
    this.xcodeMtimes.clear()
  }

  private resetAndroid(): void {
    this.androidInitialized = false
    this.androidBaselineAt = 0
    this.androidLogs.clear()
  }
}
