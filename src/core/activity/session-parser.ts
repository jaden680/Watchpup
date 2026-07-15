import type { ActivityMessage, ActivitySession, ActivitySource, ActivityState } from '../types.js'

const TITLE_MAX = 96
const DETAIL_MAX = 6_000
const MESSAGE_LIMIT = 24

export interface ParsedSessionState {
  source: Exclude<ActivitySource, 'slack'>
  sessionId: string
  title: string
  customTitle?: string
  detail: string
  messages: ActivityMessage[]
  state: ActivityState
  updatedAt: number
  contextPercent?: number
  cwd?: string
  headless: boolean
}

type JsonObject = Record<string, unknown>

function object(value: unknown): JsonObject | null {
  return value !== null && typeof value === 'object' ? value as JsonObject : null
}

function text(value: unknown): string {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return ''
  return value
    .map((item) => {
      if (typeof item === 'string') return item
      const row = object(item)
      return row && typeof row.text === 'string' ? row.text : ''
    })
    .filter(Boolean)
    .join(' ')
}

export function compactText(value: unknown, max = TITLE_MAX): string {
  const normalized = text(value)
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (normalized.length <= max) return normalized
  return `${normalized.slice(0, Math.max(1, max - 1)).trimEnd()}…`
}

function recordTime(record: JsonObject, fallback: number): number {
  const raw = record.timestamp
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw
  if (typeof raw === 'string') {
    const parsed = Date.parse(raw)
    if (Number.isFinite(parsed)) return parsed
  }
  return fallback
}

function assistantText(content: unknown): string {
  if (typeof content === 'string') return readableText(content)
  if (!Array.isArray(content)) return ''
  const joined = content
    .map((item) => {
      const row = object(item)
      return row && row.type === 'text' && typeof row.text === 'string' ? row.text : ''
    })
    .filter(Boolean)
    .join('\n\n')
  return readableText(joined)
}

function readableText(value: unknown): string {
  const raw = typeof value === 'string' ? value : text(value)
  const normalized = raw.replace(/\r\n/g, '\n').trim()
  if (normalized.length <= DETAIL_MAX) return normalized
  return `${normalized.slice(0, DETAIL_MAX - 1).trimEnd()}…`
}

function appendMessage(
  messages: ActivityMessage[],
  role: ActivityMessage['role'],
  value: unknown,
  at: number,
): ActivityMessage[] {
  const body = role === 'assistant' ? assistantText(value) : readableText(value)
  if (!body) return messages
  const previous = messages.at(-1)
  if (previous?.role === role && previous.text === body) return messages
  return [...messages, { role, text: body, at }].slice(-MESSAGE_LIMIT)
}

export function newParsedSession(
  source: ParsedSessionState['source'],
  sessionId: string,
  updatedAt = 0,
): ParsedSessionState {
  return {
    source,
    sessionId,
    title: '',
    detail: '',
    messages: [],
    state: 'waiting',
    updatedAt,
    headless: false,
  }
}

export function applyCodexRecord(
  current: ParsedSessionState,
  value: unknown,
  fallbackNow = Date.now(),
): ParsedSessionState {
  const record = object(value)
  if (!record) return current
  const payload = object(record.payload)
  const at = recordTime(record, fallbackNow)
  const next = { ...current, updatedAt: Math.max(current.updatedAt, at) }

  if (record.type === 'session_meta' && payload) {
    if (typeof payload.id === 'string' && payload.id) next.sessionId = payload.id
    if (typeof payload.cwd === 'string' && payload.cwd) next.cwd = payload.cwd
    if (payload.thread_source === 'subagent' || object(payload.source)?.subagent) next.headless = true
    return next
  }

  if (record.type === 'turn_context' && payload && typeof payload.cwd === 'string') {
    next.cwd = payload.cwd
    return next
  }

  if (record.type === 'event_msg' && payload) {
    const event = typeof payload.type === 'string' ? payload.type : ''
    if (event === 'user_message') {
      const title = compactText(payload.message)
      if (title) next.title = title
      next.messages = appendMessage(next.messages, 'user', payload.message, at)
      next.state = 'running'
    } else if (event === 'task_started' || event === 'agent_reasoning' || event === 'agent_message') {
      next.state = 'running'
      if (event === 'agent_message') {
        const detail = readableText(payload.message)
        if (detail) next.detail = detail
        next.messages = appendMessage(next.messages, 'assistant', payload.message, at)
      }
    } else if (event === 'task_complete') {
      next.state = 'done'
      const detail = readableText(payload.last_agent_message)
      if (detail) next.detail = detail
      next.messages = appendMessage(next.messages, 'assistant', payload.last_agent_message, at)
    } else if (event === 'turn_aborted') {
      next.state = 'error'
    } else if (event === 'token_count') {
      const info = object(payload.info)
      const last = object(info?.last_token_usage)
      const used = Number(last?.total_tokens)
      const limit = Number(info?.model_context_window)
      if (Number.isFinite(used) && Number.isFinite(limit) && limit > 0) {
        next.contextPercent = Math.max(0, Math.min(100, Math.round(used / limit * 100)))
      }
    }
    return next
  }

  if (record.type === 'response_item' && payload) {
    const subtype = typeof payload.type === 'string' ? payload.type : ''
    if (subtype === 'function_call' || subtype === 'custom_tool_call' || subtype === 'web_search_call' || subtype === 'reasoning') {
      next.state = 'running'
    }
    if (subtype === 'message' && payload.role === 'assistant') {
      const detail = assistantText(payload.content)
      if (detail) next.detail = detail
      next.messages = appendMessage(next.messages, 'assistant', payload.content, at)
    }
  }
  return next
}

export function applyClaudeRecord(
  current: ParsedSessionState,
  value: unknown,
  fallbackNow = Date.now(),
): ParsedSessionState {
  const record = object(value)
  if (!record) return current
  const at = recordTime(record, fallbackNow)
  const next = { ...current, updatedAt: Math.max(current.updatedAt, at) }

  if (typeof record.sessionId === 'string' && record.sessionId) next.sessionId = record.sessionId
  if (typeof record.cwd === 'string' && record.cwd) next.cwd = record.cwd
  if (record.entrypoint === 'sdk-cli' || record.isSidechain === true) next.headless = true

  if (record.type === 'ai-title') {
    const title = compactText(record.aiTitle)
    if (title) next.customTitle = title
    return next
  }
  if (record.type === 'custom-title') {
    const title = compactText(record.customTitle)
    if (title) next.customTitle = title
    return next
  }
  if (record.type === 'last-prompt') {
    const title = compactText(record.lastPrompt)
    if (title && !next.title) next.title = title
    return next
  }
  if (record.type === 'user') {
    const message = object(record.message)
    const title = compactText(message?.content)
    if (title && !next.customTitle) next.title = title
    next.messages = appendMessage(next.messages, 'user', message?.content, at)
    next.state = 'running'
    return next
  }
  if (record.type === 'assistant') {
    const message = object(record.message)
    if (!message) return next
    const detail = assistantText(message.content)
    if (detail) next.detail = detail
    next.messages = appendMessage(next.messages, 'assistant', message.content, at)
    const stopReason = typeof message.stop_reason === 'string' ? message.stop_reason : ''
    next.state = ['end_turn', 'stop_sequence', 'max_tokens'].includes(stopReason) ? 'done' : 'running'
    return next
  }
  if (record.type === 'error') next.state = 'error'
  return next
}

export function activityFromParsed(
  parsed: ParsedSessionState,
  titleOverride: string | undefined,
  now = Date.now(),
): ActivitySession {
  const stale = now - parsed.updatedAt
  const state = parsed.state === 'running' && stale > 2 * 60 * 1000 ? 'waiting' : parsed.state
  const fallback = parsed.cwd?.split('/').filter(Boolean).pop() || `${parsed.source} 세션`
  return {
    id: `${parsed.source}:${parsed.sessionId}`,
    source: parsed.source,
    sessionId: parsed.sessionId,
    title: parsed.customTitle || compactText(titleOverride) || parsed.title || fallback,
    detail: parsed.detail || undefined,
    state,
    updatedAt: parsed.updatedAt,
    contextPercent: parsed.contextPercent,
    messages: parsed.messages,
    canOpen: Boolean(parsed.sessionId),
  }
}
