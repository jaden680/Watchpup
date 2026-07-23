export function clampBubbleStackCount(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.max(1, Math.min(5, Math.round(parsed))) : 3
}

export function clampBubbleDurationSeconds(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.max(3, Math.min(60, Math.round(parsed))) : 10
}

export function bubbleEntriesToRemove(entries, maximum) {
  const working = [...entries]
  const removed = []
  const limit = clampBubbleStackCount(maximum)
  while (working.length > limit) {
    const removableIndex = working.findIndex((entry) => !entry.persistent)
    const index = removableIndex >= 0 ? removableIndex : 0
    removed.push(working[index])
    working.splice(index, 1)
  }
  return removed
}
