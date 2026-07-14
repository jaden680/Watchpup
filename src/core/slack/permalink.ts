export interface SlackThreadTarget {
  channel: string
  threadTs: string
  messageTs: string
}

const SLACK_TS_RE = /^\d{10,}(?:\.\d{1,6})$/

function pathTimestamp(value: string): string | null {
  if (!/^\d{11,}$/.test(value)) return null
  return `${value.slice(0, 10)}.${value.slice(10)}`
}

/** Slack의 "링크 복사" URL에서 채널과 스레드 root ts를 추출한다. */
export function parseSlackThreadPermalink(input: string): SlackThreadTarget {
  let url: URL
  try {
    url = new URL(input.trim())
  } catch {
    throw new Error('올바른 Slack 메시지 링크를 입력해주세요.')
  }

  if (url.protocol !== 'https:' || !(url.hostname === 'slack.com' || url.hostname.endsWith('.slack.com'))) {
    throw new Error('slack.com 메시지 링크만 추가할 수 있습니다.')
  }

  const match = url.pathname.match(/\/archives\/([A-Z0-9]+)\/p(\d+)/i)
  const channel = match?.[1]?.toUpperCase()
  const messageTs = match?.[2] ? pathTimestamp(match[2]) : null
  const queryThreadTs = url.searchParams.get('thread_ts')
  const threadTs = queryThreadTs && SLACK_TS_RE.test(queryThreadTs) ? queryThreadTs : messageTs

  if (!channel || !messageTs || !threadTs) {
    throw new Error('Slack에서 메시지의 “링크 복사”로 얻은 주소를 입력해주세요.')
  }

  return { channel, threadTs, messageTs }
}
