import { describe, it, expect } from 'vitest'
import { playbookActionPrompt, reminderPrompt } from './prompts.js'
import type { Playbook } from '../config/schema.js'

const pb: Playbook = { id: 'research', name: '관련 자료 조사', when: '', steps: '스레드 관련 자료를 찾아 정리', enabled: true, write: false }

describe('playbookActionPrompt', () => {
  it('추가 지시가 있으면 프롬프트에 우선 반영으로 포함', () => {
    const p = playbookActionPrompt({ playbook: pb, context: '맥락', extra: '표로 정리해줘' })
    expect(p).toContain('추가 지시')
    expect(p).toContain('표로 정리해줘')
  })

  it('추가 지시가 없으면 해당 줄을 넣지 않는다', () => {
    const p = playbookActionPrompt({ playbook: pb, context: '맥락' })
    expect(p).not.toContain('추가 지시(우선')
  })

  it('세션 재사용 대비 — JSON이 아닌 한국어 산문 보고를 명시', () => {
    const p = playbookActionPrompt({ playbook: pb, context: '맥락' })
    expect(p).toMatch(/JSON.*아니라|산문/)
  })
})

describe('reminderPrompt', () => {
  it('스레드 내용을 포함한다', () => {
    const p = reminderPrompt({ threadText: '스레드 원문 내용', authorName: '지훈' })
    expect(p).toContain('스레드 원문 내용')
    expect(p).toContain('지훈')
  })

  it('extra가 있으면 우선 반영 지시로 삽입', () => {
    const p = reminderPrompt({ threadText: 't', authorName: 'a', extra: '기한도 넣어줘' })
    expect(p).toContain('사용자 추가 지시(우선 반영)')
    expect(p).toContain('기한도 넣어줘')
  })

  it('extra가 없으면 해당 줄을 넣지 않는다', () => {
    const p = reminderPrompt({ threadText: 't', authorName: 'a' })
    expect(p).not.toContain('사용자 추가 지시')
  })

  it('title/notes/subtasks JSON 스키마만 출력하도록 지시한다', () => {
    const p = reminderPrompt({ threadText: 't', authorName: 'a' })
    expect(p).toContain('"title"')
    expect(p).toContain('"notes"')
    expect(p).toContain('"subtasks"')
  })

  it('dueDate 필드와 불명확 시 null 지시를 포함한다', () => {
    const p = reminderPrompt({ threadText: 't', authorName: 'a' })
    expect(p).toContain('"dueDate"')
    expect(p).toContain('null')
  })

  it('now가 없으면 오늘 날짜/연도 변환 지시를 넣지 않는다', () => {
    const p = reminderPrompt({ threadText: 't', authorName: 'a' })
    expect(p).not.toContain('오늘 날짜')
  })

  it('now가 있으면 오늘 날짜와 연도 변환 지시를 포함한다', () => {
    const p = reminderPrompt({ threadText: 't', authorName: 'a', now: '2026-07-15 (화)' })
    expect(p).toContain('오늘 날짜: 2026-07-15 (화)')
    expect(p).toContain('연도')
    expect(p).toContain('YYYY-MM-DD')
  })
})
