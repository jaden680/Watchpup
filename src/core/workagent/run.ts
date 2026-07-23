/**
 * Work 자동 제안 실행: 격리 git worktree에서 에이전트(claude/codex)가 실행 계획(WATCHPUP-PLAN.md)만
 * 작성한다. 코드 작업·git 커밋·push·PR은 하지 않으며, worktree를 남겨 사용자가
 * 세션(채팅/터미널)으로 계획을 논의할 수 있게 한다.
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
import { workAgentSystemPrompt, workAgentChatSystemPrompt, workAgentPrompt, extractProposalSummary, PLAN_FILE } from './prompt.js'
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
  /** 미리 생성한 영어 브랜치 슬러그 (없으면 제목 슬러그 폴백) */
  slug?: string
  source: 'auto' | 'manual'
  onEvent?: (e: AgentStreamEvent) => void
  /** 실행 중 확보되는 정보(worktree·세션 id 등)를 즉시 저장할 수 있게 알림 — 재시작 복구용 */
  onUpdate?: (patch: Partial<WorkProposal>) => void
  /** 사용자 취소 신호 */
  signal?: AbortSignal
}

function shortId(reminderId: string): string {
  return reminderId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 8).toLowerCase() || 'task'
}

/** LLM이 만든 슬러그 후보를 브랜치 이름으로 정제. 형식이 안 맞으면 빈 문자열. */
export function sanitizeBranchSlug(text: string): string {
  const slug = text
    .trim()
    .split('\n').at(-1)!
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
    .replace(/^-+|-+$/g, '')
  return /^[a-z0-9][a-z0-9-]{1,31}$/.test(slug) ? slug : ''
}

/** 작업 제목 → 영어 브랜치 슬러그 (haiku 단발 호출). 실패하면 빈 문자열 (호출측이 한글 슬러그로 폴백). */
export async function generateBranchSlug(deps: { config: WatchpupConfig }, title: string): Promise<string> {
  if (!title.trim()) return ''
  try {
    const result = await runClaude({
      prompt: title,
      config: { ...deps.config, model: 'haiku', requestTimeoutMs: 45_000 },
      agents: {},
      allowedTools: [],
      disallowedTools: [],
      systemPrompt: [
        'Convert the given task title into a short English git branch slug.',
        'Rules: kebab-case, lowercase letters/digits/hyphens only, 2-4 words, translate Korean to English,',
        'drop platform tags like [iOS], no ticket ids or dates. Respond with ONLY the slug, nothing else.',
      ].join(' '),
      isResume: false,
    })
    if (result.isError) return ''
    return sanitizeBranchSlug(result.text)
  } catch {
    return ''
  }
}

/** 브랜치·worktree 이름용 폴백 슬러그 — 작업 제목 기반 ([iOS] 같은 태그 제거, 한글 유지). 비면 id 축약. */
export function branchSlug(title: string, reminderId: string): string {
  const slug = title
    .replace(/\[[^\]]*\]/g, ' ')
    .normalize('NFC')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24)
    .replace(/^-+|-+$/g, '')
  return slug || shortId(reminderId)
}

export interface ProposalWorktree {
  branch: string
  worktreePath: string
}

/** 제안용 격리 worktree 생성. 이름은 영어 슬러그(있으면) 또는 제목 슬러그. 실패 시 throw. */
export async function createProposalWorktree(
  repoPath: string,
  worktreeRoot: string,
  reminderId: string,
  title = '',
  englishSlug = '',
): Promise<ProposalWorktree> {
  if (!existsSync(join(repoPath, '.git'))) throw new Error(`git 레포가 아니에요: ${repoPath}`)
  const slug = englishSlug || branchSlug(title, reminderId)
  const stamp = Date.now().toString(36)
  const branch = `watchpup/${slug}-${stamp}`
  const root = resolve(worktreeRoot)
  mkdirSync(root, { recursive: true })
  const worktreePath = join(root, `${slug}-${stamp}`)
  await git(['worktree', 'add', worktreePath, '-b', branch], repoPath)
  return { branch, worktreePath }
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
    created = await createProposalWorktree(input.repoPath, input.worktreeRoot, input.item.id, input.item.title, input.slug)
  } catch (e) {
    return { ...base, finishedAt: Date.now(), error: `worktree 생성 실패: ${String(e)}` }
  }
  const wt = created.worktreePath
  const proposal: WorkProposal = { ...base, branch: created.branch, worktreePath: wt }
  input.onUpdate?.({ branch: created.branch, worktreePath: wt })
  try {
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
        signal: input.signal,
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
        onEvent: (event) => {
          // 세션 id는 스트림 시작 시 바로 알 수 있으니 즉시 저장해 재시작에도 이어갈 수 있게 한다
          if (event.type === 'system' && event.sessionId && !sessionId) {
            sessionId = event.sessionId
            input.onUpdate?.({ sessionId })
          }
          input.onEvent?.(event)
        },
        signal: input.signal,
      })
      text = result.text
      sessionId = result.sessionId ?? sessionId
      isError = result.isError
    }

    if (input.signal?.aborted) {
      return { ...proposal, finishedAt: Date.now(), sessionId, error: '취소했어요.' }
    }
    // 완료 판정: 계획 파일이 생겼는지 (커밋은 하지 않는다)
    const planExists = existsSync(join(wt, PLAN_FILE))
    if (isError && !planExists) {
      return { ...proposal, finishedAt: Date.now(), sessionId, error: text || '에이전트 실행에 실패했어요.' }
    }
    if (!planExists) {
      return { ...proposal, finishedAt: Date.now(), sessionId, error: `${PLAN_FILE}이 작성되지 않았어요. 세션을 열어 확인해주세요.` }
    }
    return {
      ...proposal,
      status: 'ready',
      sessionId,
      summary: extractProposalSummary(text),
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
 * 계획 수정 요청이면 에이전트가 plan 파일만 고친다(커밋 없음, 격리 worktree라 권한 bypass).
 * codex 제안은 in-app 채팅 미지원 — "세션 열기"(터미널)로 논의한다.
 */
export async function chatWorkProposal(
  deps: { config: WatchpupConfig; keychain: Keychain },
  input: { proposal: WorkProposal; text: string; onEvent?: (e: AgentStreamEvent) => void },
): Promise<{ text: string }> {
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
  return { text: result.text }
}

/** 제안 정리: worktree와 브랜치 제거 (커밋이 없으므로 남길 것도 없음 — 계획 파일도 함께 삭제됨). */
export async function cleanupWorkProposal(proposal: WorkProposal): Promise<void> {
  const repo = proposal.repoPath
  if (!repo || !existsSync(join(repo, '.git'))) return
  if (proposal.worktreePath) {
    await git(['worktree', 'remove', proposal.worktreePath, '--force'], repo).catch(() => {})
  }
  if (proposal.branch) {
    await git(['branch', '-D', proposal.branch], repo).catch(() => {})
  }
}
