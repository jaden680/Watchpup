/** Slack message `ts` values are numeric strings and act as stable message IDs. */
export function compareSlackTs(a: string, b: string): number {
  const left = Number(a)
  const right = Number(b)
  if (Number.isFinite(left) && Number.isFinite(right)) return left - right
  return a.localeCompare(b)
}

export function latestSlackTs(values: Array<string | undefined>): string | undefined {
  let latest: string | undefined
  for (const value of values) {
    if (value && (!latest || compareSlackTs(value, latest) > 0)) latest = value
  }
  return latest
}
