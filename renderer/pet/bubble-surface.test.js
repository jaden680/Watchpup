import { describe, expect, it } from 'vitest'
import { bubbleSurfaceState } from './bubble-surface.js'

describe('bubbleSurfaceState', () => {
  it('말풍선 내용을 HUD가 켜진 동안 HUD에 통합한다', () => {
    expect(bubbleSurfaceState({ active: true, showActivityHud: true, activityCount: 3 })).toEqual({
      bubbleVisible: false,
      hudMessageVisible: true,
      hudVisible: true,
    })
  })

  it('HUD가 꺼지면 기존 말풍선으로 되돌린다', () => {
    expect(bubbleSurfaceState({ active: true, showActivityHud: false, activityCount: 3 })).toEqual({
      bubbleVisible: true,
      hudMessageVisible: false,
      hudVisible: false,
    })
  })

  it('활동이 없어도 활성 메시지가 있으면 HUD를 표시한다', () => {
    expect(bubbleSurfaceState({ active: true, showActivityHud: true, activityCount: 0 }).hudVisible).toBe(true)
  })
})
