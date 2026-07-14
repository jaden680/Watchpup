import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { parseWorkLinks } from '../src/core/work/links.js'
import type { ReminderListRef, WorkItem } from '../src/core/work/types.js'

const execFileAsync = promisify(execFile)

export type ReminderScriptRunner = (script: string) => Promise<string>

const defaultRunner: ReminderScriptRunner = async (script) => {
  const { stdout } = await execFileAsync('osascript', ['-l', 'JavaScript', '-e', script], {
    timeout: 30_000,
    maxBuffer: 16 * 1024 * 1024,
  })
  return stdout.trim()
}

function js(value: string): string {
  return JSON.stringify(value)
}

function dateMs(value: unknown): number | undefined {
  if (typeof value !== 'string' || !value) return undefined
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

export interface GoalBarReminderPreference {
  id: string
  name: string
  account: string
}

export function readGoalBarReminderPreference(path = join(homedir(), 'Library', 'Application Support', 'GoalBar', 'goals.json')): GoalBarReminderPreference | null {
  try {
    const settings = JSON.parse(readFileSync(path, 'utf8'))?.settings ?? {}
    const id = typeof settings.reminderListIdentifier === 'string' ? settings.reminderListIdentifier : ''
    const name = typeof settings.reminderListTitle === 'string' ? settings.reminderListTitle : ''
    const account = typeof settings.reminderListSourceTitle === 'string' ? settings.reminderListSourceTitle : ''
    return id || name ? { id, name, account } : null
  } catch {
    return null
  }
}

export class ReminderGateway {
  constructor(private readonly runScript: ReminderScriptRunner = defaultRunner) {}

  async lists(): Promise<ReminderListRef[]> {
    const raw = await this.runScript(`
      const app = Application('Reminders');
      const rows = [];
      for (const account of app.accounts()) {
        for (const list of account.lists()) rows.push({ id: list.id(), name: list.name(), account: account.name() });
      }
      JSON.stringify(rows);
    `)
    const rows = JSON.parse(raw || '[]') as ReminderListRef[]
    return rows.sort((a, b) => `${a.account}/${a.name}`.localeCompare(`${b.account}/${b.name}`))
  }

  async tasks(listId: string, includeCompleted = false): Promise<WorkItem[]> {
    const raw = await this.runScript(`
      const app = Application('Reminders');
      const targetId = ${js(listId)};
      let target = null, accountName = '';
      for (const account of app.accounts()) for (const list of account.lists()) {
        if (list.id() === targetId) { target = list; accountName = account.name(); }
      }
      if (!target) throw new Error('선택한 Reminder 목록을 찾지 못했습니다.');
      const value = (read, fallback = null) => { try { const result = read(); return result == null ? fallback : result; } catch (_) { return fallback; } };
      const iso = (read) => { const d = value(read); return d && typeof d.toISOString === 'function' ? d.toISOString() : null; };
      const rows = target.reminders().map((reminder) => ({
        id: reminder.id(), name: value(() => reminder.name(), ''), body: value(() => reminder.body(), ''),
        completed: Boolean(value(() => reminder.completed(), false)),
        dueAt: iso(() => reminder.dueDate()), createdAt: iso(() => reminder.creationDate()), updatedAt: iso(() => reminder.modificationDate()),
        listId: targetId, listName: target.name(), account: accountName,
      }));
      JSON.stringify(rows);
    `)
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
}

