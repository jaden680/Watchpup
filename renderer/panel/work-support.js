const USER_NOTE = /<note>\s*([\s\S]*?)\s*<\/note>/i

export function userNoteContent(notes = '') {
  return notes.match(USER_NOTE)?.[1]?.trim() || ''
}

export function sameWorkItems(left, right) {
  return JSON.stringify(left) === JSON.stringify(right)
}

function compareTitle(left, right) {
  return String(left.title || '').localeCompare(String(right.title || ''), 'ko', { sensitivity: 'base' })
}

function compareOptionalDate(left, right, key, descending = false) {
  const a = Number.isFinite(left[key]) ? left[key] : null
  const b = Number.isFinite(right[key]) ? right[key] : null
  if (a != null && b != null && a !== b) return descending ? b - a : a - b
  if (a != null && b == null) return -1
  if (a == null && b != null) return 1
  return compareTitle(left, right)
}

export function sortWorkItems(items, order = 'dueDateThenTitle', manualOrder = []) {
  const rows = [...items]
  let sorted
  if (order === 'manual') {
    const positions = new Map(manualOrder.map((id, index) => [id, index]))
    sorted = rows.sort((left, right) => {
      const a = positions.get(left.id)
      const b = positions.get(right.id)
      if (a != null && b != null) return a - b
      if (a != null) return -1
      if (b != null) return 1
      return compareOptionalDate(left, right, 'dueAt')
    })
  } else if (order === 'createdNewest') {
    sorted = rows.sort((a, b) => compareOptionalDate(a, b, 'createdAt', true))
  } else if (order === 'updatedNewest') {
    sorted = rows.sort((a, b) => compareOptionalDate(a, b, 'updatedAt', true))
  } else if (order === 'titleAscending') {
    sorted = rows.sort(compareTitle)
  } else {
    sorted = rows.sort((a, b) => compareOptionalDate(a, b, 'dueAt'))
  }
  return hierarchicalWorkItems(sorted)
}

function hierarchicalWorkItems(items) {
  const ids = new Set(items.map((item) => item.id))
  const children = new Map()
  for (const item of items) {
    if (!item.parentId || !ids.has(item.parentId)) continue
    const rows = children.get(item.parentId) || []
    rows.push(item)
    children.set(item.parentId, rows)
  }
  const result = []
  const visited = new Set()
  const append = (item) => {
    if (visited.has(item.id)) return
    visited.add(item.id); result.push(item)
    for (const child of children.get(item.id) || []) append(child)
  }
  for (const item of items) if (!item.parentId || !ids.has(item.parentId)) append(item)
  for (const item of items) append(item)
  return result
}

export function buildWorkPrompt({ item, issueNumber, listTitle, subtasks = [], parent = null }) {
  const lines = ['Watchpup Work 작업을 진행해줘.', '', '작업']
  if (issueNumber) lines.push(`- Work issue: #${issueNumber}`)
  lines.push(`- ID: ${item.id}`, `- Title: ${item.title || '제목 없음'}`, `- List: ${listTitle}`)
  if (parent) lines.push(`- Parent: ${parent.title || '제목 없음'} (${parent.id})`)
  if (item.dueAt) lines.push(`- Due: ${new Date(item.dueAt).toISOString()}`)

  const note = userNoteContent(item.notes)
  if (note) lines.push('', 'Note', note)
  if (item.links?.length) {
    lines.push('', 'Links')
    for (const link of item.links) lines.push(`- [${link.kind}] ${link.title}: ${link.url}`)
  }
  if (subtasks.length) {
    lines.push('', 'Subtasks')
    for (const subtask of subtasks) lines.push(`- [${subtask.completed ? 'x' : ' '}] ${subtask.title} (${subtask.id})`)
  }
  lines.push('', '진행 방식', '- 먼저 필요한 소스(Jira, Slack, GitHub, repo 파일)를 확인해줘.', '- 검증한 범위와 남은 리스크를 마지막에 알려줘.')
  return lines.join('\n')
}
