import { join } from 'node:path'
import type { AgentResult, AgentStreamEvent, Mention } from '../types.js'
import type { WatchpupConfig, Playbook } from '../config/schema.js'
import { SessionStore, threadKey } from '../session/store.js'
import { Keychain } from '../secrets/keychain.js'
import { computeToolScope } from '../safety/gating.js'
import { writeMcpConfigFile, resolveMcpSecretEnv } from '../mcp/registry.js'
import { runClaude } from '../agent/executor.js'
import { watchpupSystemPrompt, analysisUserPrompt, playbookActionPrompt, reminderPrompt } from '../agent/prompts.js'
import { parseAnalysis, parseReminderDraft, type ReminderDraftText } from '../agent/analysis.js'
import { threadText } from './mention-context.js'

export interface PipelineDeps {
  config: WatchpupConfig
  sessions: SessionStore
  keychain: Keychain
  /** 워크플로우별 교훈(자가발전) — key로 조회해 프롬프트에 주입. 없으면 주입 생략. */
  lessons?: { texts(key: string): string[] }
  runClaudeFn?: typeof runClaude
}

async function prepare(deps: PipelineDeps, write = false) {
  const { config, keychain } = deps
  const scope = computeToolScope(config, write) // 기본 읽기전용, write playbook만 쓰기 허용
  const mcpConfigPath = writeMcpConfigFile(config, join(config.dataDir, 'mcp.json'))
  const { env } = await resolveMcpSecretEnv(config, keychain)
  // 코드 조사용 레포 + Obsidian vault를 claude 읽기 경로로. (executor가 존재하는 경로만 --add-dir)
  const vault = config.obsidian.enabled && config.obsidian.vaultPath ? [config.obsidian.vaultPath] : []
  const addDirs = [...(config.repos ?? []), ...vault]
  return { scope, mcpConfigPath, secretEnv: env, addDirs }
}

/** claude가 분석 중 사용한 도구 이름 → 사람이 읽는 소스 라벨(라우팅 파악용). */
export function sourcesFromTools(tools: string[], hasRepos: boolean): string[] {
  const out: string[] = []
  const add = (s: string): void => {
    if (!out.includes(s)) out.push(s)
  }
  const FS = new Set(['read', 'grep', 'glob', 'bash', 'edit', 'multiedit', 'ls'])
  for (const t of tools) {
    const n = t.toLowerCase()
    if (n.includes('notion')) add('노션')
    else if (n.includes('websearch') || n.includes('webfetch')) add('웹')
    else if (n.includes('slack')) add('슬랙')
    else if (FS.has(n)) add(hasRepos ? '코드' : '노트')
    else if (n.startsWith('mcp__')) {
      const parts = t.split('__')
      if (parts[1]) add(parts[1])
    }
  }
  return out
}

export async function analyzeMention(
  deps: PipelineDeps,
  input: {
    id: string; channel: string; channelName?: string; threadTs: string; messageTs: string
    authorId: string; authorName?: string; text: string; threadText: string
    permalink?: string; mentionedAt: number; onEvent?: (e: AgentStreamEvent) => void
  },
): Promise<Mention> {
  const { config, sessions } = deps
  const run = deps.runClaudeFn ?? runClaude
  const key = threadKey(input.channel, input.threadTs)
  const existing = sessions.get(key)
  const rec = existing ?? sessions.ensure(key)
  const { scope, mcpConfigPath, secretEnv, addDirs } = await prepare(deps)

  const result: AgentResult = await run({
    prompt: analysisUserPrompt({ threadText: input.threadText, authorName: input.authorName ?? input.authorId, channelName: input.channelName, playbooks: config.playbooks, lessons: deps.lessons?.texts('analysis') }),
    config,
    agents: {},
    allowedTools: scope.allowedTools,
    disallowedTools: scope.disallowedTools,
    systemPrompt: watchpupSystemPrompt(config.botName, config.persona),
    sessionId: rec.sessionId,
    isResume: !!existing,
    addDirs,
    mcpConfigPath,
    secretEnv,
    permissionMode: 'default',
    onEvent: input.onEvent,
  })
  sessions.recordTurn(key, result.sessionId ?? rec.sessionId, input.messageTs)
  const analysis = parseAnalysis(result.text)
  analysis.sources = sourcesFromTools(result.toolsUsed ?? [], (config.repos ?? []).length > 0)
  return {
    id: input.id,
    channel: input.channel,
    channelName: input.channelName,
    threadTs: input.threadTs,
    messageTs: input.messageTs,
    permalink: input.permalink,
    authorId: input.authorId,
    authorName: input.authorName,
    text: input.text,
    mentionedAt: input.mentionedAt,
    status: 'ready',
    sessionId: result.sessionId ?? rec.sessionId,
    analysis,
    todos: analysis.todos.map((t) => ({ text: t.text, done: false, playbookId: t.playbookId })),
  }
}

/**
 * 스레드 내용 기반 미리알림(Reminder) 초안 생성. 저장된 스레드(threadText)만 사용(재조회 없음).
 * 세션 재사용 없이 단발 호출 — 스레드 텍스트를 프롬프트에 직접 담아 보내므로 resume이 불필요.
 */
export async function generateReminderDraft(
  deps: PipelineDeps,
  input: { mention: Mention; extra?: string },
): Promise<ReminderDraftText> {
  const { config } = deps
  const run = deps.runClaudeFn ?? runClaude
  const { mention, extra } = input
  const { scope, mcpConfigPath, secretEnv, addDirs } = await prepare(deps)

  const result: AgentResult = await run({
    prompt: reminderPrompt({
      threadText: threadText(mention),
      authorName: mention.authorName ?? mention.authorId,
      channelName: mention.channelName,
      extra,
    }),
    config,
    agents: {},
    allowedTools: scope.allowedTools,
    disallowedTools: scope.disallowedTools,
    systemPrompt: watchpupSystemPrompt(config.botName, config.persona),
    isResume: false,
    addDirs,
    mcpConfigPath,
    secretEnv,
    permissionMode: 'default',
  })
  return parseReminderDraft(result.text)
}

export async function chatFollowup(
  deps: PipelineDeps,
  input: { channel: string; threadTs: string; prompt: string; onEvent?: (e: AgentStreamEvent) => void },
): Promise<{ text: string }> {
  const { config, sessions } = deps
  const run = deps.runClaudeFn ?? runClaude
  const key = threadKey(input.channel, input.threadTs)
  const existing = sessions.get(key)
  const rec = existing ?? sessions.ensure(key)
  const { scope, mcpConfigPath, secretEnv, addDirs } = await prepare(deps)
  const result = await run({
    prompt: input.prompt,
    config,
    agents: {},
    allowedTools: scope.allowedTools,
    disallowedTools: scope.disallowedTools,
    systemPrompt: watchpupSystemPrompt(config.botName, config.persona),
    sessionId: rec.sessionId,
    isResume: !!existing,
    addDirs,
    mcpConfigPath,
    secretEnv,
    permissionMode: 'default',
    onEvent: input.onEvent,
  })
  sessions.recordTurn(key, result.sessionId ?? rec.sessionId)
  return { text: result.text }
}

/**
 * 액션(playbook) 워크플로우 실행. playbook.steps를 목표로 claude가 자율 수행.
 * write playbook이면 쓰기 도구 허용(호출 전 UI에서 승인). 스레드 세션을 이어 맥락 유지.
 */
export async function runPlaybook(
  deps: PipelineDeps,
  input: {
    channel: string
    threadTs: string
    playbook: Playbook
    context: string // 멘션 요약/원문 등 실행에 줄 맥락
    extra?: string // 이번 실행에 대한 사용자의 추가 지시(선택)
    onEvent?: (e: AgentStreamEvent) => void
  },
): Promise<{ text: string }> {
  const { config, sessions } = deps
  const run = deps.runClaudeFn ?? runClaude
  const key = threadKey(input.channel, input.threadTs)
  const existing = sessions.get(key)
  const rec = existing ?? sessions.ensure(key)
  const { scope, mcpConfigPath, secretEnv, addDirs } = await prepare(deps, input.playbook.write)
  const result = await run({
    prompt: playbookActionPrompt({ playbook: input.playbook, context: input.context, extra: input.extra, lessons: deps.lessons?.texts(input.playbook.id) }),
    config,
    agents: {},
    allowedTools: scope.allowedTools,
    disallowedTools: scope.disallowedTools,
    systemPrompt: watchpupSystemPrompt(config.botName, config.persona),
    sessionId: rec.sessionId,
    isResume: !!existing,
    addDirs,
    mcpConfigPath,
    secretEnv,
    permissionMode: 'default',
    onEvent: input.onEvent,
  })
  sessions.recordTurn(key, result.sessionId ?? rec.sessionId)
  return { text: result.text }
}
