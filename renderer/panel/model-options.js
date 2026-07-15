export const CLAUDE_MODEL_OPTIONS = Object.freeze([
  { value: 'default', label: 'Default (CLI 권장)' },
  { value: 'sonnet', label: 'Sonnet' },
  { value: 'fable', label: 'Fable' },
  { value: 'opus', label: 'Opus' },
  { value: 'haiku', label: 'Haiku' },
])

export function normalizeClaudeModel(value) {
  const trimmed = typeof value === 'string' ? value.trim() : ''
  if (!trimmed) return 'opus'
  const alias = trimmed.toLowerCase()
  return /^[a-z][a-z0-9._-]*$/.test(alias) ? alias : trimmed
}

export function modelOptionsWithCurrent(value, available = CLAUDE_MODEL_OPTIONS) {
  const selected = normalizeClaudeModel(value)
  const options = available
    .filter((option) => option && typeof option.value === 'string' && typeof option.label === 'string')
    .map((option) => ({ value: option.value, label: option.label }))
  if (!options.some((option) => option.value === selected)) {
    options.push({ value: selected, label: `현재 저장값 (${selected})`, custom: true })
  }
  return { selected, options }
}
