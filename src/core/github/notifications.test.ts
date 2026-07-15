import { describe, expect, it, vi } from 'vitest'
import {
  GithubPrNotificationPoller,
  GITHUB_PR_POLL_INTERVAL_MS,
  githubPrNaggingLine,
  parseUnreadGithubPrNotifications,
} from './notifications.js'

function notification(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: '123',
    unread: true,
    reason: 'review_requested',
    updated_at: '2026-07-15T03:00:00Z',
    repository: { full_name: 'owner/repo' },
    subject: {
      title: '확인할 PR',
      type: 'PullRequest',
      url: 'https://api.github.com/repos/owner/repo/pulls/42',
    },
    ...overrides,
  }
}

describe('GitHub PR notifications', () => {
  it('최근 72시간의 읽지 않은 PR만 최신순으로 만든다', () => {
    const now = Date.parse('2026-07-15T04:00:00Z')
    const result = parseUnreadGithubPrNotifications(JSON.stringify([
      notification(),
      notification({ id: 'old', updated_at: '2026-07-10T03:00:00Z' }),
      notification({ id: 'read', unread: false }),
      notification({ id: 'issue', subject: { title: '이슈', type: 'Issue', url: 'https://api.github.com/repos/owner/repo/issues/1' } }),
    ]), now)

    expect(result).toEqual([{
      id: '123',
      title: '확인할 PR',
      repository: 'owner/repo',
      number: 42,
      url: 'https://github.com/owner/repo/pull/42',
      reason: 'review_requested',
      updatedAt: Date.parse('2026-07-15T03:00:00Z'),
    }])
    expect(githubPrNaggingLine(result[0])).toContain('owner/repo #42')
  })

  it('활성화했을 때만 GitHub 알림 API를 조회한다', async () => {
    let enabled = false
    const gh = vi.fn().mockResolvedValue(JSON.stringify([notification()]))
    const onPr = vi.fn()
    const poller = new GithubPrNotificationPoller(
      () => ({ enabled }),
      onPr,
      gh,
      () => Date.parse('2026-07-15T04:00:00Z'),
    )

    await poller.pollNow()
    expect(gh).not.toHaveBeenCalled()
    enabled = true
    await poller.pollNow()
    expect(gh).toHaveBeenCalledWith(['api', 'notifications?all=false&participating=false&per_page=100'])
    expect(onPr).toHaveBeenCalledWith(expect.objectContaining({ number: 42 }))
    expect(GITHUB_PR_POLL_INTERVAL_MS).toBe(20 * 60 * 1000)
  })
})
