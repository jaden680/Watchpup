import { describe, expect, it } from 'vitest'
import { classifyWorkLink, parseGithubLink, parseJiraLink, parseWorkLinks } from './links.js'

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
