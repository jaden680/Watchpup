import type { Mention } from '../types.js'

export interface MentionReminderLink {
  title: string
  url: string
}

/** 멘션 → Reminder 초안(제목/메모/링크/서브태스크). IPC 핸들러가 그대로 reminders.* 호출에 사용. */
export interface MentionReminderDraft {
  title: string
  notes: string
  links: MentionReminderLink[]
  subtasks: string[]
}

const HEADLINE_FALLBACK_LEN = 40

/** headline이 없을 때 본문에서 제목을 뽑는다: 줄바꿈/공백 정리 + 길이 제한 */
function summarizeText(text: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim()
  if (!normalized) return '멘션 처리'
  return normalized.length > HEADLINE_FALLBACK_LEN ? `${normalized.slice(0, HEADLINE_FALLBACK_LEN)}…` : normalized
}

/** 멘션을 work-support.js의 <note> 포맷에 맞는 Reminder 초안으로 변환하는 순수함수 */
export function buildMentionReminder(mention: Mention): MentionReminderDraft {
  const headline = mention.analysis?.headline?.trim()
  const title = headline || summarizeText(mention.text || '')

  const contextParts: string[] = []
  if (mention.authorName) contextParts.push(`작성자: ${mention.authorName}`)
  if (mention.channel) contextParts.push(`채널: #${mention.channel}`)
  const notes = contextParts.length ? `<note>${contextParts.join(' · ')}</note>` : ''

  const links: MentionReminderLink[] = mention.permalink ? [{ title: 'Slack', url: mention.permalink }] : []
  const subtasks = (mention.todos || [])
    .map((todo) => todo.text?.trim())
    .filter((text): text is string => Boolean(text))

  return { title, notes, links, subtasks }
}
