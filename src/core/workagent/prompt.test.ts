import { describe, expect, it } from 'vitest'
import { extractProposalSummary, userNoteContent, workAgentPrompt, workAgentSystemPrompt, PLAN_FILE } from './prompt.js'
import type { WorkItem } from '../work/types.js'

function item(overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    id: 'r-1',
    title: '[iOS] 로띠 업데이트',
    notes: '<note>메모 내용</note>\nhttps://example.com',
    listId: 'list',
    listName: 'iOS 업무',
    account: 'iCloud',
    completed: false,
    childIds: [],
    depth: 0,
    links: [{ id: 'l1', kind: 'jira', title: 'APP-1', url: 'https://jira/APP-1', host: 'jira' }],
    ...overrides,
  }
}

describe('workAgentPrompt', () => {
  it('제목·메모·링크·서브태스크를 담는다', () => {
    const prompt = workAgentPrompt({
      item: item({ dueAt: Date.UTC(2026, 6, 30) }),
      subtasks: [item({ id: 'sub', title: '하위 작업', completed: true })],
    })
    expect(prompt).toContain('[iOS] 로띠 업데이트')
    expect(prompt).toContain('메모 내용')
    expect(prompt).toContain('[jira] APP-1: https://jira/APP-1')
    expect(prompt).toContain('- [x] 하위 작업')
    expect(prompt).toContain('2026-07-30')
    expect(prompt).toContain(PLAN_FILE)
  })
})

describe('workAgentSystemPrompt', () => {
  it('plan 전용 규칙을 담는다: 코드 수정 금지 + plan 파일 커밋 + push 금지', () => {
    const system = workAgentSystemPrompt()
    expect(system).toContain('코드를 수정하지 마라')
    expect(system).toContain(PLAN_FILE)
    expect(system).toContain('push')
    expect(system).toContain('한줄요약')
  })
})

describe('userNoteContent', () => {
  it('<note> 블록만 추출한다', () => {
    expect(userNoteContent('<note> 핵심 </note>\nhttps://a.b')).toBe('핵심')
    expect(userNoteContent('링크만 있음')).toBe('')
  })
})

describe('extractProposalSummary', () => {
  it('한줄요약 라인을 우선 사용한다 (마지막 것)', () => {
    const text = '조사 내용 정리\n한줄요약: 첫 요약\n추가 설명\n한줄요약: 최종 요약'
    expect(extractProposalSummary(text)).toBe('최종 요약')
  })

  it('한줄요약이 없으면 첫 줄을 자른다', () => {
    expect(extractProposalSummary('\n  첫 줄 내용\n둘째 줄')).toBe('첫 줄 내용')
    expect(extractProposalSummary('가'.repeat(200))).toHaveLength(120)
  })
})
