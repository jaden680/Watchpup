import { describe, expect, it } from 'vitest'
import { buildWorkPrompt, sameWorkItems, sortWorkItems, userNoteContent } from './work-support.js'

describe('Work support', () => {
  const items = [
    { id: 'B', title: 'Beta', dueAt: undefined, createdAt: 10, updatedAt: 30 },
    { id: 'A', title: 'Alpha', dueAt: 20, createdAt: 30, updatedAt: 10 },
  ]

  it('GoalBar 형식의 사용자 메모 블록만 읽는다', () => {
    expect(userNoteContent('jira\nhttps://x.test\n\n<note>\n사용자 메모\n</note>')).toBe('사용자 메모')
  })

  it('정렬 옵션과 수동 순서를 적용한다', () => {
    expect(sortWorkItems(items, 'dueDateThenTitle').map((item) => item.id)).toEqual(['A', 'B'])
    expect(sortWorkItems(items, 'createdNewest').map((item) => item.id)).toEqual(['A', 'B'])
    expect(sortWorkItems(items, 'manual', ['B', 'A']).map((item) => item.id)).toEqual(['B', 'A'])
  })

  it('서브태스크를 정렬된 부모 바로 아래에 배치한다', () => {
    const rows = [
      { id: 'C', title: 'Child', parentId: 'P' },
      { id: 'Z', title: 'Zulu' },
      { id: 'P', title: 'Parent' },
    ]
    expect(sortWorkItems(rows, 'titleAscending').map((item) => item.id)).toEqual(['P', 'C', 'Z'])
  })

  it('백그라운드 갱신에서 실제 데이터 변경을 구분한다', () => {
    expect(sameWorkItems(items, structuredClone(items))).toBe(true)
    expect(sameWorkItems(items, [{ ...items[0], title: 'Changed' }, items[1]])).toBe(false)
  })

  it('Reminder 식별자와 링크가 포함된 Codex 프롬프트를 만든다', () => {
    const prompt = buildWorkPrompt({
      item: { id: 'R1', title: '작업', notes: '<note>확인</note>', links: [{ kind: 'jira', title: 'APP-1', url: 'https://x.atlassian.net/browse/APP-1' }] },
      issueNumber: 2,
      listTitle: 'iCloud / iOS 업무',
    })
    expect(prompt).toContain('- Work issue: #2')
    expect(prompt).toContain('- ID: R1')
    expect(prompt).toContain('APP-1')
  })
})
