import { describe, expect, it } from 'vitest'
import { activityStateLabel, formatElapsed } from './activity-format.js'

describe('activity HUD format', () => {
  it('상태를 짧은 한국어로 표시한다', () => {
    expect(activityStateLabel('running')).toBe('작업 중')
    expect(activityStateLabel('error')).toBe('오류')
  })

  it('경과 시간을 분과 시간으로 줄인다', () => {
    expect(formatElapsed(90_000, 100_000)).toBe('방금')
    expect(formatElapsed(0, 15 * 60_000)).toBe('15분')
    expect(formatElapsed(0, 2 * 60 * 60_000)).toBe('2시간')
  })
})
