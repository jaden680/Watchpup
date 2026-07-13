import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { StateStore } from './store.js'

describe('StateStore', () => {
  it('dedup: seen once, then remembered across reloads', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'watchpup-st-')), 'state.json')
    const s = new StateStore(path)
    expect(s.seen('m:C1:100')).toBe(false)
    s.markSeen('m:C1:100')
    expect(s.seen('m:C1:100')).toBe(true)
    expect(new StateStore(path).seen('m:C1:100')).toBe(true)
  })
  it('links thread to mention id', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'watchpup-st-')), 'state.json')
    const s = new StateStore(path)
    s.linkThread('C1:100', 'mid-1')
    expect(s.mentionIdFor('C1:100')).toBe('mid-1')
  })
  it('tracks thread cursor and persists across reloads', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'watchpup-st-')), 'state.json')
    const s = new StateStore(path)
    expect(s.getThreadCursor('C1:100.000001')).toBeUndefined()
    s.setThreadCursor('C1:100.000001', '100.000002')
    expect(s.getThreadCursor('C1:100.000001')).toBe('100.000002')
    expect(new StateStore(path).getThreadCursor('C1:100.000001')).toBe('100.000002')
  })
  it('never moves a thread cursor backwards', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'watchpup-st-')), 'state.json')
    const s = new StateStore(path)
    s.setThreadCursor('C1:100.000001', '100.000010')
    s.setThreadCursor('C1:100.000001', '100.000002')
    expect(s.getThreadCursor('C1:100.000001')).toBe('100.000010')
  })
  it('derives tracked threads from threadToMentionId, splitting on the first colon', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'watchpup-st-')), 'state.json')
    const s = new StateStore(path)
    s.linkThread('C1:100.000001', 'mid-1')
    s.linkThread('C2:200.000002', 'mid-2')
    expect(s.trackedThreads()).toEqual([
      { channel: 'C1', threadTs: '100.000001' },
      { channel: 'C2', threadTs: '200.000002' },
    ])
  })
})
