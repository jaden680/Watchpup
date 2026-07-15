import { describe, expect, it } from 'vitest'
import { activityFromParsed, applyClaudeRecord, applyCodexRecord, newParsedSession } from './session-parser.js'

describe('agent session parser', () => {
  it('Codex 작업 시작/완료와 컨텍스트 사용량을 해석한다', () => {
    let state = newParsedSession('codex', 'thread-1')
    state = applyCodexRecord(state, { timestamp: '2026-07-13T01:00:00Z', type: 'event_msg', payload: { type: 'user_message', message: 'HUD 만들어줘' } })
    state = applyCodexRecord(state, { timestamp: '2026-07-13T01:00:01Z', type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { total_tokens: 49 }, model_context_window: 100 } } })
    state = applyCodexRecord(state, { timestamp: '2026-07-13T01:00:02Z', type: 'event_msg', payload: { type: 'task_complete', last_agent_message: '완료했습니다' } })

    const activity = activityFromParsed(state, '세션 HUD 구현', Date.parse('2026-07-13T01:00:03Z'))
    expect(activity).toMatchObject({ source: 'codex', title: '세션 HUD 구현', detail: '완료했습니다', state: 'done', contextPercent: 49 })
    expect(activity.messages).toEqual([
      { role: 'user', text: 'HUD 만들어줘', at: Date.parse('2026-07-13T01:00:00Z') },
      { role: 'assistant', text: '완료했습니다', at: Date.parse('2026-07-13T01:00:02Z') },
    ])
  })

  it('Claude 도구 실행과 end_turn을 구분한다', () => {
    let state = newParsedSession('claude', 'claude-1')
    state = applyClaudeRecord(state, { timestamp: '2026-07-13T01:00:00Z', type: 'user', sessionId: 'claude-1', message: { content: '컴포넌트 구현해줘' } })
    state = applyClaudeRecord(state, { timestamp: '2026-07-13T01:00:01Z', type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit' }], stop_reason: 'tool_use' } })
    expect(state.state).toBe('running')
    state = applyClaudeRecord(state, { timestamp: '2026-07-13T01:00:02Z', type: 'assistant', message: { content: [{ type: 'text', text: '구현 완료' }], stop_reason: 'end_turn' } })
    const activity = activityFromParsed(state, undefined, Date.parse('2026-07-13T01:00:03Z'))
    expect(activity).toMatchObject({ title: '컴포넌트 구현해줘', detail: '구현 완료', state: 'done' })
    expect(activity.messages?.map(({ role, text }) => ({ role, text }))).toEqual([
      { role: 'user', text: '컴포넌트 구현해줘' },
      { role: 'assistant', text: '구현 완료' },
    ])
  })

  it('Claude custom-title을 최신 프롬프트나 세션 레지스트리 이름보다 우선한다', () => {
    let state = newParsedSession('claude', 'claude-1')
    state = applyClaudeRecord(state, { type: 'user', message: { content: '처음 요청' } })
    state = applyClaudeRecord(state, { type: 'custom-title', customTitle: 'Phase 5 component work plan' })
    state = applyClaudeRecord(state, { type: 'last-prompt', lastPrompt: '나중 요청' })
    state = applyClaudeRecord(state, { type: 'user', message: { content: '가장 최근 요청' } })

    expect(activityFromParsed(state, 'zigzag-ios-3-53')).toMatchObject({
      title: 'Phase 5 component work plan',
    })
  })

  it('오랫동안 새 로그가 없는 실행 상태는 대기로 낮춘다', () => {
    const state = { ...newParsedSession('codex', 'thread-1'), state: 'running' as const, updatedAt: 1_000, title: '작업' }
    expect(activityFromParsed(state, undefined, 1_000 + 121_000).state).toBe('waiting')
  })

  it('내부 SDK 세션과 Codex 서브에이전트를 HUD 제외 대상으로 표시한다', () => {
    const claude = applyClaudeRecord(newParsedSession('claude', 'c1'), { type: 'user', entrypoint: 'sdk-cli', message: { content: '내부 호출' } })
    const codex = applyCodexRecord(newParsedSession('codex', 'x1'), { type: 'session_meta', payload: { thread_source: 'subagent' } })
    expect(claude.headless).toBe(true)
    expect(codex.headless).toBe(true)
  })
})
