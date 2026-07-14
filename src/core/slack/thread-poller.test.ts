import { describe, expect, it } from 'vitest'
import { selectLatestHumanFollowup } from './thread-poller.js'

describe('selectLatestHumanFollowup', () => {
  it('coalesces multiple new replies into the latest human followup', () => {
    const result = selectLatestHumanFollowup([
      { ts: '100.000002', user: 'U1', text: 'first' },
      { ts: '100.000003', user: 'U2', text: 'second' },
      { ts: '100.000004', user: 'ME', text: 'mine' },
    ], '100.000001', 'ME')

    expect(result.followup).toMatchObject({ ts: '100.000003', text: 'second' })
    expect(result.maxTs).toBe('100.000004')
  })

  it('ignores messages at or before the saved cursor', () => {
    const result = selectLatestHumanFollowup([
      { ts: '100.000001', user: 'U1', text: 'old' },
      { ts: '100.000002', user: 'U2', text: 'seen' },
    ], '100.000002', 'ME')

    expect(result.followup).toBeUndefined()
    expect(result.maxTs).toBe('100.000002')
  })
})
