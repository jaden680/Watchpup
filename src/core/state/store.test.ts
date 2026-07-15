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
  it('persists Work touch history and the next nagging schedule', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'watchpup-st-')), 'state.json')
    const s = new StateStore(path)
    s.touchWorkItem('work-1', 1_000_000)
    s.setNagging({ nextAt: 2_000_000, lastTaskId: 'work-1' })
    const restored = new StateStore(path)
    expect(restored.workTouchedAt()).toEqual({ 'work-1': 1_000_000 })
    expect(restored.get().nagging).toEqual({ nextAt: 2_000_000, lastTaskId: 'work-1' })
  })
  it('persists and acknowledges Agent and Calendar nagging state', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'watchpup-st-')), 'state.json')
    const s = new StateStore(path)
    s.setNaggingAgent({ activityId: 'codex:1', title: '작업', count: 1, completedAt: 1_000, dueAt: 2_000, repeatCount: 0, waiting: false })
    s.markNaggingCalendar('event:3000', 3_000)
    const restored = new StateStore(path)
    expect(restored.get().nagging?.agent?.activityId).toBe('codex:1')
    expect(restored.naggingCalendarNotified()).toEqual({ 'event:3000': 3_000 })
    restored.setNaggingAgent(undefined)
    expect(new StateStore(path).get().nagging?.agent).toBeUndefined()
  })
  it('persists Slack news cursors and de-duplicates pending news', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'watchpup-st-')), 'state.json')
    const s = new StateStore(path)
    const now = Date.now()
    const news = { id: 'C1:100', channel: 'C1', channelName: 'all_random', messageTs: '100', text: '소식', permalink: 'https://slack/100', matchedBy: '#all_random', postedAt: now }
    s.setNaggingSlackNewsCursor('channel:all_random', '100')
    s.setNaggingSlackNewsCursor('channel:all_random', '99')
    s.enqueueNaggingSlackNews(news)
    s.enqueueNaggingSlackNews(news)

    const restored = new StateStore(path)
    expect(restored.getNaggingSlackNewsCursor('channel:all_random')).toBe('100')
    expect(restored.naggingSlackNews(now)).toEqual([news])
    restored.dismissNaggingSlackNews(news.id)
    expect(new StateStore(path).naggingSlackNews(now)).toEqual([])
    restored.enqueueNaggingSlackNews(news)
    restored.clearNaggingSlackNews()
    expect(new StateStore(path).naggingSlackNews(now)).toEqual([])
  })
  it('persists the latest 100 nagging log entries in newest-first order', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'watchpup-st-')), 'state.json')
    const s = new StateStore(path)
    for (let i = 0; i < 105; i++) {
      s.appendNaggingLog({ at: i, kind: 'work', text: `잔소리 ${i}`, context: `work-${i}` })
    }

    const restored = new StateStore(path)
    expect(restored.naggingLog()).toHaveLength(100)
    expect(restored.naggingLog()[0]?.text).toBe('잔소리 104')
    expect(restored.naggingLog().at(-1)?.text).toBe('잔소리 5')
    restored.clearNaggingLog()
    expect(new StateStore(path).naggingLog()).toEqual([])
  })
  it('remembers the latest three distinct Work nags and migrates the previous task id', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'watchpup-st-')), 'state.json')
    const s = new StateStore(path)
    s.setNagging({ lastTaskId: 'old' })
    expect(s.naggingRecentTaskIds()).toEqual(['old'])

    for (const id of ['a', 'b', 'c', 'd', 'c']) s.rememberNaggingTask(id)
    const restored = new StateStore(path)
    expect(restored.naggingRecentTaskIds()).toEqual(['b', 'd', 'c'])
    expect(restored.get().nagging?.lastTaskId).toBe('c')
  })
})
