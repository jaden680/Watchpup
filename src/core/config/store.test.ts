import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConfigStore } from './store.js'

describe('ConfigStore', () => {
  it('applies defaults and persists updates', () => {
    const dir = mkdtempSync(join(tmpdir(), 'watchpup-cfg-'))
    const path = join(dir, 'watchpup.config.yaml')
    const s1 = new ConfigStore(path)
    expect(s1.get().botName).toBe('watchpup')
    expect(s1.get().maxConcurrency).toBe(2)
    expect(s1.get().petSizePercent).toBe(100)
    s1.update({ mySlackUserId: 'U123', model: 'sonnet', petSizePercent: 150 })
    const s2 = new ConfigStore(path)
    expect(s2.get().mySlackUserId).toBe('U123')
    expect(s2.get().model).toBe('sonnet')
    expect(s2.get().petSizePercent).toBe(150)
  })
})
