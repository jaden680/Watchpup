/**
 * Work 자동 제안 폴러: 주기적으로 Work 목록을 확인해, 아직 제안이 없는 작업을
 * 목록 순서대로 하나 골라 에이전트 실행을 트리거한다. 주기당 1개씩 실행하며
 * 시간이 지나면 미완료 작업 전체가 순서대로 제안을 갖게 된다.
 *
 * 자동 제안 제외 조건:
 *  - 태스크별 설정에서 자동 제안 off (prefs.auto === false)
 *  - 이미 제안 기록이 있는 작업 (ready/failed 포함 — 재실행은 사용자가 직접)
 */
import type { WorkItem } from '../work/types.js'
import type { WorkProposal, WorkTaskPrefs } from './types.js'
import { logger } from '../observability/logger.js'

export interface WorkAgentPollerConfig {
  enabled: boolean
  listId: string
  intervalMinutes: number
  sortOrder: string
  manualOrder: string[]
}

export interface WorkAgentTarget {
  item: WorkItem
  subtasks: WorkItem[]
}

interface TargetStore {
  proposal(reminderId: string): WorkProposal | undefined
  prefs(reminderId: string): WorkTaskPrefs
}

function compareDueThenTitle(a: WorkItem, b: WorkItem): number {
  const dueA = Number.isFinite(a.dueAt) ? (a.dueAt as number) : null
  const dueB = Number.isFinite(b.dueAt) ? (b.dueAt as number) : null
  if (dueA != null && dueB != null && dueA !== dueB) return dueA - dueB
  if (dueA != null && dueB == null) return -1
  if (dueA == null && dueB != null) return 1
  return (a.title || '').localeCompare(b.title || '', 'ko', { sensitivity: 'base' })
}

/** Work 탭과 같은 기준으로 최상위(서브태스크 제외) 미완료 작업을 정렬한다. */
export function orderedTopLevelItems(items: WorkItem[], sortOrder: string, manualOrder: string[]): WorkItem[] {
  const topLevel = items.filter((item) => !item.completed && !item.parentId)
  if (sortOrder === 'manual') {
    const positions = new Map(manualOrder.map((id, index) => [id, index]))
    return [...topLevel].sort((a, b) => {
      const pa = positions.get(a.id)
      const pb = positions.get(b.id)
      if (pa != null && pb != null) return pa - pb
      if (pa != null) return -1
      if (pb != null) return 1
      return compareDueThenTitle(a, b)
    })
  }
  return [...topLevel].sort(compareDueThenTitle)
}

/** 목록 순서대로 자동 제안 대상 1건을 고른다 (전체 순회). 없으면 null. */
export function pickAutoTarget(
  items: WorkItem[],
  config: Pick<WorkAgentPollerConfig, 'sortOrder' | 'manualOrder'>,
  store: TargetStore,
): WorkAgentTarget | null {
  const candidates = orderedTopLevelItems(items, config.sortOrder, config.manualOrder)
  for (const item of candidates) {
    if (store.prefs(item.id).auto === false) continue
    if (store.proposal(item.id)) continue
    return { item, subtasks: items.filter((candidate) => candidate.parentId === item.id) }
  }
  return null
}

export class WorkAgentPoller {
  private timer: ReturnType<typeof setInterval> | null = null
  private running = false
  private lastRunAt = 0

  constructor(
    private readonly config: () => WorkAgentPollerConfig,
    private readonly deps: {
      fetchTasks: (listId: string) => Promise<WorkItem[]>
      store: TargetStore
      /** 대상 실행 (제안 저장·브로드캐스트는 호출측 책임). 실행 여부와 무관하게 항상 resolve. */
      run: (target: WorkAgentTarget) => Promise<void>
    },
    private readonly options: { tickMs?: number } = {},
  ) {}

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => void this.pollNow(), this.options.tickMs ?? 60_000)
    logger.info('Work 자동 제안 폴러 시작', { tickMs: this.options.tickMs ?? 60_000 })
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** force=true면 주기 게이트를 무시하고 즉시 후보를 찾는다 (설정 변경 직후 등). */
  async pollNow(force = false): Promise<void> {
    if (this.running) return
    const config = this.config()
    if (!config.enabled || !config.listId) return
    if (!force && Date.now() - this.lastRunAt < config.intervalMinutes * 60_000) return
    this.running = true
    try {
      const items = await this.deps.fetchTasks(config.listId)
      const target = pickAutoTarget(items, config, this.deps.store)
      if (!target) return
      this.lastRunAt = Date.now()
      await this.deps.run(target)
    } catch (error) {
      logger.warn('Work 자동 제안 폴링 실패', { err: error instanceof Error ? error.message : String(error) })
    } finally {
      this.running = false
    }
  }
}
