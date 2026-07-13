import { describe, expect, it } from 'vitest'
import { agentScrollTop } from './agent-scroll.js'

describe('agentScrollTop', () => {
  it('처음 연 세션은 최신 대화가 있는 맨 아래를 보여준다', () => {
    expect(agentScrollTop({
      sameActivity: false,
      previousTop: 0,
      previousHeight: 0,
      previousClientHeight: 0,
      nextHeight: 1200,
    })).toBe(1200)
  })

  it('아래를 보던 중 새 대화가 생기면 새 맨 아래를 따라간다', () => {
    expect(agentScrollTop({
      sameActivity: true,
      previousTop: 660,
      previousHeight: 1000,
      previousClientHeight: 320,
      nextHeight: 1280,
    })).toBe(1280)
  })

  it('위로 올려 읽는 중에는 기존 스크롤 위치를 유지한다', () => {
    expect(agentScrollTop({
      sameActivity: true,
      previousTop: 240,
      previousHeight: 1000,
      previousClientHeight: 320,
      nextHeight: 1280,
    })).toBe(240)
  })
})
