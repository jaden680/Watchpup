import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { parseWorkLinks } from '../src/core/work/links.js'
import type { ReminderListRef, WorkItem } from '../src/core/work/types.js'

const execFileAsync = promisify(execFile)

export type ReminderCommand = 'lists' | 'tasks' | 'set-completed' | 'append-link'
export type ReminderCommandRunner = (command: ReminderCommand, args: string[]) => Promise<string>

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

function dateMs(value: unknown): number | undefined {
  if (typeof value !== 'string' || !value) return undefined
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

export class ReminderGateway {
  constructor(private readonly runCommand: ReminderCommandRunner = defaultRunner) {}

  async lists(): Promise<ReminderListRef[]> {
    const raw = await this.runCommand('lists', [])
    const rows = JSON.parse(raw || '[]') as ReminderListRef[]
    return rows.sort((a, b) => `${a.account}/${a.name}`.localeCompare(`${b.account}/${b.name}`))
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
          links: parseWorkLinks(notes),
        } satisfies WorkItem
      })
      .sort((a, b) => (a.completed === b.completed ? (a.dueAt ?? Number.MAX_SAFE_INTEGER) - (b.dueAt ?? Number.MAX_SAFE_INTEGER) : Number(a.completed) - Number(b.completed)))
  }

  async setCompleted(reminderId: string, completed: boolean): Promise<void> {
    await this.runCommand('set-completed', [reminderId, String(completed)])
  }

  async appendLink(reminderId: string, title: string, url: string): Promise<void> {
    const parsed = new URL(url)
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('http 또는 https 링크만 추가할 수 있습니다.')
    const safeTitle = title.trim().replace(/[\[\]]/g, '') || parsed.hostname
    await this.runCommand('append-link', [reminderId, safeTitle, parsed.toString()])
  }
}
