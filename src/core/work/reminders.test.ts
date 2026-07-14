import { describe, expect, it, vi } from 'vitest'
import { ReminderGateway } from '../../../electron/reminders.js'

describe('ReminderGateway', () => {
  it('목록과 작업을 Work 모델로 변환한다', async () => {
    const outputs = [
      JSON.stringify([{ id: 'L1', name: 'iOS 업무', account: 'iCloud', openCount: 10, totalCount: 20 }]),
      JSON.stringify([{ id: 'R1', name: '버그 수정', body: 'https://x.atlassian.net/browse/APP-1', completed: false, dueAt: '2026-07-20T00:00:00.000Z', listId: 'L1', listName: 'iOS 업무', account: 'iCloud' }]),
    ]
    const runner = vi.fn(async () => outputs.shift() || '[]')
    const gateway = new ReminderGateway(runner)
    expect(await gateway.lists()).toEqual([{ id: 'L1', name: 'iOS 업무', account: 'iCloud', openCount: 10, totalCount: 20 }])
    const tasks = await gateway.tasks('L1')
    expect(tasks[0].links[0].kind).toBe('jira')
    expect(tasks[0].dueAt).toBe(Date.parse('2026-07-20T00:00:00.000Z'))
    expect(runner).toHaveBeenNthCalledWith(1, 'lists', [])
    expect(runner).toHaveBeenNthCalledWith(2, 'tasks', ['L1', 'false'])
  })

  it('완료 변경과 링크 추가를 native helper 명령으로 전달한다', async () => {
    const runner = vi.fn(async () => '{"ok":true}')
    const gateway = new ReminderGateway(runner)
    await gateway.setCompleted('R1', true)
    await gateway.appendLink('R1', 'Jira', 'https://example.atlassian.net/browse/APP-1')
    expect(runner).toHaveBeenNthCalledWith(1, 'set-completed', ['R1', 'true'])
    expect(runner).toHaveBeenNthCalledWith(2, 'append-link', ['R1', 'Jira', 'https://example.atlassian.net/browse/APP-1'])
  })
})
