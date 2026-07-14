export type ActivityTarget =
  | { kind: 'external'; url: string }
  | { kind: 'mention'; id: string }

export function activityTarget(id: string): ActivityTarget | null {
  if (typeof id !== 'string') return null
  const separator = id.indexOf(':')
  if (separator <= 0) return null
  const source = id.slice(0, separator)
  const sessionId = id.slice(separator + 1)
  if (!sessionId) return null
  if (source === 'codex') return { kind: 'external', url: `codex://threads/${encodeURIComponent(sessionId)}` }
  if (source === 'claude') return { kind: 'external', url: `claude://resume?session=${encodeURIComponent(sessionId)}` }
  if (source === 'slack') return { kind: 'mention', id: sessionId }
  return null
}
