import { describe, expect, it, vi } from 'vitest'
import { openExternalLink, SLACK_MAC_BUNDLE_ID } from './external-link.js'

const permalink = 'https://workspace.slack.com/archives/C012ABC34/p1712345678000100?thread_ts=1712345000.000001'

describe('openExternalLink', () => {
  it('macOS의 Slack 메시지는 Slack 앱을 직접 지정해 연다', async () => {
    const openExternal = vi.fn(async () => {})
    const openWithBundle = vi.fn(async () => {})

    await expect(openExternalLink(permalink, { openExternal, openWithBundle }, 'darwin')).resolves.toBe('slack-app')
    expect(openWithBundle).toHaveBeenCalledWith(SLACK_MAC_BUNDLE_ID, permalink)
    expect(openExternal).not.toHaveBeenCalled()
  })

  it('Slack 앱을 열 수 없으면 기본 브라우저로 fallback한다', async () => {
    const openExternal = vi.fn(async () => {})
    const openWithBundle = vi.fn(async () => { throw new Error('app not found') })

    await expect(openExternalLink(permalink, { openExternal, openWithBundle }, 'darwin')).resolves.toBe('external')
    expect(openExternal).toHaveBeenCalledWith(permalink)
  })

  it('일반 URL과 다른 플랫폼은 기존 외부 링크 동작을 유지한다', async () => {
    const openExternal = vi.fn(async () => {})
    const openWithBundle = vi.fn(async () => {})

    await openExternalLink('https://github.com/jaden680/Watchpup', { openExternal, openWithBundle }, 'darwin')
    await openExternalLink(permalink, { openExternal, openWithBundle }, 'linux')

    expect(openExternal).toHaveBeenCalledTimes(2)
    expect(openWithBundle).not.toHaveBeenCalled()
  })
})
