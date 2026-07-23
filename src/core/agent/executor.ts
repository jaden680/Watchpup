/**
 * Claude Code 실행기: `claude -p` spawn + stream-json 파싱.
 * 하나의 책임: 서브프로세스 실행/스트리밍/결과 수집.
 *
 * 리서치 반영:
 *  - R-2: parent permission-mode = default (bypass/auto/acceptEdits 금지)
 *  - C-3: --output-format stream-json --verbose --include-partial-messages, resume는 cwd 고정
 *  - C-17: child env는 교체 → {...process.env, ...secrets, CLAUDECODE:''}
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import type { AgentResult, AgentStreamEvent } from '../types.js'
import type { WatchpupConfig } from '../config/schema.js'
import { StreamJsonParser } from './stream.js'
import { logger } from '../observability/logger.js'

export interface AgentSpec {
  description: string
  prompt: string
  tools: string[]
  model?: string
}

export interface RunOptions {
  prompt: string
  config: WatchpupConfig
  agents: Record<string, AgentSpec>
  allowedTools: string[]
  disallowedTools: string[]
  systemPrompt: string
  /** 세션 UUID (resume 또는 신규 지정) */
  sessionId?: string
  /** 기존 세션 재개 여부 */
  isResume: boolean
  /** 코드검색 허용 로컬 디렉토리 (존재하는 것만 전달) */
  addDirs?: string[]
  /** --mcp-config 파일 경로 */
  mcpConfigPath?: string | null
  /** child env로 주입할 시크릿 */
  secretEnv?: Record<string, string>
  /** 실행 cwd 오버라이드 (기본 config.workDir) */
  cwd?: string
  /** permission-mode 오버라이드 (기본 default) */
  permissionMode?: string
  /** 권한 검사 전면 bypass (격리 worktree의 자율 개발 전용 — dev 워크플로우에서만) */
  dangerous?: boolean
  /** 스트림 이벤트 콜백 */
  onEvent?: (e: AgentStreamEvent) => void
  /** 실행 취소 신호 — abort 시 서브프로세스를 종료한다 */
  signal?: AbortSignal
}

// 지연 평가: 테스트가 import 이후 process.env.WATCHPUP_CLAUDE_BIN 을 설정하는 경우를 지원.
function claudeBin(): string {
  return process.env.WATCHPUP_CLAUDE_BIN || 'claude'
}

export function buildClaudeArgs(opts: RunOptions): string[] {
  const { config } = opts
  const args = [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
  ]
  // /model의 Default는 CLI가 기억한 계정 기본 모델을 사용한다.
  if (config.model !== 'default') args.push('--model', config.model)
  args.push('--agents', JSON.stringify(opts.agents), '--append-system-prompt', opts.systemPrompt)
  // dev 워크플로우: 격리 worktree에서 자율 편집/git — 권한 bypass. 그 외엔 permission-mode.
  if (opts.dangerous) args.push('--dangerously-skip-permissions')
  else args.push('--permission-mode', opts.permissionMode ?? 'default')
  // 0 = 무제한 (정액제/구독). 양수일 때만 비용 상한 적용.
  if (config.maxBudgetUsd > 0) args.push('--max-budget-usd', String(config.maxBudgetUsd))
  if (opts.allowedTools.length) args.push('--allowedTools', opts.allowedTools.join(','))
  if (opts.disallowedTools.length) args.push('--disallowedTools', opts.disallowedTools.join(','))
  for (const dir of opts.addDirs ?? []) {
    if (existsSync(dir)) args.push('--add-dir', dir)
  }
  if (opts.mcpConfigPath) args.push('--mcp-config', opts.mcpConfigPath)
  // watchpup가 spawn하는 claude는 사용자 개인 환경을 상속하지 않는다:
  //  - --strict-mcp-config: 사용자 전역/플러그인 MCP 무시, watchpup의 --mcp-config만 사용
  //  - disableAllHooks: 사용자 Stop 훅 등 무시 (예: Obsidian 자동노트 훅이 매 실행마다 앱을 켜던 문제)
  args.push('--strict-mcp-config')
  args.push('--settings', JSON.stringify({ disableAllHooks: true }))
  if (opts.sessionId) {
    if (opts.isResume) args.push('--resume', opts.sessionId)
    else args.push('--session-id', opts.sessionId)
  }
  return args
}

/** claude 실행 → 최종 결과 */
export function runClaude(opts: RunOptions): Promise<AgentResult> {
  const { config } = opts
  const cwd = opts.cwd ?? config.workDir
  if (!existsSync(cwd)) mkdirSync(cwd, { recursive: true })

  const args = buildClaudeArgs(opts)
  const env = { ...process.env, ...(opts.secretEnv ?? {}), CLAUDECODE: '' }
  const parser = new StreamJsonParser()

  let finalText = ''
  let sessionId = opts.sessionId
  let costUsd: number | undefined
  let isError = false
  let sawResult = false
  const toolsUsed: string[] = []

  const dispatch = (events: AgentStreamEvent[]): void => {
    for (const e of events) {
      if (e.type === 'system' && e.sessionId) sessionId = e.sessionId
      else if (e.type === 'tool') toolsUsed.push(e.name)
      else if (e.type === 'result') {
        sawResult = true
        finalText = e.text
        if (e.sessionId) sessionId = e.sessionId
        costUsd = e.costUsd
        isError = e.isError
      }
      opts.onEvent?.(e)
    }
  }

  return new Promise<AgentResult>((resolve) => {
    const child = spawn(claudeBin(), args, { cwd, env })
    let settled = false
    let stderr = ''

    const timer = setTimeout(() => {
      logger.warn('claude 실행 타임아웃 — 종료', { sessionId })
      child.kill('SIGTERM')
      setTimeout(() => child.kill('SIGKILL'), 3000)
    }, config.requestTimeoutMs)

    const onAbort = (): void => {
      logger.warn('claude 실행 취소 — 종료', { sessionId })
      child.kill('SIGTERM')
      setTimeout(() => child.kill('SIGKILL'), 3000)
    }
    if (opts.signal?.aborted) onAbort()
    else opts.signal?.addEventListener('abort', onAbort, { once: true })

    const finish = (res: AgentResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
      resolve(res)
    }

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => dispatch(parser.push(chunk)))
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk
    })

    child.on('error', (err) => {
      logger.error('claude spawn 실패', { err: String(err) })
      opts.onEvent?.({ type: 'error', message: String(err) })
      finish({ text: `실행 실패: ${String(err)}`, isError: true, toolsUsed })
    })

    child.on('close', (code) => {
      dispatch(parser.flush())
      if (opts.isResume && opts.sessionId && sessionId && sessionId !== opts.sessionId) {
        logger.warn('resume 세션 불일치 (cwd 스코프/버그 의심)', {
          requested: opts.sessionId,
          got: sessionId,
        })
      }
      if (code !== 0 && !finalText) {
        const msg = stderr.trim() || `claude 종료코드 ${code}`
        opts.onEvent?.({ type: 'error', message: msg })
        finish({ text: msg, sessionId, costUsd, isError: true, toolsUsed })
        return
      }
      if (!sawResult) {
        const msg = 'Claude가 응답을 완료하지 못했습니다.'
        opts.onEvent?.({ type: 'error', message: msg })
        finish({ text: msg, sessionId, costUsd, isError: true, toolsUsed })
        return
      }
      finish({ text: finalText, sessionId, costUsd, isError, toolsUsed })
    })

    // 프롬프트를 stdin으로 전달 (긴 입력 안전)
    child.stdin.write(opts.prompt)
    child.stdin.end()
  })
}
