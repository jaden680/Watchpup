/**
 * Codex CLI 실행기: `codex exec` spawn + JSONL 이벤트 파싱.
 * claude executor(agent/executor.ts)의 codex 대응. 격리 worktree 안에서만 사용하므로
 * claude의 dangerous 모드처럼 승인/샌드박스를 bypass한다(워크트리가 격리 경계).
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { logger } from '../observability/logger.js'

export interface CodexRunOptions {
  prompt: string
  cwd: string
  /** 빈 값이면 codex 기본 모델 */
  model?: string
  timeoutMs: number
}

export interface CodexRunResult {
  text: string
  sessionId?: string
  isError: boolean
}

function codexBin(): string {
  return process.env.WATCHPUP_CODEX_BIN || 'codex'
}

/** codex --json JSONL에서 세션 id와 마지막 agent 메시지를 추출 (버전별 이벤트 스키마 호환). */
export function parseCodexJsonLines(raw: string): { sessionId?: string; text: string } {
  let sessionId: string | undefined
  let text = ''
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{')) continue
    let event: Record<string, unknown>
    try {
      event = JSON.parse(trimmed) as Record<string, unknown>
    } catch {
      continue
    }
    const msg = event.msg as Record<string, unknown> | undefined
    const item = event.item as Record<string, unknown> | undefined
    sessionId ||= firstString(event.thread_id, event.session_id, msg?.session_id, msg?.thread_id)
    const message = firstString(
      item?.type === 'agent_message' ? item.text : undefined,
      msg?.type === 'agent_message' ? msg.message : undefined,
    )
    if (message) text = message
  }
  return { sessionId, text }
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value) return value
  }
  return undefined
}

export function buildCodexArgs(opts: { model?: string; cwd: string; lastMessagePath: string }): string[] {
  const args = ['exec', '--json', '--color', 'never', '--dangerously-bypass-approvals-and-sandbox', '-C', opts.cwd]
  if (opts.model?.trim()) args.push('-m', opts.model.trim())
  args.push('-o', opts.lastMessagePath, '-')
  return args
}

/** codex 실행 → 최종 결과. 프롬프트는 stdin으로 전달. */
export function runCodex(opts: CodexRunOptions): Promise<CodexRunResult> {
  const tempDir = mkdtempSync(join(tmpdir(), 'watchpup-codex-'))
  const lastMessagePath = join(tempDir, 'last-message.txt')
  const args = buildCodexArgs({ model: opts.model, cwd: opts.cwd, lastMessagePath })

  return new Promise<CodexRunResult>((resolve) => {
    const child = spawn(codexBin(), args, { cwd: opts.cwd, env: { ...process.env } })
    let stdout = ''
    let stderr = ''
    let settled = false

    const timer = setTimeout(() => {
      logger.warn('codex 실행 타임아웃 — 종료')
      child.kill('SIGTERM')
      setTimeout(() => child.kill('SIGKILL'), 3000)
    }, opts.timeoutMs)

    const finish = (result: CodexRunResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      rmSync(tempDir, { recursive: true, force: true })
      resolve(result)
    }

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => { stdout += chunk })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => { stderr += chunk })

    child.on('error', (err) => {
      finish({ text: `codex 실행 실패: ${String(err)}`, isError: true })
    })

    child.on('close', (code) => {
      const parsed = parseCodexJsonLines(stdout)
      let lastMessage = ''
      try {
        lastMessage = readFileSync(lastMessagePath, 'utf8').trim()
      } catch {
        /* -o 파일이 없으면 JSONL 파싱값 사용 */
      }
      const text = lastMessage || parsed.text
      if (code !== 0 && !text) {
        finish({ text: stderr.trim() || `codex 종료코드 ${code}`, sessionId: parsed.sessionId, isError: true })
        return
      }
      finish({ text: text || '(codex 응답 없음)', sessionId: parsed.sessionId, isError: code !== 0 })
    })

    child.stdin.write(opts.prompt)
    child.stdin.end()
  })
}
