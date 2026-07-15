export function bubbleSurfaceState({ active, showActivityHud, activityCount }) {
  const useHud = !!showActivityHud
  const hasActivities = Number(activityCount) > 0
  return {
    bubbleVisible: !!active,
    hudMessageVisible: false,
    hudVisible: useHud && hasActivities,
  }
}

export function canIncomingBubbleReplaceStream(chatStreaming, chatBuffer) {
  return !chatStreaming || !String(chatBuffer || '').trim()
}

export function hudFoldContent({ activityCount, folded }) {
  const count = Math.max(0, Number(activityCount) || 0)
  const accessibleLabel = `항목 ${count}개`
  return {
    count,
    visibleLabel: folded ? String(count) : accessibleLabel,
    accessibleLabel,
    actionLabel: folded ? '펼치기' : '접기',
  }
}

export function bubbleOpenTarget(mentionId, workItemId, activityId, calendarEvent, calendarPrivacy, slackNewsUrl) {
  if (mentionId) return { kind: 'mention', id: mentionId }
  if (workItemId) return { kind: 'work', id: workItemId }
  if (activityId) return { kind: 'activity', id: activityId }
  if (slackNewsUrl) return { kind: 'external', url: slackNewsUrl }
  if (calendarPrivacy) return { kind: 'calendar-privacy' }
  if (calendarEvent) return { kind: 'calendar' }
  return { kind: 'panel' }
}
