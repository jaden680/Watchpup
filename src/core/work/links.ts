import type { WorkLink, WorkLinkKind } from './types.js'

const MARKDOWN_LINK = /\[([^\]]+)]\((https?:\/\/[^)\s]+)\)/gi
const PLAIN_LINK = /https?:\/\/[^\s<>()]+/gi

function trimTrailingPunctuation(value: string): string {
  return value.replace(/[.,;:!?\]}]+$/g, '')
}
export function classifyWorkLink(value: string, label = ''): WorkLinkKind {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return 'web'
  }
  const host = url.hostname.toLowerCase()
  const path = url.pathname.toLowerCase()
  const hint = label.toLowerCase()
  if (hint.includes('jira') || host.includes('atlassian') || path.includes('/browse/')) return 'jira'
  if (hint.includes('github') || host === 'github.com' || host.endsWith('.github.com')) return 'github'
  if (hint.includes('slack') || host.endsWith('slack.com')) return 'slack'
  if (hint.includes('notion') || host.endsWith('notion.so') || host.endsWith('notion.site')) return 'notion'
  if (hint.includes('figma') || host.endsWith('figma.com')) return 'figma'
  return 'web'
}

function makeLink(urlText: string, label = ''): WorkLink | null {
  const normalized = trimTrailingPunctuation(urlText)
  try {
    const url = new URL(normalized)
    const kind = classifyWorkLink(url.toString(), label)
    const title = label.trim() || (kind === 'web' ? url.hostname : kind[0].toUpperCase() + kind.slice(1))
    return {
      id: `${kind}:${url.toString()}`,
      kind,
      title,
      url: url.toString(),
      host: url.hostname,
    }
  } catch {
    return null
  }
}

export function parseWorkLinks(text: string): WorkLink[] {
  const links: WorkLink[] = []
  const seen = new Set<string>()
  const markdownRanges: Array<[number, number]> = []
  for (const match of text.matchAll(MARKDOWN_LINK)) {
    const link = makeLink(match[2], match[1])
    if (link && !seen.has(link.url)) {
      seen.add(link.url)
      links.push(link)
    }
    if (typeof match.index === 'number') markdownRanges.push([match.index, match.index + match[0].length])
  }
  for (const match of text.matchAll(PLAIN_LINK)) {
    const index = match.index ?? -1
    if (markdownRanges.some(([start, end]) => index >= start && index < end)) continue
    const link = makeLink(match[0])
    if (link && !seen.has(link.url)) {
      seen.add(link.url)
      links.push(link)
    }
  }
  return links
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * notes 본문에서 특정 링크(markdown [제목](url) 또는 plain URL)를 replacement로 치환한다.
 * 사용자 메모(<note> 블록)는 건드리지 않고, 치환 결과 빈 줄이 되면 정리한다.
 * 매칭이 없으면 원본을 그대로 반환한다.
 */
function transformWorkLinkInNotes(notes: string, url: string, replacement: string): string {
  const target = url.trim()
  if (!target) return notes
  // <note> 블록을 자리표시자(NUL)로 치환해 보호
  const blocks: string[] = []
  const masked = notes.replace(/<note>[\s\S]*?<\/note>/gi, (block) => {
    blocks.push(block)
    return `\u0000${blocks.length - 1}\u0000`
  })
  // 치환 텍스트에 같은 URL이 들어가도(제목만 수정) 다시 매칭되지 않게 sentinel로 표시 후 마지막에 대입
  const sentinel = '\u0001'
  // URL.toString() 정규화로 끝 슬래시가 붙거나 빠졌을 수 있어 두 형태 모두 후보로
  const candidates = [...new Set([target, target.endsWith('/') ? target.slice(0, -1) : `${target}/`])]
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)
  let replaced = masked
  for (const candidate of candidates) {
    const escaped = escapeRegExp(candidate)
    // 더 긴 URL의 접두어를 지우지 않도록 URL 문자가 이어지면 매칭 제외
    replaced = replaced
      .replace(new RegExp(`\\[[^\\]]*]\\(${escaped}\\)`, 'gi'), sentinel)
      .replace(new RegExp(`${escaped}(?![^\\s<>()\\]])`, 'gi'), sentinel)
  }
  if (replaced === masked) return notes
  replaced = replaced.replaceAll(sentinel, replacement)
  const cleaned = replaced
    .split('\n')
    .filter((line) => line.trim() !== '')
    .join('\n')
  return cleaned.replace(/\u0000(\d+)\u0000/g, (_, index) => blocks[Number(index)]).trim()
}

/** notes에서 특정 링크 제거. 제거된 게 없으면 원본 그대로. */
export function removeWorkLinkFromNotes(notes: string, url: string): string {
  return transformWorkLinkInNotes(notes, url, '')
}

/** notes에서 특정 링크의 제목·URL을 수정. 매칭이 없으면 원본 그대로. */
export function replaceWorkLinkInNotes(notes: string, url: string, next: { title: string; url: string }): string {
  const title = next.title.trim().replace(/[[\]]/g, '')
  return transformWorkLinkInNotes(notes, url, `[${title || next.url}](${next.url})`)
}

export function parseJiraLink(value: string): { site: string; key: string } | null {
  try {
    const url = new URL(value)
    const match = url.pathname.match(/\/browse\/([A-Z][A-Z0-9_]+-\d+)/i)
    if (!match) return null
    return { site: url.origin, key: match[1].toUpperCase() }
  } catch {
    return null
  }
}

export function parseGithubLink(value: string): { owner: string; repo: string; number: number; kind: 'issue' | 'pull' } | null {
  try {
    const url = new URL(value)
    if (url.hostname.toLowerCase() !== 'github.com') return null
    const match = url.pathname.match(/^\/([^/]+)\/([^/]+)\/(issues|pull)\/(\d+)/i)
    if (!match) return null
    return {
      owner: match[1],
      repo: match[2],
      kind: match[3].toLowerCase() === 'pull' ? 'pull' : 'issue',
      number: Number(match[4]),
    }
  } catch {
    return null
  }
}
