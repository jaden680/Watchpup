import { execFile } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { parseWorkLinks } from '../src/core/work/links.js'
import type { ReminderListRef, WorkItem } from '../src/core/work/types.js'
import type { NaggingCalendarEvent } from '../src/core/presentation/nagging.js'

const execFileAsync = promisify(execFile)

export type ReminderCommand = 'lists' | 'tasks' | 'create' | 'add-subtask' | 'update-title' | 'update-user-note' | 'set-completed' | 'append-link' | 'upcoming-events'
export type ReminderCommandRunner = (command: ReminderCommand, args: string[]) => Promise<string>
export type CalendarCommandRunner = (command: 'upcoming-events', args: string[]) => Promise<string>

function resolveHelperPath(): string {
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
  const candidates = [
    process.env.WATCHPUP_REMINDERS_HELPER,
    resourcesPath ? join(resourcesPath, 'watchpup-reminders') : '',
    join(process.cwd(), 'dist', 'native', 'watchpup-reminders'),
    typeof __dirname === 'string' ? join(__dirname, '..', 'native', 'watchpup-reminders') : '',
  ].filter((candidate): candidate is string => Boolean(candidate))
  const helper = candidates.find((candidate) => existsSync(candidate))
  if (!helper) throw new Error('Watchpup Reminders helper를 찾지 못했습니다. npm run build:app을 실행해주세요.')
  return helper
}

function resolveCalendarHelperAppPath(): string {
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
  const candidates = [
    process.env.WATCHPUP_CALENDAR_HELPER_APP,
    resourcesPath ? join(resourcesPath, 'Watchpup.app') : '',
    join(process.cwd(), 'dist', 'native', 'Watchpup.app'),
  ].filter((candidate): candidate is string => Boolean(candidate))
  const helper = candidates.find((candidate) => existsSync(candidate))
  if (!helper) throw new Error('Watchpup Calendar helper 앱을 찾지 못했습니다. npm run build:app을 실행해주세요.')
  return helper
}

const defaultRunner: ReminderCommandRunner = async (command, args) => {
  try {
    const { stdout } = await execFileAsync(resolveHelperPath(), [command, ...args], {
      timeout: 30_000,
      maxBuffer: 16 * 1024 * 1024,
    })
    return stdout.trim()
  } catch (error) {
    const stderr = typeof (error as { stderr?: unknown }).stderr === 'string'
      ? (error as { stderr: string }).stderr.trim()
      : ''
    throw new Error(stderr || (error instanceof Error ? error.message : '미리 알림 helper 실행에 실패했습니다.'))
  }
}

const defaultCalendarRunner: CalendarCommandRunner = async (command, args) => {
  const tempDir = mkdtempSync(join(tmpdir(), 'watchpup-calendar-'))
  const outputPath = join(tempDir, 'result.json')
  try {
    await execFileAsync('/usr/bin/open', [
      '-W', '-n', '-a', resolveCalendarHelperAppPath(),
      '--args', '--output', outputPath, command, ...args,
    ], { timeout: 45_000 })
    const result = JSON.parse(readFileSync(outputPath, 'utf8')) as { ok?: unknown; value?: unknown; error?: unknown }
    if (result.ok !== true) throw new Error(typeof result.error === 'string' ? result.error : '캘린더 helper 실행에 실패했습니다.')
    return JSON.stringify(result.value ?? [])
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : '캘린더 helper 실행에 실패했습니다.')
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
}

function dateMs(value: unknown): number | undefined {
  if (typeof value !== 'string' || !value) return undefined
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

export class ReminderGateway {
  constructor(
    private readonly runCommand: ReminderCommandRunner = defaultRunner,
    private readonly runCalendarCommand: CalendarCommandRunner = defaultCalendarRunner,
  ) {}

  async lists(): Promise<ReminderListRef[]> {
    const raw = await this.runCommand('lists', [])
    const rows = JSON.parse(raw || '[]') as ReminderListRef[]
    return rows.sort((a, b) => `${a.account}/${a.name}`.localeCompare(`${b.account}/${b.name}`))
  }

  async upcomingEvents(startAt: number, endAt: number): Promise<NaggingCalendarEvent[]> {
    const raw = await this.runCalendarCommand('upcoming-events', [String(startAt), String(endAt)])
    const rows = JSON.parse(raw || '[]') as Array<Record<string, unknown>>
    return rows
      .map((row) => ({
        id: String(row.id ?? ''),
        title: String(row.title ?? '일정'),
        startAt: dateMs(row.startAt) ?? 0,
        endAt: dateMs(row.endAt) ?? 0,
        calendarName: String(row.calendarName ?? ''),
        location: typeof row.location === 'string' && row.location ? row.location : undefined,
      }))
      .filter((event) => Boolean(event.id) && event.startAt > 0)
      .sort((a, b) => a.startAt - b.startAt)
  }

  async tasks(listId: string, includeCompleted = false): Promise<WorkItem[]> {
    const raw = await this.runCommand('tasks', [listId, String(includeCompleted)])
    const rows = JSON.parse(raw || '[]') as Array<Record<string, unknown>>
    return rows
      .filter((row) => includeCompleted || row.completed !== true)
      .map((row) => {
        const notes = typeof row.body === 'string' ? row.body : ''
        return {
          id: String(row.id ?? ''),
          title: String(row.name ?? ''),
          notes,
          listId: String(row.listId ?? listId),
          listName: String(row.listName ?? ''),
          account: String(row.account ?? ''),
          completed: row.completed === true,
          dueAt: dateMs(row.dueAt),
          createdAt: dateMs(row.createdAt),
          updatedAt: dateMs(row.updatedAt),
          parentId: typeof row.parentId === 'string' ? row.parentId : undefined,
          childIds: Array.isArray(row.childIds) ? row.childIds.filter((id): id is string => typeof id === 'string') : [],
          depth: typeof row.depth === 'number' ? row.depth : 0,
          links: parseWorkLinks(notes),
        } satisfies WorkItem
      })
      .sort((a, b) => (a.completed === b.completed ? (a.dueAt ?? Number.MAX_SAFE_INTEGER) - (b.dueAt ?? Number.MAX_SAFE_INTEGER) : Number(a.completed) - Number(b.completed)))
  }

  async setCompleted(reminderId: string, completed: boolean): Promise<void> {
    await this.runCommand('set-completed', [reminderId, String(completed)])
  }

  async create(listId: string, title: string, notes = ''): Promise<string> {
    const safeTitle = title.trim()
    if (!safeTitle) throw new Error('작업 제목을 입력해주세요.')
    const raw = await this.runCommand('create', [listId, safeTitle, notes.trim()])
    const result = JSON.parse(raw || '{}') as { id?: unknown }
    const id = typeof result.id === 'string' ? result.id : ''
    if (!id) throw new Error('생성된 Reminder ID를 확인하지 못했습니다.')
    return id
  }

  async updateTitle(reminderId: string, title: string): Promise<void> {
    const safeTitle = title.trim()
    if (!safeTitle) throw new Error('작업 제목을 입력해주세요.')
    await this.runCommand('update-title', [reminderId, safeTitle])
  }

  async addSubtask(parentReminderId: string, title: string): Promise<string> {
    const safeTitle = title.trim()
    if (!safeTitle) throw new Error('서브태스크 제목을 입력해주세요.')
    const raw = await this.runCommand('add-subtask', [parentReminderId, safeTitle])
    const result = JSON.parse(raw || '{}') as { id?: unknown }
    const id = typeof result.id === 'string' ? result.id : ''
    if (!id) throw new Error('생성된 서브태스크 ID를 확인하지 못했습니다.')
    return id
  }

  async updateUserNote(reminderId: string, note: string): Promise<void> {
    await this.runCommand('update-user-note', [reminderId, note.trim()])
  }

  async appendLink(reminderId: string, title: string, url: string): Promise<void> {
    const parsed = new URL(url)
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('http 또는 https 링크만 추가할 수 있습니다.')
    const safeTitle = title.trim().replace(/[\[\]]/g, '') || parsed.hostname
    await this.runCommand('append-link', [reminderId, safeTitle, parsed.toString()])
  }
}
