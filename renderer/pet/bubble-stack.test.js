import { describe, expect, it } from 'vitest'
import { bubbleEntriesToRemove, clampBubbleDurationSeconds, clampBubbleStackCount } from './bubble-stack.js'

describe('bubble stack settings', () => {
  it('uses safe defaults and clamps user values', () => {
    expect(clampBubbleStackCount(undefined)).toBe(3)
    expect(clampBubbleStackCount(0)).toBe(1)
    expect(clampBubbleStackCount(8)).toBe(5)
    expect(clampBubbleDurationSeconds(undefined)).toBe(10)
    expect(clampBubbleDurationSeconds(1)).toBe(3)
    expect(clampBubbleDurationSeconds(90)).toBe(60)
  })

  it('removes the oldest temporary bubbles before a streaming bubble', () => {
    const stream = { id: 'chat', persistent: true }
    const old = { id: 'old', persistent: false }
    const recent = { id: 'recent', persistent: false }
    const newest = { id: 'newest', persistent: false }
    expect(bubbleEntriesToRemove([stream, old, recent, newest], 3)).toEqual([old])
  })
})
