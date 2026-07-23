import { describe, expect, it, vi } from 'vitest'
import { WorkAgentPoller, orderedTopLevelItems, pickAutoTarget } from './poller.js'
import type { WorkProposal, WorkTaskPrefs } from './types.js'
import type { WorkItem } from '../work/types.js'

function item(overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    id: 'r-1',
    title: '작업',
    notes: '',
    listId: 'list',
    listName: 'iOS 업무',
    account: 'iCloud',
    completed: false,
    childIds: [],
    depth: 0,
    links: [],
    ...overrides,
  }
}

function storeWith(input: {
  proposals?: Record<string, WorkProposal>
  prefs?: Record<string, WorkTaskPrefs>
  resolveRepo?: (target: WorkItem) => string | null
} = {}) {
  return {
    proposal: (id: string) => input.proposals?.[id],
    prefs: (id: string) => input.prefs?.[id] ?? {},
    resolveRepo: input.resolveRepo ?? (() => '/repo'),
  }
}

describe('orderedTopLevelItems', () => {
  it('완료·서브태스크를 제외하고 마감일순으로 정렬한다', () => {
    const items = [
      item({ id: 'no-due', title: '나중' }),
      item({ id: 'done', completed: true, dueAt: 1 }),
      item({ id: 'child', parentId: 'no-due', dueAt: 1 }),
      item({ id: 'due-late', dueAt: 2000 }),
      item({ id: 'due-soon', dueAt: 1000 }),
    ]
    expect(orderedTopLevelItems(items, 'dueDateThenTitle', []).map((entry) => entry.id))
      .toEqual(['due-soon', 'due-late', 'no-due'])
  })

  it('수동 정렬이면 manualOrder를 따른다', () => {
    const items = [item({ id: 'a' }), item({ id: 'b' }), item({ id: 'c' })]
    expect(orderedTopLevelItems(items, 'manual', ['c', 'a']).map((entry) => entry.id))
      .toEqual(['c', 'a', 'b'])
  })
})

describe('pickAutoTarget', () => {
  const config = { sortOrder: 'dueDateThenTitle', manualOrder: [] as string[] }

  it('목록 순서에서 제안 없고 자동이 켜진 첫 작업을 고른다', () => {
    const items = [
      item({ id: 'first', dueAt: 1 }),
      item({ id: 'second', dueAt: 2 }),
      item({ id: 'sub', parentId: 'second', dueAt: 3 }),
    ]
    const target = pickAutoTarget(items, config, storeWith())
    expect(target?.item.id).toBe('first')
  })

  it('이미 제안이 있으면 건너뛴다 (실패 제안 포함 — 재실행은 수동)', () => {
    const items = [item({ id: 'first', dueAt: 1 }), item({ id: 'second', dueAt: 2 })]
    const proposals = {
      first: { reminderId: 'first', status: 'failed' } as WorkProposal,
    }
    expect(pickAutoTarget(items, config, storeWith({ proposals }))?.item.id).toBe('second')
  })

  it('태스크별 자동 제안 off면 건너뛴다', () => {
    const items = [item({ id: 'first', dueAt: 1 }), item({ id: 'second', dueAt: 2 })]
    const prefs = { first: { auto: false } }
    expect(pickAutoTarget(items, config, storeWith({ prefs }))?.item.id).toBe('second')
  })

  it('앞 작업들에 제안이 차 있으면 다음 작업으로 넘어간다 (전체 순회)', () => {
    const items = [1, 2, 3, 4].map((n) => item({ id: `t${n}`, dueAt: n }))
    const proposals = Object.fromEntries(
      ['t1', 't2', 't3'].map((id) => [id, { reminderId: id, status: 'ready' } as WorkProposal]),
    )
    expect(pickAutoTarget(items, config, storeWith({ proposals }))?.item.id).toBe('t4')
    const allDone = Object.fromEntries(
      ['t1', 't2', 't3', 't4'].map((id) => [id, { reminderId: id, status: 'ready' } as WorkProposal]),
    )
    expect(pickAutoTarget(items, config, storeWith({ proposals: allDone }))).toBeNull()
  })

  it('레포가 정해지지 않은 작업은 건너뛴다', () => {
    const items = [item({ id: 'no-repo', dueAt: 1 }), item({ id: 'with-repo', dueAt: 2 })]
    const store = storeWith({ resolveRepo: (target) => (target.id === 'with-repo' ? '/repo' : null) })
    expect(pickAutoTarget(items, config, store)?.item.id).toBe('with-repo')
    expect(pickAutoTarget([items[0]], config, store)).toBeNull()
  })

  it('선택된 작업의 서브태스크를 함께 돌려준다', () => {
    const items = [item({ id: 'first', dueAt: 1 }), item({ id: 'sub', parentId: 'first' })]
    const target = pickAutoTarget(items, config, storeWith())
    expect(target?.subtasks.map((entry) => entry.id)).toEqual(['sub'])
  })
})

describe('WorkAgentPoller', () => {
  const baseConfig = {
    enabled: true,
    listId: 'list',
    intervalMinutes: 30,
    sortOrder: 'dueDateThenTitle',
    manualOrder: [] as string[],
  }

  it('꺼져 있거나 목록이 없으면 조회하지 않는다', async () => {
    const fetchTasks = vi.fn()
    const run = vi.fn()
    const disabled = new WorkAgentPoller(() => ({ ...baseConfig, enabled: false }), { fetchTasks, store: storeWith(), run })
    await disabled.pollNow(true)
    const noList = new WorkAgentPoller(() => ({ ...baseConfig, listId: '' }), { fetchTasks, store: storeWith(), run })
    await noList.pollNow(true)
    expect(fetchTasks).not.toHaveBeenCalled()
    expect(run).not.toHaveBeenCalled()
  })

  it('대상이 있으면 실행하고, 주기 안에는 다시 실행하지 않는다', async () => {
    const fetchTasks = vi.fn().mockResolvedValue([item({ id: 'first' })])
    const run = vi.fn().mockResolvedValue(undefined)
    const poller = new WorkAgentPoller(() => baseConfig, { fetchTasks, store: storeWith(), run })
    await poller.pollNow()
    expect(run).toHaveBeenCalledTimes(1)
    await poller.pollNow()
    expect(run).toHaveBeenCalledTimes(1) // interval gate
    await poller.pollNow(true)
    expect(run).toHaveBeenCalledTimes(2) // force는 게이트 무시
  })

  it('start 직후에는 주기가 지나기 전까지 돌지 않는다', async () => {
    const fetchTasks = vi.fn().mockResolvedValue([item({ id: 'first' })])
    const run = vi.fn().mockResolvedValue(undefined)
    const poller = new WorkAgentPoller(() => baseConfig, { fetchTasks, store: storeWith(), run }, { tickMs: 3_600_000 })
    poller.start()
    await poller.pollNow()
    expect(run).not.toHaveBeenCalled() // 시작 시점 기준 30분이 안 지났으므로 대기
    await poller.pollNow(true)
    expect(run).toHaveBeenCalledTimes(1) // 강제(설정에서 켠 직후)는 즉시
    poller.stop()
  })

  it('run이 던져도 폴러는 죽지 않는다', async () => {
    const fetchTasks = vi.fn().mockResolvedValue([item({ id: 'first' })])
    const run = vi.fn().mockRejectedValue(new Error('busy'))
    const poller = new WorkAgentPoller(() => baseConfig, { fetchTasks, store: storeWith(), run })
    await expect(poller.pollNow(true)).resolves.toBeUndefined()
  })
})
