import { describe, expect, it } from 'vitest'
import { buildCodexArgs, parseCodexJsonLines } from './codex.js'

describe('parseCodexJsonLines', () => {
  it('신형 이벤트(thread.started + item.completed)를 파싱한다', () => {
    const raw = [
      '{"type":"thread.started","thread_id":"0197-abc"}',
      '{"type":"item.completed","item":{"type":"command_execution","command":"ls"}}',
      '{"type":"item.completed","item":{"type":"agent_message","text":"첫 메시지"}}',
      '{"type":"item.completed","item":{"type":"agent_message","text":"한줄요약: 계획 완료"}}',
    ].join('\n')
    const parsed = parseCodexJsonLines(raw)
    expect(parsed.sessionId).toBe('0197-abc')
    expect(parsed.text).toBe('한줄요약: 계획 완료')
  })

  it('구형 이벤트(session_configured + agent_message)를 파싱한다', () => {
    const raw = [
      '{"id":"1","msg":{"type":"session_configured","session_id":"uuid-legacy"}}',
      '{"id":"2","msg":{"type":"agent_message","message":"결과입니다"}}',
    ].join('\n')
    const parsed = parseCodexJsonLines(raw)
    expect(parsed.sessionId).toBe('uuid-legacy')
    expect(parsed.text).toBe('결과입니다')
  })

  it('JSON이 아닌 줄과 깨진 줄은 무시한다', () => {
    const parsed = parseCodexJsonLines('progress...\n{broken json\n{"type":"noop"}')
    expect(parsed.sessionId).toBeUndefined()
    expect(parsed.text).toBe('')
  })
})

describe('buildCodexArgs', () => {
  it('격리 worktree 실행 인자를 조립한다', () => {
    const args = buildCodexArgs({ model: 'gpt-5.5', cwd: '/tmp/wt', lastMessagePath: '/tmp/last.txt' })
    expect(args).toEqual([
      'exec', '--json', '--color', 'never', '--dangerously-bypass-approvals-and-sandbox',
      '-C', '/tmp/wt', '-m', 'gpt-5.5', '-o', '/tmp/last.txt', '-',
    ])
  })

  it('모델이 비어 있으면 -m을 생략한다', () => {
    const args = buildCodexArgs({ model: ' ', cwd: '/tmp/wt', lastMessagePath: '/tmp/last.txt' })
    expect(args).not.toContain('-m')
  })
})
