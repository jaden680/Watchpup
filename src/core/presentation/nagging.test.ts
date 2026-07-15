import { describe, expect, it } from 'vitest'
import {
  agentNaggingLine,
  agentNaggingPending,
  calendarEventKey,
  calendarNaggingLine,
  naggingLine,
  nextNaggingDelayMs,
  pickCalendarNaggingEvent,
  pickNaggingWorkItem,
  pickSlackNewsNagging,
  slackNewsNaggingLine,
} from './nagging.js'
import type { WorkItem } from '../work/types.js'
import type { ActivitySession } from '../types.js'

function item(id: string, title = id): WorkItem {
  return { id, title, notes: '', listId: 'list', listName: 'Work', account: 'iCloud', completed: false, childIds: [], depth: 0, links: [] }
}

describe('nagging presentation', () => {
  it('설정 범위 안에서 다음 잔소리 시각을 무작위로 정한다', () => {
    expect(nextNaggingDelayMs(5, 12, () => 0)).toBe(5 * 60_000)
    expect(nextNaggingDelayMs(5, 12, () => 0.5)).toBe(8.5 * 60_000)
    expect(nextNaggingDelayMs(12, 5, () => 0.9)).toBe(12 * 60_000)
  })

  it('최근 열어본 작업을 우선하고 직전 작업은 가능한 경우 피한다', () => {
    const now = Date.now()
    const items = [item('a'), item('b'), item('c')]
    const picked = pickNaggingWorkItem(items, { a: now - 1000, b: now - 2000 }, 'a', now, () => 0)
    expect(picked?.id).toBe('b')
  })

  it('작업이 없으면 일반 잔소리를 만든다', () => {
    expect(naggingLine(null, () => 0)).toBe('지금 벌여둔 작업 중 하나 잊은 건 없어요?')
  })

  it('병렬 Agent 작업이 모두 멈추면 확인 대상을 만든다', () => {
    const activities: ActivitySession[] = [
      { id: 'codex:a', source: 'codex', sessionId: 'a', title: 'UI 작업', state: 'done', updatedAt: 2_000, canOpen: true },
      { id: 'claude:b', source: 'claude', sessionId: 'b', title: '테스트 작업', state: 'done', updatedAt: 3_000, canOpen: true },
    ]
    const pending = agentNaggingPending(['codex:a', 'claude:b'], activities, 10_000)
    expect(pending).toMatchObject({ activityId: 'claude:b', count: 2, dueAt: 10_000, waiting: false })
    expect(agentNaggingLine(pending!, () => 0)).toBe('Agent 작업 2개 다 끝났는데 뭐해? 결과 확인해줘 👀')
  })

  it('5분 안에 시작하는 캘린더 일정을 한 번만 고른다', () => {
    const now = Date.parse('2026-07-15T03:00:00.000Z')
    const event = { id: 'event-1', title: '데일리', startAt: now + 5 * 60_000, endAt: now + 35 * 60_000, calendarName: 'Work' }
    expect(pickCalendarNaggingEvent([event], {}, now)).toEqual(event)
    expect(pickCalendarNaggingEvent([event], { [calendarEventKey(event)]: now }, now)).toBeNull()
    expect(calendarNaggingLine(event, now)).toBe('5분 뒤 “데일리” 일정이에요. 이제 스케줄 갈 준비~!')
  })

  it('대기 중인 Slack 소식을 무작위로 고르고 한 줄 말풍선으로 만든다', () => {
    const news = [
      { id: 'C1:1', channel: 'C1', channelName: 'all_random', messageTs: '1', text: '첫 소식', permalink: 'https://slack/1', matchedBy: '#all_random', postedAt: 1_000 },
      { id: 'C1:2', channel: 'C1', channelName: 'all_전사공지', messageTs: '2', text: '두 번째\n소식', permalink: 'https://slack/2', matchedBy: '#all_전사공지', postedAt: 2_000 },
    ]
    const picked = pickSlackNewsNagging(news, () => 0.9)
    expect(picked?.id).toBe('C1:2')
    expect(slackNewsNaggingLine(picked!)).toBe('#all_전사공지 새 소식! 두 번째 소식 · 보러갈래?')
  })
})
