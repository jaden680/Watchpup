import { describe, expect, it, vi } from 'vitest'
import { openExternalLink, slackMessageDeepLink } from './external-link.js'

const permalink = 'https://workspace.slack.com/archives/C012ABC34/p1712345678000100?thread_ts=1712345000.000001'

describe('openExternalLink', () => {
  it('macOS의 Slack 메시지는 workspace·channel·message가 담긴 native deep link로 연다', async () => {
    const openExternal = vi.fn(async () => {})
    const resolveSlackTeamId = vi.fn(async () => 'T012TEAM')

    await expect(openExternalLink(permalink, { openExternal, resolveSlackTeamId }, 'darwin')).resolves.toBe('slack-message')
    expect(openExternal).toHaveBeenCalledWith(
      'slack://channel?team=T012TEAM&id=C012ABC34&message=1712345678000100&thread_ts=1712345000.000001',
    )
  })

  it('team ID가 없거나 Slack 앱을 열 수 없으면 원본 permalink로 fallback한다', async () => {
    const openExternal = vi.fn(async () => {})
    const resolveSlackTeamId = vi.fn(async () => null)

    await expect(openExternalLink(permalink, { openExternal, resolveSlackTeamId }, 'darwin')).resolves.toBe('external')
    expect(openExternal).toHaveBeenCalledWith(permalink)

    openExternal.mockReset()
    openExternal.mockRejectedValueOnce(new Error('Slack app not found')).mockResolvedValueOnce(undefined)
    resolveSlackTeamId.mockResolvedValueOnce('T012TEAM')

    await expect(openExternalLink(permalink, { openExternal, resolveSlackTeamId }, 'darwin')).resolves.toBe('external')
    expect(openExternal).toHaveBeenLastCalledWith(permalink)
  })

  it('일반 URL과 다른 플랫폼은 기존 외부 링크 동작을 유지한다', async () => {
    const openExternal = vi.fn(async () => {})
    const resolveSlackTeamId = vi.fn(async () => 'T012TEAM')

    await openExternalLink('https://github.com/jaden680/Watchpup', { openExternal, resolveSlackTeamId }, 'darwin')
    await openExternalLink(permalink, { openExternal, resolveSlackTeamId }, 'linux')

    expect(openExternal).toHaveBeenCalledTimes(2)
    expect(resolveSlackTeamId).not.toHaveBeenCalled()
  })

  it('답글 permalink에서 답글과 thread root를 함께 보존한다', () => {
    expect(slackMessageDeepLink(permalink, 'T012TEAM')).toContain('message=1712345678000100')
    expect(slackMessageDeepLink(permalink, 'T012TEAM')).toContain('thread_ts=1712345000.000001')
  })
})
