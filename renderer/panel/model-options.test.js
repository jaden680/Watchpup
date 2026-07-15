import { describe, expect, it } from 'vitest'
import { CLAUDE_MODEL_OPTIONS, modelOptionsWithCurrent, normalizeClaudeModel } from './model-options.js'

describe('Claude model options', () => {
  it('로컬 Claude CLI가 안내하는 모델 별칭을 제공한다', () => {
    expect(CLAUDE_MODEL_OPTIONS.map((option) => option.value)).toEqual(['default', 'sonnet', 'fable', 'opus', 'haiku'])
  })

  it('알려진 별칭은 대소문자와 공백을 정규화한다', () => {
    expect(normalizeClaudeModel(' Opus ')).toBe('opus')
    expect(normalizeClaudeModel('SONNET')).toBe('sonnet')
    expect(normalizeClaudeModel('')).toBe('opus')
  })

  it('기존 전체 모델 ID는 선택 가능한 현재 저장값으로 보존한다', () => {
    const result = modelOptionsWithCurrent('claude-custom-1', [{ value: 'opus', label: 'Opus' }])

    expect(result.selected).toBe('claude-custom-1')
    expect(result.options.at(-1)).toEqual({
      value: 'claude-custom-1',
      label: '현재 저장값 (claude-custom-1)',
      custom: true,
    })
  })
})
