import type { ActivitySession, Mention } from '../types.js'
import { compactText } from './session-parser.js'

const RECENT_ACTIVITY_MS = 30 * 60 * 1000

export function slackActivities(mentions: Mention[], now = Date.now()): ActivitySession[] {
  return mentions
    .filter((mention) => mention.status !== 'dismissed' && now - mention.mentionedAt <= RECENT_ACTIVITY_MS)
    .map((mention) => {
      const state = mention.status === 'analyzing'
        ? 'running'
        : mention.status === 'ready' && !mention.readAt
          ? 'done'
          : 'waiting'
      const channel = mention.channelName ? `#${mention.channelName}` : mention.channel
      const author = mention.authorName || mention.authorId
      return {
        id: `slack:${mention.id}`,
        source: 'slack',
        sessionId: mention.id,
        title: compactText(mention.analysis?.headline || mention.text) || 'Slack 새 메시지',
        detail: [channel, author].filter(Boolean).join(' · '),
        state,
        updatedAt: mention.mentionedAt,
        canOpen: Boolean(mention.permalink),
      } satisfies ActivitySession
    })
}

export function mergeActivities(
  local: ActivitySession[],
  slack: ActivitySession[],
  now = Date.now(),
): ActivitySession[] {
  const byId = new Map<string, ActivitySession>()
  for (const activity of [...local, ...slack]) {
    if (now - activity.updatedAt > RECENT_ACTIVITY_MS && activity.state !== 'running') continue
    const previous = byId.get(activity.id)
    if (!previous || previous.updatedAt <= activity.updatedAt) byId.set(activity.id, activity)
  }
  return [...byId.values()].sort((a, b) => b.updatedAt - a.updatedAt)
}
