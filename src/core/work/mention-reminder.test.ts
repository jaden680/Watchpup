import { describe, expect, it } from 'vitest'
import { buildMentionReminder } from './mention-reminder.js'
import type { Mention } from '../types.js'

function mention(overrides: Partial<Mention> = {}): Mention {
  return {
    id: 'm1',
    channel: 'general',
    threadTs: '1',
    messageTs: '1',
    authorId: 'U1',
    text: '',
    mentionedAt: 0,
    status: 'ready',
    todos: [],
    ...overrides,
  }
}

describe('buildMentionReminder', () => {
  it('headline·작성자·채널·permalink·todos를 모두 반영한다', () => {
    const result = buildMentionReminder(mention({
      analysis: { headline: '버그 확인 요청', summary: '', advice: '', todos: [], draftReply: '', actions: [] },
      authorName: '지훈',
      channel: 'general',
      permalink: 'https://x.slack.com/archives/C1/p123',
      todos: [{ text: '로그 확인', done: false }, { text: '재현 시도', done: false }],
    }))
    expect(result.title).toBe('버그 확인 요청')
    expect(result.notes).toBe('<note>작성자: 지훈 · 채널: #general</note>')
    expect(result.links).toEqual([{ title: 'Slack', url: 'https://x.slack.com/archives/C1/p123' }])
    expect(result.subtasks).toEqual(['로그 확인', '재현 시도'])
  })

  it('headline이 없으면 본문을 요약하고 줄바꿈·긴 문장을 정리한다', () => {
    const result = buildMentionReminder(mention({
      text: '  줄바꿈이\n있는   아주 긴 문장입니다 '.repeat(3),
    }))
    expect(result.title).not.toMatch(/\n/)
    expect(result.title.length).toBeLessThanOrEqual(41) // 40자 + 말줄임표
    expect(result.title.endsWith('…')).toBe(true)
  })

  it('headline도 본문도 없으면 폴백 문구를 쓴다', () => {
    const result = buildMentionReminder(mention({ text: '' }))
    expect(result.title).toBe('멘션 처리')
  })

  it('작성자·permalink·todos가 없으면 빈 값으로 처리한다', () => {
    const result = buildMentionReminder(mention({ authorName: undefined, permalink: undefined, todos: [] }))
    expect(result.notes).toBe('<note>채널: #general</note>')
    expect(result.links).toEqual([])
    expect(result.subtasks).toEqual([])
  })

  it('빈 문자열 todo는 서브태스크에서 제외한다', () => {
    const result = buildMentionReminder(mention({ todos: [{ text: '   ', done: false }, { text: '실제 할 일', done: false }] }))
    expect(result.subtasks).toEqual(['실제 할 일'])
  })
})
