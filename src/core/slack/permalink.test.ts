import { describe, expect, it } from 'vitest'
import { parseSlackThreadPermalink } from './permalink.js'

describe('parseSlackThreadPermalink', () => {
  it('parses a root message permalink', () => {
    expect(parseSlackThreadPermalink('https://workspace.slack.com/archives/C012ABC34/p1712345678000100')).toEqual({
      channel: 'C012ABC34',
      threadTs: '1712345678.000100',
      messageTs: '1712345678.000100',
    })
  })

  it('uses thread_ts when a reply permalink is pasted', () => {
    expect(parseSlackThreadPermalink(
      'https://workspace.slack.com/archives/C012ABC34/p1712349999000200?thread_ts=1712345678.000100&cid=C012ABC34',
    )).toEqual({
      channel: 'C012ABC34',
      threadTs: '1712345678.000100',
      messageTs: '1712349999.000200',
    })
  })

  it('rejects non-Slack and malformed links', () => {
    expect(() => parseSlackThreadPermalink('https://example.com/archives/C1/p1712345678000100')).toThrow('slack.com')
    expect(() => parseSlackThreadPermalink('not-a-link')).toThrow('올바른 Slack')
    expect(() => parseSlackThreadPermalink('https://workspace.slack.com/client/T1/C1')).toThrow('링크 복사')
  })
})
