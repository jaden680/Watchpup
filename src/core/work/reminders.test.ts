import { describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ReminderGateway, readGoalBarReminderPreference } from '../../../electron/reminders.js'

describe('ReminderGateway', () => {
  it('목록과 작업을 Work 모델로 변환한다', async () => {
    const outputs = [
      JSON.stringify([{ id: 'L1', name: 'iOS 업무', account: 'iCloud' }]),
      JSON.stringify([{ id: 'R1', name: '버그 수정', body: 'https://x.atlassian.net/browse/APP-1', completed: false, dueAt: '2026-07-20T00:00:00.000Z', listId: 'L1', listName: 'iOS 업무', account: 'iCloud' }]),
    ]
    const gateway = new ReminderGateway(async () => outputs.shift() || '[]')
    expect(await gateway.lists()).toHaveLength(1)
    const tasks = await gateway.tasks('L1')
    expect(tasks[0].links[0].kind).toBe('jira')
    expect(tasks[0].dueAt).toBe(Date.parse('2026-07-20T00:00:00.000Z'))
  })

  it('GoalBar의 기존 Reminder 선택을 읽는다', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'watchpup-goalbar-')), 'goals.json')
    writeFileSync(path, JSON.stringify({ settings: { reminderListIdentifier: 'L1', reminderListTitle: '업무', reminderListSourceTitle: 'iCloud' } }))
    expect(readGoalBarReminderPreference(path)).toEqual({ id: 'L1', name: '업무', account: 'iCloud' })
  })
})
