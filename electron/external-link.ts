import { parseSlackThreadPermalink } from '../src/core/slack/permalink.js'

export interface ExternalLinkDeps {
  openExternal(url: string): Promise<unknown>
  resolveSlackTeamId(): Promise<string | null>
}

export function isSlackMessagePermalink(url: string): boolean {
  try {
    parseSlackThreadPermalink(url)
    return true
  } catch {
    return false
  }
}

export function slackMessageDeepLink(permalink: string, teamId: string): string {
  const target = parseSlackThreadPermalink(permalink)
  const params = new URLSearchParams({
    team: teamId,
    id: target.channel,
    message: target.messageTs.replace('.', ''),
    thread_ts: target.threadTs,
  })
  return `slack://channel?${params.toString()}`
}

/** Slack 메시지는 native deep link로 열고, 필요한 정보나 앱이 없으면 permalink로 되돌린다. */
export async function openExternalLink(
  url: string,
  deps: ExternalLinkDeps,
  platform = process.platform,
): Promise<'slack-message' | 'external'> {
  if (platform === 'darwin' && isSlackMessagePermalink(url)) {
    const teamId = await deps.resolveSlackTeamId()
    if (teamId) {
      try {
        await deps.openExternal(slackMessageDeepLink(url, teamId))
        return 'slack-message'
      } catch {
        // Slack 미설치 등 custom protocol 실패 시 정확한 메시지를 여는 permalink를 유지한다.
      }
    }
  }

  await deps.openExternal(url)
  return 'external'
}
