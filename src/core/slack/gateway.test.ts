import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WatchpupGateway } from './gateway.js'
import { parseConfig } from '../config/schema.js'
import { SessionStore } from '../session/store.js'
import { Keychain } from '../secrets/keychain.js'
import { KeyedMutex } from '../session/locks.js'
import { Semaphore } from '../session/semaphore.js'
import { StateStore } from '../state/store.js'
import { MentionStore } from '../state/mentions.js'
import { LessonStore } from '../state/lessons.js'
import { AuditStore } from '../observability/audit.js'

function make() {
  const dir = mkdtempSync(join(tmpdir(), 'watchpup-gw-'))
  const config = parseConfig({ workDir: dir, dataDir: dir, mySlackUserId: 'U123' })
  const mentions = new MentionStore(join(dir, 'mentions.json'))
  const state = new StateStore(join(dir, 'state.json'))
  const gw = new WatchpupGateway({
    config, sessions: new SessionStore(join(dir, 's.json'), 128, 3_600_000),
    keychain: new Keychain('watchpup-test'), mutex: new KeyedMutex(), semaphore: new Semaphore(2),
    state, mentions,
    audit: new AuditStore(join(dir, 'audit.jsonl')),
    lessons: new LessonStore(join(dir, 'lessons.json')),
  })
  return { gw, mentions, state }
}

describe('WatchpupGateway.toggleTodo', () => {
  it('flips a todo done flag', () => {
    const { gw, mentions } = make()
    mentions.set('m1', {
      id: 'm1', channel: 'C1', threadTs: '1', messageTs: '1', authorId: 'U9', text: 't',
      mentionedAt: 0, status: 'ready', todos: [{ text: 'a', done: false }],
    })
    gw.toggleTodo('m1', 0)
    expect(mentions.get('m1')!.todos[0].done).toBe(true)
  })
})

describe('WatchpupGateway.setReaction', () => {
  it('adds a reaction through the user client and updates the cached thread', async () => {
    const { gw, mentions } = make()
    const add = vi.fn().mockResolvedValue({ ok: true })
    ;(gw as unknown as { userClient: { reactions: { add: typeof add; remove: ReturnType<typeof vi.fn> } } }).userClient = {
      reactions: { add, remove: vi.fn() },
    }
    mentions.set('m1', {
      id: 'm1', channel: 'C1', threadTs: '1', messageTs: '1', authorId: 'U9', text: 't',
      mentionedAt: 0, status: 'ready', todos: [],
      thread: [{ author: 'Kim', text: 'hello', mine: false, ts: '1.1', reactions: [] }],
    })

    const result = await gw.setReaction('m1', '1.1', 'eyes', true)

    expect(add).toHaveBeenCalledWith({ channel: 'C1', timestamp: '1.1', name: 'eyes' })
    expect(result.thread[0].reactions).toEqual([{ name: 'eyes', count: 1, reacted: true }])
  })
})

describe('WatchpupGateway.importThread', () => {
  const permalink = 'https://workspace.slack.com/archives/C012ABC34/p1712349999000200?thread_ts=1712345678.000100&cid=C012ABC34'

  it('re-enables tracking instead of importing a duplicate thread', async () => {
    const { gw, mentions, state } = make()
    mentions.set('m1', {
      id: 'm1', channel: 'C012ABC34', threadTs: '1712345678.000100', messageTs: '1712345678.000100',
      authorId: 'U9', text: 'old', mentionedAt: 0, status: 'ready', todos: [], tracked: false,
    })

    await expect(gw.importThread(permalink)).resolves.toEqual({ id: 'm1', existing: true })
    expect(mentions.get('m1')?.tracked).toBe(true)
    expect(state.mentionIdFor('C012ABC34:1712345678.000100')).toBe('m1')
  })

  it('resolves the root and schedules an explicit import without mention or age filters', async () => {
    const { gw } = make()
    const replies = vi.fn().mockResolvedValue({
      messages: [{ ts: '1712345678.000100', user: 'U9', text: '오래된 스레드' }],
    })
    const ingest = vi.fn().mockResolvedValue(undefined)
    ;(gw as unknown as { userClient: unknown }).userClient = { conversations: { replies } }
    ;(gw as unknown as { ingest: typeof ingest }).ingest = ingest

    const result = await gw.importThread(permalink)

    expect(result.existing).toBe(false)
    expect(result.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(replies).toHaveBeenCalledWith({ channel: 'C012ABC34', ts: '1712345678.000100', limit: 1 })
    await vi.waitFor(() => expect(ingest).toHaveBeenCalledOnce())
    expect(ingest.mock.calls[0][0]).toMatchObject({
      channel: 'C012ABC34',
      threadTs: '1712345678.000100',
      messageTs: '1712345678.000100',
      authorId: 'U9',
      text: '오래된 스레드',
      requestId: result.id,
      permalink,
    })
  })
})
