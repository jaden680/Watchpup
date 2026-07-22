/**
 * Work 자동 제안의 Orca 실행 모드: 제안 작업을 headless claude -p 대신
 * Orca 워크트리 터미널에서 눈에 보이게 실행한다 (claude 전용).
 *
 * 흐름: worktree 생성 → 과제 파일 작성 → orca repo add + terminal create(claude)
 * → 과제 지시 send → 커밋이 생길 때까지 폴링 → 통계 수집 → 제안 반환.
 * Orca가 없거나 스폰에 실패하면 null을 돌려줘 호출측이 headless로 폴백한다.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { WatchpupConfig } from '../src/core/config/schema.js'
import type { WorkItem } from '../src/core/work/types.js'
import type { WorkProposal } from '../src/core/workagent/types.js'
import {
  createProposalWorktree,
  lastCommitSubject,
  type ProposalWorktree,
} from '../src/core/workagent/run.js'
import { workAgentSystemPrompt, workAgentPrompt, PLAN_FILE } from '../src/core/workagent/prompt.js'
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
    created = await createProposalWorktree(input.repoPath, input.worktreeRoot, input.item.id)
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
    baseRev: created.baseRev,
    startedAt: Date.now(),
  }

  // 과제 파일은 worktree 밖(스캔 루트)에 둬서 커밋에 섞이지 않게 한다.
  const taskPath = `${wt}-task.md`
  writeFileSync(taskPath, `${workAgentSystemPrompt()}\n\n---\n\n${workAgentPrompt({ item: input.item, subtasks: input.subtasks, parent: input.parent })}\n`, 'utf8')

  let handle: string | null = null
  try {
    await orca(['repo', 'add', '--path', wt, '--json']).catch(() => '')
    const createRaw = await orca([
      'terminal', 'create',
      '--worktree', `path:${resolve(wt)}`,
      '--title', `🐾 ${created.branch.split('/').pop() || 'work'}`,
      '--command', claudeCommand(deps.config, input.model),
      '--json',
    ], 30_000)
    handle = parseOrcaTerminalHandle(createRaw)
    if (!handle) throw new Error('터미널 핸들을 찾지 못함')
    await orca(['terminal', 'wait', '--terminal', handle, '--for', 'tui-idle', '--timeout-ms', '90000', '--json'], 100_000)
    await orca(['terminal', 'send', '--terminal', handle, '--text', `${taskPath} 파일을 읽고, 그 안의 지시를 이 worktree에서 그대로 수행해줘.`, '--enter', '--json'])
  } catch (e) {
    logger.warn('Orca 터미널 스폰 실패 — headless 폴백', { err: String(e) })
    return null
  }

  // 계획 커밋이 생길 때까지 폴링. 터미널이 닫히면 중단.
  const deadline = Date.now() + ORCA_RUN_TIMEOUT_MS
  while (Date.now() < deadline) {
    await sleep(POLL_MS)
    const { commits, files } = await collectProposalCommitsSafe(wt, created.baseRev)
    if (commits > 0) {
      // 커밋 후 에이전트가 마무리 답변 중일 수 있으니 idle까지 잠깐 대기 (실패해도 무시)
      await orca(['terminal', 'wait', '--terminal', handle, '--for', 'tui-idle', '--timeout-ms', '60000', '--json'], 70_000).catch(() => {})
      const subject = await lastCommitSubject(wt)
      return {
        ...base,
        status: 'ready',
        orcaTerminal: handle,
        summary: subject || undefined,
        commits,
        filesChanged: files.length,
        finishedAt: Date.now(),
      }
    }
    const alive = await orca(['terminal', 'show', '--terminal', handle, '--json'], 10_000).then(() => true).catch(() => false)
    if (!alive) {
      return { ...base, finishedAt: Date.now(), orcaTerminal: handle, error: `Orca 터미널이 닫혔어요. ${PLAN_FILE} 커밋 전에 중단된 것 같아요.` }
    }
  }
  return {
    ...base,
    finishedAt: Date.now(),
    orcaTerminal: handle,
    error: '시간 안에 계획 커밋이 없었어요. Orca 터미널에서 아직 진행 중일 수 있어요 — 확인 후 "다시 실행"으로 재시도하거나 터미널에서 마무리해주세요.',
  }
}

/** 폴링 중에는 남은 변경 자동 커밋을 하지 않는다(에이전트가 작업 중) — 커밋 수만 센다. */
async function collectProposalCommitsSafe(wt: string, baseRev: string): Promise<{ commits: number; files: string[] }> {
  try {
    const { stdout: countRaw } = await pexec('git', ['rev-list', '--count', `${baseRev}..HEAD`], { cwd: wt })
    const commits = Number(countRaw.trim()) || 0
    if (!commits) return { commits: 0, files: [] }
    const { stdout: filesRaw } = await pexec('git', ['diff', '--name-only', `${baseRev}..HEAD`], { cwd: wt })
    return { commits, files: filesRaw.trim().split('\n').filter(Boolean) }
  } catch {
    return { commits: 0, files: [] }
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
