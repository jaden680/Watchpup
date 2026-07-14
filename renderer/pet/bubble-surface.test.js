import { describe, expect, it } from 'vitest'
import { bubbleSurfaceState, hudFoldContent } from './bubble-surface.js'

describe('bubbleSurfaceState', () => {
  it('HUD가 켜져 있어도 임시 메시지는 독립 말풍선으로 표시한다', () => {
    expect(bubbleSurfaceState({ active: true, showActivityHud: true, activityCount: 3 })).toEqual({
      bubbleVisible: true,
      hudMessageVisible: false,
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

  it('활동이 없으면 말풍선만 표시하고 빈 HUD는 숨긴다', () => {
    expect(bubbleSurfaceState({ active: true, showActivityHud: true, activityCount: 0 })).toEqual({
      bubbleVisible: true,
      hudMessageVisible: false,
      hudVisible: false,
    })
  })
})

describe('hudFoldContent', () => {
  it('세션 항목 수만 보여준다', () => {
    expect(hudFoldContent({ activityCount: 5, folded: true })).toEqual({
      count: 5,
      visibleLabel: '5',
      accessibleLabel: '항목 5개',
      actionLabel: '펼치기',
    })
  })

  it('펼친 상태에서는 접기 액션을 안내한다', () => {
    expect(hudFoldContent({ activityCount: 3, bubbleActive: false, folded: false })).toMatchObject({
      visibleLabel: '항목 3개',
      actionLabel: '접기',
    })
  })
})
