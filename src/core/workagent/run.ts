/**
 * Work 자동 제안 실행: 격리 git worktree에서 에이전트(claude/codex)가 실행 계획(WATCHPUP-PLAN.md)을
 * 세우고 커밋까지. dev.ts(개발→PR)와 같은 격리 패턴이지만 코드 작업·push·PR 없이 계획 커밋에서 멈추고,
 * worktree를 남겨 사용자가 세션(채팅/터미널)으로 계획을 논의할 수 있게 한다.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join, resolve } from 'node:path'
import { existsSync, mkdirSync } from 'node:fs'
import type { WatchpupConfig } from '../config/schema.js'
import type { WorkItem } from '../work/types.js'
import type { AgentStreamEvent } from '../types.js'
import { Keychain } from '../secrets/keychain.js'
import { runClaude } from '../agent/executor.js'
import { writeMcpConfigFile, resolveMcpSecretEnv } from '../mcp/registry.js'
import { runCodex } from './codex.js'
import { workAgentSystemPrompt, workAgentChatSystemPrompt, workAgentPrompt, extractProposalSummary } from './prompt.js'
import type { WorkAgentProvider, WorkProposal } from './types.js'
import { logger } from '../observability/logger.js'

const pexec = promisify(execFile)
async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await pexec('git', args, { cwd, env: process.env, maxBuffer: 16 * 1024 * 1024 })
  return stdout.trim()
}

export interface WorkProposalInput {
  item: WorkItem
  subtasks: WorkItem[]
  parent?: WorkItem | null
  repoPath: string
  provider: WorkAgentProvider
  /** 빈 값이면 provider 기본 모델 */
  model?: string
  /** worktree들을 모아둘 디렉토리 (예: <dataDir>/work-worktrees) */
  worktreeRoot: string
  source: 'auto' | 'manual'
  onEvent?: (e: AgentStreamEvent) => void
}

function shortId(reminderId: string): string {
  return reminderId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 8).toLowerCase() || 'task'
}

export interface ProposalWorktree {
  branch: string
  worktreePath: string
  baseRev: string
}

/** 제안용 격리 worktree 생성. 실패 시 throw. */
export async function createProposalWorktree(repoPath: string, worktreeRoot: string, reminderId: string): Promise<ProposalWorktree> {
  if (!existsSync(join(repoPath, '.git'))) throw new Error(`git 레포가 아니에요: ${repoPath}`)
  const short = shortId(reminderId)
  const stamp = Date.now().toString(36)
  const branch = `watchpup/work-${short}-${stamp}`
  const root = resolve(worktreeRoot)
  mkdirSync(root, { recursive: true })
  const worktreePath = join(root, `${short}-${stamp}`)
  await git(['worktree', 'add', worktreePath, '-b', branch], repoPath)
  const baseRev = await git(['rev-parse', 'HEAD'], worktreePath)
  return { branch, worktreePath, baseRev }
}

/** 남은 변경 자동 커밋 후 base 이후 커밋 수·변경 파일 집계. */
export async function collectProposalCommits(
  worktreePath: string,
  baseRev: string,
  fallbackTitle: string,
): Promise<{ commits: number; files: string[] }> {
  const dirty = await git(['status', '--porcelain'], worktreePath)
  if (dirty) {
    await git(['add', '-A'], worktreePath)
    await git(['commit', '-m', `watchpup: ${fallbackTitle || '자동 제안'}`], worktreePath)
  }
  const commits = Number(await git(['rev-list', '--count', `${baseRev}..HEAD`], worktreePath).catch(() => '0')) || 0
  const files = commits
    ? (await git(['diff', '--name-only', `${baseRev}..HEAD`], worktreePath).catch(() => '')).split('\n').filter(Boolean)
    : []
  return { commits, files }
}

/** worktree의 마지막 커밋 제목 (요약 폴백용). */
export async function lastCommitSubject(worktreePath: string): Promise<string> {
  return git(['log', '-1', '--pretty=%s'], worktreePath).catch(() => '')
}

/** 실행 결과를 항상 WorkProposal로 반환한다(실패도 failed 제안으로). 던지지 않음. */
export async function runWorkProposal(
  deps: { config: WatchpupConfig; keychain: Keychain },
  input: WorkProposalInput,
): Promise<WorkProposal> {
  const startedAt = Date.now()
  const base: WorkProposal = {
    reminderId: input.item.id,
    status: 'failed',
    source: input.source,
    provider: input.provider,
    model: input.model?.trim() || undefined,
    branch: '',
    worktreePath: '',
    repoPath: input.repoPath,
    startedAt,
  }

  let created: ProposalWorktree
  try {
    created = await createProposalWorktree(input.repoPath, input.worktreeRoot, input.item.id)
  } catch (e) {
    return { ...base, finishedAt: Date.now(), error: `worktree 생성 실패: ${String(e)}` }
  }
  const wt = created.worktreePath
  const proposal: WorkProposal = { ...base, branch: created.branch, worktreePath: wt, baseRev: created.baseRev }
  try {
    const baseRev = created.baseRev
    const prompt = workAgentPrompt({ item: input.item, subtasks: input.subtasks, parent: input.parent })
    const system = workAgentSystemPrompt()

    let text = ''
    let sessionId: string | undefined
    let isError = false
    if (input.provider === 'codex') {
      // codex exec는 시스템 프롬프트 주입이 없으므로 지시를 프롬프트 앞에 붙인다.
      const result = await runCodex({
        prompt: `${system}\n\n${prompt}`,
        cwd: wt,
        model: input.model,
        timeoutMs: deps.config.requestTimeoutMs,
      })
      text = result.text
      sessionId = result.sessionId
      isError = result.isError
    } else {
      // MCP(Jira·Notion 등)를 붙여 링크 내용을 읽을 수 있게 한다. 격리 worktree라 권한 bypass.
      const mcpConfigPath = writeMcpConfigFile(deps.config, join(deps.config.dataDir, 'mcp.json'))
      const { env } = await resolveMcpSecretEnv(deps.config, deps.keychain)
      const model = input.model?.trim() || deps.config.model
      const result = await runClaude({
        prompt,
        config: { ...deps.config, model },
        agents: {},
        allowedTools: [],
        disallowedTools: [],
        systemPrompt: system,
        isResume: false,
        cwd: wt,
        dangerous: true,
        mcpConfigPath,
        secretEnv: env,
        onEvent: input.onEvent,
      })
      text = result.text
      sessionId = result.sessionId
      isError = result.isError
    }

    // 에이전트가 커밋을 안 남겼으면 남은 변경을 대신 커밋 (dev.ts와 동일한 안전망)
    const { commits, files } = await collectProposalCommits(wt, baseRev, input.item.title)

    if (isError && commits === 0) {
      return { ...proposal, finishedAt: Date.now(), sessionId, error: text || '에이전트 실행에 실패했어요.' }
    }
    return {
      ...proposal,
      status: 'ready',
      sessionId,
      summary: extractProposalSummary(text),
      commits,
      filesChanged: files.length,
      finishedAt: Date.now(),
    }
  } catch (e) {
    logger.error('runWorkProposal 실패', { branch: proposal.branch, err: String(e) })
    // worktree는 조사용으로 남겨둔다
    return { ...proposal, finishedAt: Date.now(), error: String(e) }
  }
}

/**
 * 계획 논의: 제안을 만든 claude 세션을 worktree cwd로 resume해 이어서 대화한다.
 * 계획 수정 요청이면 에이전트가 plan 파일을 고치고 커밋한다(격리 worktree라 권한 bypass).
 * codex 제안은 in-app 채팅 미지원 — "세션 열기"(터미널)로 논의한다.
 */
export async function chatWorkProposal(
  deps: { config: WatchpupConfig; keychain: Keychain },
  input: { proposal: WorkProposal; text: string; onEvent?: (e: AgentStreamEvent) => void },
): Promise<{ text: string; commits?: number }> {
  const { proposal } = input
  if (proposal.provider !== 'claude') throw new Error('Codex 제안은 "세션 열기"로 이어서 논의해주세요.')
  if (!proposal.sessionId) throw new Error('이어갈 세션이 없어요. "세션 열기"로 열어주세요.')
  if (!existsSync(proposal.worktreePath)) throw new Error('제안 worktree가 더 이상 존재하지 않아요. 다시 실행해주세요.')

  const mcpConfigPath = writeMcpConfigFile(deps.config, join(deps.config.dataDir, 'mcp.json'))
  const { env } = await resolveMcpSecretEnv(deps.config, deps.keychain)
  const model = proposal.model?.trim() || deps.config.model
  const result = await runClaude({
    prompt: input.text,
    config: { ...deps.config, model },
    agents: {},
    allowedTools: [],
    disallowedTools: [],
    systemPrompt: workAgentChatSystemPrompt(),
    sessionId: proposal.sessionId,
    isResume: true,
    cwd: proposal.worktreePath,
    dangerous: true,
    mcpConfigPath,
    secretEnv: env,
    onEvent: input.onEvent,
  })
  if (result.isError) throw new Error(result.text || '논의 세션 실행에 실패했어요.')
  // 계획이 수정·커밋되었을 수 있으니 커밋 수를 갱신해 돌려준다
  const commits = proposal.baseRev
    ? Number(await git(['rev-list', '--count', `${proposal.baseRev}..HEAD`], proposal.worktreePath).catch(() => '')) || undefined
    : undefined
  return { text: result.text, commits }
}

/** 제안 정리: worktree 제거, 커밋 없는 브랜치는 함께 삭제 (커밋 있으면 브랜치 보존). */
export async function cleanupWorkProposal(proposal: WorkProposal): Promise<void> {
  const repo = proposal.repoPath
  if (!repo || !existsSync(join(repo, '.git'))) return
  if (proposal.worktreePath) {
    await git(['worktree', 'remove', proposal.worktreePath, '--force'], repo).catch(() => {})
  }
  if (proposal.branch && !(proposal.commits && proposal.commits > 0)) {
    await git(['branch', '-D', proposal.branch], repo).catch(() => {})
  }
}
