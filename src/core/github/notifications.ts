import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { promisify } from 'node:util'
import { logger } from '../observability/logger.js'

const execFileAsync = promisify(execFile)

export const GITHUB_PR_POLL_INTERVAL_MS = 20 * 60 * 1000
export const GITHUB_PR_RECENT_MS = 72 * 60 * 60 * 1000

export interface GithubPrNaggingItem {
  id: string
  title: string
  repository: string
  number: number
  url: string
  reason: string
  updatedAt: number
}

interface GithubNotification {
  id?: string
  unread?: boolean
  reason?: string
  updated_at?: string
  repository?: { full_name?: string }
  subject?: { title?: string; type?: string; url?: string | null }
}

export type GhRunner = (args: string[]) => Promise<string>

function ghBinary(): string {
  const candidates = [process.env.WATCHPUP_GH_BIN, '/opt/homebrew/bin/gh', '/usr/local/bin/gh']
  return candidates.find((candidate) => candidate && existsSync(candidate)) || 'gh'
}

export const runGh: GhRunner = async (args) => {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: ['/opt/homebrew/bin', '/usr/local/bin', process.env.PATH].filter(Boolean).join(':'),
  }
  delete env.GH_TOKEN
  delete env.GITHUB_TOKEN
  const { stdout } = await execFileAsync(ghBinary(), args, {
    env,
    timeout: 30_000,
    maxBuffer: 8 * 1024 * 1024,
  })
  return stdout
}

function pullRequestInfo(apiUrl: string): { number: number; url: string } | null {
  const match = apiUrl.match(/^https:\/\/api\.github\.com\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)$/)
  if (!match) return null
  return {
    number: Number(match[3]),
    url: `https://github.com/${match[1]}/${match[2]}/pull/${match[3]}`,
  }
}

export function parseUnreadGithubPrNotifications(
  raw: string,
  now = Date.now(),
  recentMs = GITHUB_PR_RECENT_MS,
): GithubPrNaggingItem[] {
  let notifications: GithubNotification[]
  try {
    const value = JSON.parse(raw) as unknown
    notifications = Array.isArray(value) ? value : []
  } catch {
    return []
  }

  const cutoff = now - recentMs
  return notifications.flatMap((notification): GithubPrNaggingItem[] => {
    if (!notification.unread || notification.subject?.type !== 'PullRequest') return []
    const id = notification.id?.trim()
    const title = notification.subject.title?.trim()
    const repository = notification.repository?.full_name?.trim()
    const updatedAt = Date.parse(notification.updated_at || '')
    const pull = pullRequestInfo(notification.subject.url || '')
    if (!id || !title || !repository || !pull || !Number.isFinite(updatedAt) || updatedAt < cutoff) return []
    return [{
      id,
      title,
      repository,
      number: pull.number,
      url: pull.url,
      reason: notification.reason || '',
      updatedAt,
    }]
  }).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 20)
}

export function githubPrNaggingLine(item: GithubPrNaggingItem, maxLength = 68): string {
  const compact = item.title.replace(/\s+/g, ' ').trim()
  const title = compact.length > maxLength
    ? `${compact.slice(0, Math.max(1, maxLength - 1)).trimEnd()}…`
    : compact
  return `GitHub에 아직 안 본 PR 있어요: “${title}” · ${item.repository} #${item.number}`
}

export class GithubPrNotificationPoller {
  private timer: ReturnType<typeof setInterval> | null = null
  private polling = false

  constructor(
    private readonly config: () => { enabled: boolean },
    private readonly onPr: (item: GithubPrNaggingItem) => void | Promise<void>,
    private readonly gh: GhRunner = runGh,
    private readonly now: () => number = Date.now,
  ) {}

  start(): void {
    if (this.timer) return
    void this.pollNow()
    this.timer = setInterval(() => void this.pollNow(), GITHUB_PR_POLL_INTERVAL_MS)
    logger.info('GitHub PR 잔소리 폴러 시작', { intervalMinutes: 20 })
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  async pollNow(): Promise<void> {
    if (this.polling || !this.config().enabled) return
    this.polling = true
    try {
      const raw = await this.gh(['api', 'notifications?all=false&participating=false&per_page=100'])
      for (const item of parseUnreadGithubPrNotifications(raw, this.now())) await this.onPr(item)
    } catch (error) {
      logger.warn('GitHub PR 알림 조회 실패', { err: error instanceof Error ? error.message : String(error) })
    } finally {
      this.polling = false
    }
  }
}
