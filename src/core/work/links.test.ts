import { describe, expect, it } from 'vitest'
import { classifyWorkLink, parseGithubLink, parseJiraLink, parseWorkLinks, removeWorkLinkFromNotes, replaceWorkLinkInNotes } from './links.js'

describe('work links', () => {
  it('분류하고 같은 URL은 한 번만 남긴다', () => {
    const links = parseWorkLinks([
      '[티켓](https://team.atlassian.net/browse/APP-123)',
      'Slack https://workspace.slack.com/archives/C1/p123',
      '중복 https://team.atlassian.net/browse/APP-123',
      'https://github.com/acme/app/pull/42',
    ].join('\n'))
    expect(links.map((link) => link.kind)).toEqual(['jira', 'slack', 'github'])
    expect(links[0].title).toBe('티켓')
  })

  it('서비스 링크를 구조화한다', () => {
    expect(parseJiraLink('https://team.atlassian.net/browse/app-123')).toEqual({ site: 'https://team.atlassian.net', key: 'APP-123' })
    expect(parseGithubLink('https://github.com/acme/app/pull/42/files')).toEqual({ owner: 'acme', repo: 'app', number: 42, kind: 'pull' })
    expect(classifyWorkLink('https://example.com', 'Notion 문서')).toBe('notion')
  })
})

describe('removeWorkLinkFromNotes / replaceWorkLinkInNotes', () => {
  const notes = '<note>메모에 https://jira.example.com/browse/APP-1 언급</note>\n[Jira](https://jira.example.com/browse/APP-1)\nhttps://github.com/ks/zigzag-ios/pull/12'

  it('markdown 링크를 지우고 빈 줄을 정리한다', () => {
    const next = removeWorkLinkFromNotes(notes, 'https://jira.example.com/browse/APP-1')
    expect(next).not.toContain('[Jira]')
    expect(next).toContain('https://github.com/ks/zigzag-ios/pull/12')
    // <note> 블록 안의 같은 URL은 보존
    expect(next).toContain('메모에 https://jira.example.com/browse/APP-1 언급')
  })

  it('plain 링크를 지운다 (긴 URL의 접두어는 보호)', () => {
    const text = 'https://a.com/x\nhttps://a.com/x/sub'
    const next = removeWorkLinkFromNotes(text, 'https://a.com/x')
    expect(next).toBe('https://a.com/x/sub')
  })

  it('끝 슬래시 정규화 차이도 매칭한다', () => {
    expect(removeWorkLinkFromNotes('[홈](https://example.com)', 'https://example.com/')).toBe('')
  })

  it('매칭이 없으면 원본 그대로', () => {
    expect(removeWorkLinkFromNotes(notes, 'https://nowhere.com/x')).toBe(notes)
  })

  it('제목·URL을 수정한다 (같은 URL로 제목만 바꿔도 안전)', () => {
    const next = replaceWorkLinkInNotes(notes, 'https://jira.example.com/browse/APP-1', {
      title: '지라 티켓',
      url: 'https://jira.example.com/browse/APP-1',
    })
    expect(next).toContain('[지라 티켓](https://jira.example.com/browse/APP-1)')
    expect(next).not.toContain('[Jira]')
  })

  it('plain 링크를 markdown으로 바꾸며 수정한다', () => {
    const next = replaceWorkLinkInNotes(notes, 'https://github.com/ks/zigzag-ios/pull/12', {
      title: 'PR',
      url: 'https://github.com/ks/zigzag-ios/pull/13',
    })
    expect(next).toContain('[PR](https://github.com/ks/zigzag-ios/pull/13)')
    expect(next).not.toContain('pull/12')
  })
})
