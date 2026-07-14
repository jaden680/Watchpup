import { appendFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { activityHistoryCutoff, LocalAgentPoller } from './session-poller.js'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function jsonl(rows: unknown[]): string {
  return `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`
}

describe('LocalAgentPoller', () => {
  it('기간별 과거 세션 범위를 계산한다', () => {
    const now = new Date(2026, 6, 13, 22, 0, 0).getTime()
    expect(activityHistoryCutoff('recent', now)).toBe(now - 30 * 60 * 1000)
    expect(activityHistoryCutoff('today', now)).toBe(new Date(2026, 6, 13).getTime())
    expect(activityHistoryCutoff('7d', now)).toBe(now - 7 * 24 * 60 * 60 * 1000)
    expect(activityHistoryCutoff('all', now)).toBe(0)
  })

  it('최근 사용자 세션만 읽고 다음 스캔에서는 추가된 로그를 반영한다', () => {
    const home = mkdtempSync(join(tmpdir(), 'watchpup-agent-poller-'))
    roots.push(home)
    const now = Date.now()
    const date = new Date(now)
    const codexDir = join(
      home,
      '.codex',
      'sessions',
      String(date.getFullYear()),
      String(date.getMonth() + 1).padStart(2, '0'),
      String(date.getDate()).padStart(2, '0'),
    )
    const claudeDir = join(home, '.claude', 'projects', '-tmp-demo')
    const registryDir = join(home, '.claude', 'sessions')
    mkdirSync(codexDir, { recursive: true })
    mkdirSync(claudeDir, { recursive: true })
    mkdirSync(registryDir, { recursive: true })

    const codexId = '11111111-1111-4111-8111-111111111111'
    const subagentId = '22222222-2222-4222-8222-222222222222'
    const claudeId = '33333333-3333-4333-8333-333333333333'
    const sdkId = '44444444-4444-4444-8444-444444444444'
    const codexPath = join(codexDir, `rollout-${codexId}.jsonl`)
    writeFileSync(codexPath, jsonl([
      { timestamp: now, type: 'session_meta', payload: { id: codexId, thread_source: 'user', cwd: '/tmp/demo' } },
      { timestamp: now, type: 'event_msg', payload: { type: 'user_message', message: 'HUD를 구현해줘' } },
    ]))
    writeFileSync(join(codexDir, `rollout-${subagentId}.jsonl`), jsonl([
      { timestamp: now, type: 'session_meta', payload: { id: subagentId, thread_source: 'subagent' } },
      { timestamp: now, type: 'response_item', payload: { type: 'reasoning', summary: 'x'.repeat(560 * 1024) } },
      { timestamp: now, type: 'event_msg', payload: { type: 'user_message', message: '내부 조사' } },
    ]))
    writeFileSync(join(home, '.codex', 'session_index.jsonl'), jsonl([
      { id: codexId, thread_name: '통합 세션 HUD' },
    ]))

    writeFileSync(join(registryDir, `${claudeId}.json`), JSON.stringify({ sessionId: claudeId, cwd: '/tmp/demo', name: 'Claude UI 구현' }))
    writeFileSync(join(claudeDir, `${claudeId}.jsonl`), jsonl([
      { timestamp: now, type: 'user', sessionId: claudeId, entrypoint: 'claude-desktop', cwd: '/tmp/demo', message: { content: '상태 UI 만들어줘' } },
    ]))
    writeFileSync(join(claudeDir, `${sdkId}.jsonl`), jsonl([
      { timestamp: now, type: 'user', sessionId: sdkId, entrypoint: 'sdk-cli', cwd: '/tmp/demo', message: { content: 'Watchpup 내부 호출' } },
    ]))

    const poller = new LocalAgentPoller({ homeDir: home, now: () => now })
    const first = poller.scan()
    expect(first.map((row) => row.id).sort()).toEqual([
      `claude:${claudeId}`,
      `codex:${codexId}`,
    ])
    expect(first.find((row) => row.source === 'codex')).toMatchObject({ title: '통합 세션 HUD', state: 'running' })
    expect(first.find((row) => row.source === 'claude')).toMatchObject({ title: 'Claude UI 구현', state: 'running' })

    appendFileSync(codexPath, jsonl([
      { timestamp: now + 1_000, type: 'event_msg', payload: { type: 'task_complete', last_agent_message: '완료' } },
    ]))
    expect(poller.scan().find((row) => row.id === `codex:${codexId}`)).toMatchObject({ state: 'done', detail: '완료' })
  })

  it('실시간 목록에서 제외된 과거 세션도 기간 조회로 읽는다', async () => {
    const home = mkdtempSync(join(tmpdir(), 'watchpup-agent-history-'))
    roots.push(home)
    const now = new Date(2026, 6, 13, 22, 0, 0).getTime()
    const old = now - 2 * 24 * 60 * 60 * 1000
    const date = new Date(old)
    const codexDir = join(
      home,
      '.codex',
      'sessions',
      String(date.getFullYear()),
      String(date.getMonth() + 1).padStart(2, '0'),
      String(date.getDate()).padStart(2, '0'),
    )
    mkdirSync(codexDir, { recursive: true })
    const id = '55555555-5555-4555-8555-555555555555'
    const path = join(codexDir, `rollout-${id}.jsonl`)
    writeFileSync(path, jsonl([
      { timestamp: old, type: 'session_meta', payload: { id, thread_source: 'user', cwd: '/tmp/history' } },
      { timestamp: old, type: 'event_msg', payload: { type: 'user_message', message: '이전 세션 대화' } },
      { timestamp: old + 1_000, type: 'event_msg', payload: { type: 'task_complete', last_agent_message: '과거 작업 완료' } },
    ]))
    utimesSync(path, old / 1000, old / 1000)

    const poller = new LocalAgentPoller({ homeDir: home, now: () => now })
    expect(poller.scan()).toEqual([])
    expect(await poller.history('today')).toEqual([])
    expect(await poller.history('7d')).toEqual([
      expect.objectContaining({ id: `codex:${id}`, state: 'done', detail: '과거 작업 완료' }),
    ])
    expect(await poller.history('all')).toHaveLength(1)
  })
})
