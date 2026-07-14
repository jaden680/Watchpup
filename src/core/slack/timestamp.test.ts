import { describe, expect, it } from 'vitest'
import { compareSlackTs, latestSlackTs } from './timestamp.js'

describe('Slack timestamps', () => {
  it('compares and selects the latest message ts', () => {
    expect(compareSlackTs('100.000010', '100.000002')).toBeGreaterThan(0)
    expect(latestSlackTs(['100.000002', undefined, '100.000010'])).toBe('100.000010')
  })
})
