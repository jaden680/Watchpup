const STATE_LABELS = {
  running: '작업 중',
  done: '완료',
  waiting: '대기',
  error: '오류',
}

export function activityStateLabel(state) {
  return STATE_LABELS[state] || STATE_LABELS.waiting
}

export function formatElapsed(updatedAt, now = Date.now()) {
  const elapsed = Math.max(0, now - Number(updatedAt || 0))
  if (elapsed < 60_000) return '방금'
  const minutes = Math.floor(elapsed / 60_000)
  if (minutes < 60) return `${minutes}분`
  return `${Math.floor(minutes / 60)}시간`
}
