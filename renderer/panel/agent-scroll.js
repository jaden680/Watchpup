const BOTTOM_THRESHOLD = 48

export function agentScrollTop({
  sameActivity,
  previousTop,
  previousHeight,
  previousClientHeight,
  nextHeight,
}) {
  if (!sameActivity) return nextHeight
  const distanceFromBottom = previousHeight - previousClientHeight - previousTop
  return distanceFromBottom <= BOTTOM_THRESHOLD ? nextHeight : previousTop
}
