import { parseSlackThreadPermalink } from '../src/core/slack/permalink.js'

export const SLACK_MAC_BUNDLE_ID = 'com.tinyspeck.slackmacgap'

export interface ExternalLinkDeps {
  openExternal(url: string): Promise<unknown>
  openWithBundle(bundleId: string, url: string): Promise<unknown>
}

export function isSlackMessagePermalink(url: string): boolean {
  try {
    parseSlackThreadPermalink(url)
    return true
  } catch {
    return false
  }
}

/** Slack 메시지는 데스크톱 앱으로 바로 열고, 앱을 찾지 못하면 기본 브라우저로 되돌린다. */
export async function openExternalLink(
  url: string,
  deps: ExternalLinkDeps,
  platform = process.platform,
): Promise<'slack-app' | 'external'> {
  if (platform === 'darwin' && isSlackMessagePermalink(url)) {
    try {
      await deps.openWithBundle(SLACK_MAC_BUNDLE_ID, url)
      return 'slack-app'
    } catch {
      // Slack 미설치 등 LaunchServices 실패 시 기존 브라우저 동작을 유지한다.
    }
  }

  await deps.openExternal(url)
  return 'external'
}
