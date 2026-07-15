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
    expect(tasks[0]).toMatchObject({ childIds: [], depth: 0 })
    expect(runner).toHaveBeenNthCalledWith(1, 'lists', [])
    expect(runner).toHaveBeenNthCalledWith(2, 'tasks', ['L1', 'false'])
  })

  it('작업 생성, 편집, 완료 변경과 링크 추가를 native helper 명령으로 전달한다', async () => {
    const runner = vi.fn(async (command) => ['create', 'add-subtask'].includes(command) ? '{"ok":true,"id":"R2"}' : '{"ok":true}')
    const gateway = new ReminderGateway(runner)
    await expect(gateway.create('L1', ' 새 작업 ', ' 메모 ')).resolves.toBe('R2')
    await expect(gateway.addSubtask('R1', ' 하위 작업 ')).resolves.toBe('R2')
    await gateway.updateTitle('R2', ' 변경 제목 ')
    await gateway.updateUserNote('R2', ' 사용자 메모 ')
    await gateway.setCompleted('R1', true)
    await gateway.appendLink('R1', 'Jira', 'https://example.atlassian.net/browse/APP-1')
    expect(runner).toHaveBeenNthCalledWith(1, 'create', ['L1', '새 작업', '메모'])
    expect(runner).toHaveBeenNthCalledWith(2, 'add-subtask', ['R1', '하위 작업'])
    expect(runner).toHaveBeenNthCalledWith(3, 'update-title', ['R2', '변경 제목'])
    expect(runner).toHaveBeenNthCalledWith(4, 'update-user-note', ['R2', '사용자 메모'])
    expect(runner).toHaveBeenNthCalledWith(5, 'set-completed', ['R1', 'true'])
    expect(runner).toHaveBeenNthCalledWith(6, 'append-link', ['R1', 'Jira', 'https://example.atlassian.net/browse/APP-1'])
  })

  it('캘린더 helper 결과를 시작 시각 순으로 변환한다', async () => {
    const runner = vi.fn(async () => JSON.stringify([
      { id: 'E2', title: '두 번째', startAt: '2026-07-15T03:10:00.000Z', endAt: '2026-07-15T03:40:00.000Z', calendarName: 'Work' },
      { id: 'E1', title: '첫 번째', startAt: '2026-07-15T03:05:00.000Z', endAt: '2026-07-15T03:35:00.000Z', calendarName: 'Work', location: 'Zoom' },
    ]))
    const gateway = new ReminderGateway(runner, runner)
    const events = await gateway.upcomingEvents(1000, 2000)
    expect(events.map((event) => event.id)).toEqual(['E1', 'E2'])
    expect(events[0]).toMatchObject({ title: '첫 번째', location: 'Zoom', startAt: Date.parse('2026-07-15T03:05:00.000Z') })
    expect(runner).toHaveBeenCalledWith('upcoming-events', ['1000', '2000'])
  })

  it('빈 제목의 작업은 생성하지 않는다', async () => {
    const runner = vi.fn()
    const gateway = new ReminderGateway(runner)
    await expect(gateway.create('L1', '   ')).rejects.toThrow('작업 제목')
    expect(runner).not.toHaveBeenCalled()
  })
})
