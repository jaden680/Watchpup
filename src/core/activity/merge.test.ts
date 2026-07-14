import { describe, expect, it } from 'vitest'
import type { ActivitySession, Mention } from '../types.js'
import { mergeActivities, slackActivities } from './merge.js'

function mention(patch: Partial<Mention> = {}): Mention {
  return {
    id: 'm1', channel: 'C1', channelName: 'ios', threadTs: '1', messageTs: '1', authorId: 'U1', authorName: 'Jack',
    text: '이 스레드 확인해줘', mentionedAt: 10_000, status: 'ready', todos: [], ...patch,
  }
}

describe('activity merge', () => {
  it('Slack 멘션을 출처가 있는 HUD 세션으로 변환한다', () => {
    expect(slackActivities([mention({ permalink: 'https://example.slack.com/archives/C1/p1' })], 11_000)[0]).toMatchObject({
      id: 'slack:m1', source: 'slack', title: '이 스레드 확인해줘', detail: '#ios · Jack', state: 'done', canOpen: true,
    })
  })

  it('permalink가 없는 Slack 항목은 원본 이동을 비활성화한다', () => {
    expect(slackActivities([mention()], 11_000)[0]?.canOpen).toBe(false)
  })

  it('최신 활동 순으로 Claude, Codex, Slack을 합친다', () => {
    const row = (id: string, updatedAt: number): ActivitySession => ({ id, source: 'codex', sessionId: id, title: id, state: 'done', updatedAt, canOpen: true })
    const merged = mergeActivities([row('codex:a', 9_000)], slackActivities([mention()], 11_000), 11_000)
    expect(merged.map((item) => item.id)).toEqual(['slack:m1', 'codex:a'])
  })
})
