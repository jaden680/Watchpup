import { describe, expect, it } from 'vitest'
import { mapThreadReactions } from './context.js'

describe('mapThreadReactions', () => {
  it('keeps counts and marks reactions made by the current user', () => {
    expect(mapThreadReactions([
      { name: 'eyes', count: 3, users: ['U1', 'ME'] },
      { name: 'heart', count: 1, users: ['U2'] },
      { name: 'empty', count: 0, users: [] },
    ], 'ME')).toEqual([
      { name: 'eyes', count: 3, reacted: true },
      { name: 'heart', count: 1, reacted: false },
    ])
  })
})
