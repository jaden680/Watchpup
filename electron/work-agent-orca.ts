/**
 * Work 자동 제안의 Orca 실행 모드: 제안 작업을 headless claude -p 대신
 * Orca 워크트리 터미널에서 눈에 보이게 실행한다 (claude 전용).
 *
 * 흐름: worktree 생성 → 과제 파일 작성 → orca terminal create(claude)
 * → 과제 지시 send → 계획 파일(WATCHPUP-PLAN.md)이 생길 때까지 폴링 → 제안 반환.
 * 커밋은 하지 않는다. Orca가 없거나 스폰에 실패하면 null을 돌려줘 headless로 폴백한다.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { writeFileSync, existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { WatchpupConfig } from '../src/core/config/schema.js'
import type { WorkItem } from '../src/core/work/types.js'
import type { WorkProposal } from '../src/core/workagent/types.js'
import { createProposalWorktree, type ProposalWorktree } from '../src/core/workagent/run.js'
import { workAgentSystemPrompt, workAgentPrompt, planSummary, PLAN_FILE } from '../src/core/workagent/prompt.js'
import { logger } from '../src/core/observability/logger.js'

const pexec = promisify(execFile)
const ORCA_RUN_TIMEOUT_MS = 30 * 60_000
const POLL_MS = 15_000

async function orca(args: string[], timeoutMs = 15_000): Promise<string> {
  const { stdout } = await pexec('orca', args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 })
  return stdout.trim()
}

export async function orcaRunning(): Promise<boolean> {
  try {
    await orca(['status', '--json'], 4_000)
    return true
  } catch {
    return false
  }
}

/** orca --json 응답에서 터미널 핸들을 찾는다 (버전별 응답 구조 차이에 관대하게). */
export function parseOrcaTerminalHandle(raw: string): string | null {
  try {
    const walk = (value: unknown): string | null => {
      if (!value || typeof value !== 'object') return null
      const record = value as Record<string, unknown>
      if (typeof record.handle === 'string' && record.handle) return record.handle
      for (const child of Object.values(record)) {
        const found = walk(child)
        if (found) return found
      }
      return null
    }
    return walk(JSON.parse(raw))
  } catch {
    return null
  }
}

function claudeCommand(config: WatchpupConfig, model?: string): string {
  const effective = model?.trim() || config.model
  const modelFlag = effective && effective !== 'default' ? ` --model ${effective}` : ''
  return `claude --dangerously-skip-permissions${modelFlag}`
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms))
}

export interface OrcaProposalInput {
  item: WorkItem
  subtasks: WorkItem[]
  parent?: WorkItem | null
  repoPath: string
  model?: string
  worktreeRoot: string
  source: 'auto' | 'manual'
  /** 실행 중 확보되는 정보(worktree·터미널 핸들)를 즉시 저장 — 재시작 복구용 */
  onUpdate?: (patch: Partial<WorkProposal>) => void
}

/**
 * Orca 터미널에서 제안 실행. Orca 미가용/스폰 실패면 null (headless 폴백).
 * 스폰 이후의 실패는 failed 제안으로 반환한다.
 */
export async function runWorkProposalInOrca(
  deps: { config: WatchpupConfig },
  input: OrcaProposalInput,
): Promise<WorkProposal | null> {
  if (!(await orcaRunning())) return null

  let created: ProposalWorktree
  try {
    created = await createProposalWorktree(input.repoPath, input.worktreeRoot, input.item.id, input.item.title)
  } catch (e) {
    logger.warn('Orca 제안 worktree 생성 실패 — headless 폴백', { err: String(e) })
    return null
  }
  const wt = created.worktreePath
  const base: WorkProposal = {
    reminderId: input.item.id,
    status: 'failed',
    source: input.source,
    provider: 'claude',
    model: input.model?.trim() || undefined,
    branch: created.branch,
    worktreePath: wt,
    repoPath: input.repoPath,
    startedAt: Date.now(),
  }
  input.onUpdate?.({ branch: created.branch, worktreePath: wt })

  // 과제 파일은 worktree 밖(스캔 루트)에 둬서 커밋에 섞이지 않게 한다.
  const taskPath = `${wt}-task.md`
  writeFileSync(taskPath, `${workAgentSystemPrompt()}\n\n---\n\n${workAgentPrompt({ item: input.item, subtasks: input.subtasks, parent: input.parent })}\n`, 'utf8')

  let handle: string | null = null
  try {
    // Orca는 등록된 레포의 외부 worktree를 자동 발견하므로 path 셀렉터로 바로 터미널을 만든다.
    // (worktree 폴더를 repo add 하면 별도 워크스페이스가 중복 생성돼 지저분해짐)
    const shortTitle = (input.item.title || created.branch.split('/').pop() || 'work').slice(0, 40)
    const terminalArgs = [
      'terminal', 'create',
      '--worktree', `path:${resolve(wt)}`,
      '--title', `🐾 ${shortTitle}`,
      '--command', claudeCommand(deps.config, input.model),
      '--json',
    ]
    let createRaw: string
    try {
      createRaw = await orca(terminalArgs, 30_000)
    } catch {
      // worktree가 해석되지 않으면 상위 레포가 Orca에 미등록인 것 — 상위 레포를 등록 후 한 번 더
      await orca(['repo', 'add', '--path', input.repoPath, '--json']).catch(() => '')
      createRaw = await orca(terminalArgs, 30_000)
    }
    handle = parseOrcaTerminalHandle(createRaw)
    if (!handle) throw new Error('터미널 핸들을 찾지 못함')
    input.onUpdate?.({ orcaTerminal: handle })
    // 워크트리 카드에서 어떤 작업인지 보이게 표시 이름·코멘트 설정 (실패해도 무시)
    await orca(['worktree', 'set', '--worktree', `path:${resolve(wt)}`, '--display-name', `🐾 ${shortTitle}`, '--comment', '계획 세우는 중', '--json']).catch(() => {})
    await orca(['terminal', 'wait', '--terminal', handle, '--for', 'tui-idle', '--timeout-ms', '90000', '--json'], 100_000)
    await orca(['terminal', 'send', '--terminal', handle, '--text', `${taskPath} 파일을 읽고, 그 안의 지시를 이 worktree에서 그대로 수행해줘.`, '--enter', '--json'])
    // 시작하자마자 Orca에서 바로 보이도록 해당 터미널로 전환. 수동 실행이면 Orca 앱도 앞으로.
    await orca(['terminal', 'switch', '--terminal', handle, '--json']).catch(() => {})
    if (input.source === 'manual') await orca(['open', '--json'], 10_000).catch(() => {})
  } catch (e) {
    logger.warn('Orca 터미널 스폰 실패 — headless 폴백', { err: String(e) })
    return null
  }

  // 계획 파일이 생기고 에이전트가 idle이 될 때까지 폴링. 터미널이 닫히면 중단.
  const planPath = join(wt, PLAN_FILE)
  const finalize = (): WorkProposal => {
    let summary: string | undefined
    try {
      summary = planSummary(readFileSync(planPath, 'utf8')) || undefined
    } catch { /* 요약 없이 진행 */ }
    void orca(['worktree', 'set', '--worktree', `path:${resolve(wt)}`, '--comment', '계획 완료 — 논의 대기', '--json']).catch(() => {})
    return { ...base, status: 'ready', orcaTerminal: handle ?? undefined, summary, finishedAt: Date.now() }
  }
  const deadline = Date.now() + ORCA_RUN_TIMEOUT_MS
  while (Date.now() < deadline) {
    await sleep(POLL_MS)
    if (existsSync(planPath)) {
      // 파일 생성 후에도 에이전트가 마저 작성 중일 수 있으니 idle까지 대기 (초과하면 다음 폴링에서 재시도)
      const idle = await orca(['terminal', 'wait', '--terminal', handle, '--for', 'tui-idle', '--timeout-ms', '60000', '--json'], 70_000)
        .then(() => true)
        .catch(() => false)
      if (idle) return finalize()
      continue
    }
    const alive = await orca(['terminal', 'show', '--terminal', handle, '--json'], 10_000).then(() => true).catch(() => false)
    if (!alive) {
      return { ...base, finishedAt: Date.now(), orcaTerminal: handle, error: `Orca 터미널이 닫혔어요. ${PLAN_FILE} 작성 전에 중단된 것 같아요.` }
    }
  }
  if (existsSync(planPath)) return finalize()
  return {
    ...base,
    finishedAt: Date.now(),
    orcaTerminal: handle,
    error: '시간 안에 계획 파일이 만들어지지 않았어요. Orca 터미널에서 아직 진행 중일 수 있어요 — 확인 후 "다시 실행"으로 재시도하거나 터미널에서 마무리해주세요.',
  }
}

/** Orca 터미널로 전환 (세션 열기). 터미널이 사라졌으면 false. */
export async function switchToOrcaTerminal(proposal: WorkProposal): Promise<boolean> {
  if (!proposal.orcaTerminal) return false
  try {
    await orca(['terminal', 'switch', '--terminal', proposal.orcaTerminal, '--json'])
    return true
  } catch {
    return false
  }
}
