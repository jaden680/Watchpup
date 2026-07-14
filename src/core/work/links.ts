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

