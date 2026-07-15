import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { bubbleOpenTarget, bubbleSurfaceState, canIncomingBubbleReplaceStream, hudFoldContent } from './bubble-surface.js'

const petCss = readFileSync(new URL('./pet.css', import.meta.url), 'utf8')

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

describe('bubble layout', () => {
  it('창 높이가 갱신되기 전에도 말풍선 내용이 flex 축소되지 않는다', () => {
    expect(petCss).toMatch(/\.bubble\s*\{[^}]*flex:\s*0 0 auto;/s)
  })
})

describe('canIncomingBubbleReplaceStream', () => {
  it('텍스트가 오기 전 대기 placeholder는 실제 잔소리가 교체할 수 있다', () => {
    expect(canIncomingBubbleReplaceStream(true, '')).toBe(true)
  })

  it('실제 답변이 스트리밍 중이면 잔소리가 가로채지 않는다', () => {
    expect(canIncomingBubbleReplaceStream(true, '답변 작성 중')).toBe(false)
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

describe('bubbleOpenTarget', () => {
  it('잔소리 말풍선은 연결된 Work 상세를 연다', () => {
    expect(bubbleOpenTarget(null, 'work-1')).toEqual({ kind: 'work', id: 'work-1' })
  })

  it('Slack 멘션 연결을 Work보다 우선한다', () => {
    expect(bubbleOpenTarget('mention-1', 'work-1')).toEqual({ kind: 'mention', id: 'mention-1' })
  })

  it('Agent 완료 잔소리는 해당 세션 상세를 연다', () => {
    expect(bubbleOpenTarget(null, null, 'codex:1', false)).toEqual({ kind: 'activity', id: 'codex:1' })
  })

  it('캘린더 잔소리는 Calendar 앱을 연다', () => {
    expect(bubbleOpenTarget(null, null, null, true)).toEqual({ kind: 'calendar' })
  })

  it('캘린더 권한 안내는 개인정보 설정을 연다', () => {
    expect(bubbleOpenTarget(null, null, null, false, true)).toEqual({ kind: 'calendar-privacy' })
  })

  it('Slack 소식 잔소리는 원문 링크를 연다', () => {
    expect(bubbleOpenTarget(null, null, null, false, false, 'https://workspace.slack.com/archives/C1/p1')).toEqual({
      kind: 'external',
      url: 'https://workspace.slack.com/archives/C1/p1',
    })
  })
})
