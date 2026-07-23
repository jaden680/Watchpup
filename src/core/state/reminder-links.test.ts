import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ReminderLinkStore, reminderKey } from './reminder-links.js'

describe('reminderKey', () => {
  it('channel:threadTs 형식으로 키를 만든다', () => {
    expect(reminderKey('C1', '100.000001')).toBe('C1:100.000001')
  })
})

describe('ReminderLinkStore', () => {
  it('없는 키는 undefined를 반환한다', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'watchpup-rl-')), 'reminder-links.json')
    const s = new ReminderLinkStore(path)
    expect(s.get('C1:100')).toBeUndefined()
  })

  it('set 후 get으로 그대로 읽힌다', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'watchpup-rl-')), 'reminder-links.json')
    const s = new ReminderLinkStore(path)
    s.set('C1:100', { reminderId: 'r-1', listId: 'l-1' })
    expect(s.get('C1:100')).toEqual({ reminderId: 'r-1', listId: 'l-1' })
  })

  it('새 인스턴스로 다시 읽어도 값이 유지된다(영속)', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'watchpup-rl-')), 'reminder-links.json')
    const s = new ReminderLinkStore(path)
    s.set('C1:100', { reminderId: 'r-1', listId: 'l-1' })
    const restored = new ReminderLinkStore(path)
    expect(restored.get('C1:100')).toEqual({ reminderId: 'r-1', listId: 'l-1' })
  })

  it('delete로 키가 제거된다', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'watchpup-rl-')), 'reminder-links.json')
    const s = new ReminderLinkStore(path)
    s.set('C1:100', { reminderId: 'r-1', listId: 'l-1' })
    s.delete('C1:100')
    expect(s.get('C1:100')).toBeUndefined()
    expect(new ReminderLinkStore(path).get('C1:100')).toBeUndefined()
  })
})
