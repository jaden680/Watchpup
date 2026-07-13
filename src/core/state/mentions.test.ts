import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MentionStore } from './mentions.js'
import type { Mention } from '../types.js'

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'watchpup-mtn-'))
}

function mention(id: string, mentionedAt: number, patch: Partial<Mention> = {}): Mention {
  return {
    id,
    channel: 'C1',
    threadTs: '100.000001',
    messageTs: '100.000001',
    authorId: 'U1',
    text: '@나 확인해줘',
    mentionedAt,
    status: 'ready',
    todos: [],
    ...patch,
  }
}

describe('MentionStore', () => {
  it('set·get·all(최신순)·remove', () => {
    const s = new MentionStore(join(tmpDir(), 'mentions'))
    s.set('a', mention('a', 1))
    s.set('b', mention('b', 2))
    expect(s.get('b')?.id).toBe('b')
    expect(s.all().map((m) => m.id)).toEqual(['b', 'a']) // 최신순
    s.remove('a')
    expect(s.get('a')).toBeUndefined()
    expect(s.all().map((m) => m.id)).toEqual(['b'])
  })

  it('markRead: 최초 1회만 시각 기록, 이후 유지', () => {
    const s = new MentionStore(join(tmpDir(), 'mentions'))
    s.set('a', mention('a', 1))
    expect(s.unreadCount()).toBe(1)
    const first = s.markRead('a')?.readAt
    expect(first).toBeTypeOf('number')
    expect(s.unreadCount()).toBe(0)
    expect(s.markRead('a')?.readAt).toBe(first) // 재호출해도 최초 시각 유지
  })

  it('멘션마다 별도 파일로 저장 — 하나만 바뀌어도 그 파일만 갱신', () => {
    const dir = join(tmpDir(), 'mentions')
    const s = new MentionStore(dir)
    s.set('a', mention('a', 1))
    s.set('b', mention('b', 2))
    expect(existsSync(join(dir, 'a.json'))).toBe(true)
    expect(existsSync(join(dir, 'b.json'))).toBe(true)
    s.remove('b')
    expect(existsSync(join(dir, 'b.json'))).toBe(false)
    expect(existsSync(join(dir, 'a.json'))).toBe(true)
  })

  it('영속: 새 인스턴스로 재로드해도 유지', () => {
    const dir = join(tmpDir(), 'mentions')
    new MentionStore(dir).set('a', mention('a', 1))
    expect(new MentionStore(dir).get('a')?.id).toBe('a')
  })

  it('상한(500) 초과 시 오래된 것부터 메모리·디스크에서 정리', () => {
    const dir = join(tmpDir(), 'mentions')
    const s = new MentionStore(dir)
    for (let i = 0; i < 502; i++) s.set(`m${i}`, mention(`m${i}`, i))
    expect(s.all().length).toBe(500)
    expect(s.get('m0')).toBeUndefined() // 가장 오래된 것부터 제거
    expect(existsSync(join(dir, 'm0.json'))).toBe(false)
    expect(s.get('m501')?.id).toBe('m501') // 최신은 유지
    expect(readdirSync(dir).length).toBe(500)
  })

  it('구버전 mentions.json(단일 배열 파일)을 폴더 형식으로 1회 이전', () => {
    const base = tmpDir()
    const dir = join(base, 'mentions')
    const legacy = `${dir}.json` // 구버전이 쓰던 경로: <dir>.json
    writeFileSync(legacy, JSON.stringify([mention('old-1', 1), mention('old-2', 2)]), 'utf8')

    const s = new MentionStore(dir)
    expect(s.all().map((m) => m.id)).toEqual(['old-2', 'old-1'])
    expect(existsSync(join(dir, 'old-1.json'))).toBe(true)
    expect(existsSync(legacy)).toBe(false) // 이전 후 원본은 사라지고
    expect(existsSync(`${legacy}.bak`)).toBe(true) // .bak로 보존

    // 재이전 시도 없이 폴더 데이터 그대로 재로드
    expect(new MentionStore(dir).all().map((m) => m.id)).toEqual(['old-2', 'old-1'])
  })
})
