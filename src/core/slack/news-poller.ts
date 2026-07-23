import type { WebClient } from '@slack/web-api'
import { logger } from '../observability/logger.js'
import { formatSlackPlain, getPermalink } from './context.js'
import { compareSlackTs, latestSlackTs } from './timestamp.js'

export const SLACK_NEWS_POLL_INTERVAL_SEC = 20 * 60

export interface SlackNewsConfig {
  enabled: boolean
  channels: string[]
  keywords: string[]
  myUserId?: string
}

export interface SlackNewsSubscription {
  key: string
  label: string
  query: string
}

export interface SlackNewsCandidate {
  id: string
  channel: string
  channelName: string
  messageTs: string
  text: string
  permalink: string
  matchedBy: string
  postedAt: number
}

interface SearchMatch {
  channel?: { id?: string; name?: string }
  ts?: string
  thread_ts?: string
  user?: string
  text?: string
  permalink?: string
}

function uniqueValues(values: string[], channel = false): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const value of values) {
    const trimmed = value.trim()
    const normalized = channel ? trimmed.replace(/^#+/, '') : trimmed
    const key = normalized.toLocaleLowerCase()
    if (!normalized || seen.has(key)) continue
    seen.add(key)
    result.push(normalized)
  }
  return result
}

function keywordQuery(keyword: string): string {
  return `"${keyword.replace(/"/g, '\\"')}"`
}

export function slackNewsSubscriptions(channels: string[], keywords: string[]): SlackNewsSubscription[] {
  return [
    ...uniqueValues(channels, true).map((name) => ({
      key: `channel:${name.toLocaleLowerCase()}`,
      label: `#${name}`,
      query: `in:${name}`,
    })),
    ...uniqueValues(keywords).map((keyword) => ({
      key: `keyword:${keyword.toLocaleLowerCase()}`,
      label: `키워드 “${keyword}”`,
      query: keywordQuery(keyword),
    })),
  ]
}

export class SlackNewsPoller {
  private timer: ReturnType<typeof setInterval> | null = null
  private polling = false
  private wasEnabled: boolean | undefined
  private activeSubscriptions = new Set<string>()

  constructor(
    private readonly client: WebClient,
    private readonly intervalSec: number,
    private readonly config: () => SlackNewsConfig,
    private readonly getCursor: (key: string) => string | undefined,
    private readonly setCursor: (key: string, ts: string) => void,
    private readonly onNews: (candidate: SlackNewsCandidate) => void | Promise<void>,
  ) {}

  start(): void {
    if (this.timer) return
    void this.pollNow()
    const intervalSec = Math.max(SLACK_NEWS_POLL_INTERVAL_SEC, this.intervalSec)
    this.timer = setInterval(() => void this.pollNow(), intervalSec * 1000)
    logger.info('SlackNewsPoller 시작', { intervalSec })
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  async pollNow(): Promise<void> {
    if (this.polling) return
    const config = this.config()
    if (!config.enabled) {
      this.wasEnabled = false
      this.activeSubscriptions.clear()
      return
    }
    const firstPoll = this.wasEnabled === undefined
    const resetBaseline = this.wasEnabled === false
    this.wasEnabled = true
    const subscriptions = slackNewsSubscriptions(config.channels, config.keywords)
    if (!subscriptions.length) {
      this.activeSubscriptions.clear()
      return
    }
    const nextSubscriptions = new Set(subscriptions.map((subscription) => subscription.key))

    this.polling = true
    try {
      for (const subscription of subscriptions) {
        const newlyAdded = !firstPoll && !this.activeSubscriptions.has(subscription.key)
        await this.pollSubscription(subscription, config.myUserId || '', resetBaseline || newlyAdded)
      }
      this.activeSubscriptions = nextSubscriptions
    } finally {
      this.polling = false
    }
  }

  private async pollSubscription(subscription: SlackNewsSubscription, myUserId: string, resetBaseline: boolean): Promise<void> {
    try {
      const response = (await this.client.search.messages({
        query: subscription.query,
        sort: 'timestamp',
        sort_dir: 'desc',
        count: 100,
      })) as { messages?: { matches?: SearchMatch[] } }
      const matches = response.messages?.matches ?? []
      const newest = latestSlackTs(matches.map((match) => match.ts))
      if (!newest) return

      const cursor = this.getCursor(subscription.key)
      if (resetBaseline || !cursor) {
        this.setCursor(subscription.key, newest)
        return
      }

      const fresh = matches
        .filter((match) => !!match.ts && compareSlackTs(match.ts!, cursor) > 0)
        .sort((a, b) => compareSlackTs(a.ts!, b.ts!))
      for (const match of fresh) {
        const channel = match.channel?.id
        const messageTs = match.ts
        if (!channel || !messageTs || !match.text?.trim()) continue
        if (match.thread_ts && match.thread_ts !== messageTs) continue
        if (myUserId && match.user === myUserId) continue
        const permalink = match.permalink || await getPermalink(this.client, channel, messageTs)
        if (!permalink) continue
        await this.onNews({
          id: `${channel}:${messageTs}`,
          channel,
          channelName: match.channel?.name || channel,
          messageTs,
          text: formatSlackPlain(match.text),
          permalink,
          matchedBy: subscription.label,
          postedAt: Math.round(Number(messageTs) * 1000) || Date.now(),
        })
      }
      this.setCursor(subscription.key, newest)
    } catch (error) {
      const detail = error as { data?: { error?: string } }
      logger.warn('Slack 소식 구독 폴링 실패', {
        subscription: subscription.label,
        err: detail?.data?.error || String(error),
      })
    }
  }
}
