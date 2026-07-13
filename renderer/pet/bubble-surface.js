export function bubbleSurfaceState({ active, showActivityHud, activityCount }) {
  const useHud = !!showActivityHud
  const hasActivities = Number(activityCount) > 0
  return {
    bubbleVisible: !!active && !useHud,
    hudMessageVisible: !!active && useHud,
    hudVisible: useHud && (!!active || hasActivities),
  }
}
