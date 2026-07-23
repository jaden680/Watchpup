import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8')
const settings = readFileSync(new URL('./settings.js', import.meta.url), 'utf8')

describe('pet bubble stack settings', () => {
  it('offers configurable stack count and display duration', () => {
    expect(html).toMatch(/name="bubbleStackCount"[^>]*min="1"[^>]*max="5"[^>]*value="3"/)
    expect(html).toMatch(/name="bubbleDurationSeconds"[^>]*min="3"[^>]*max="60"[^>]*value="10"/)
  })

  it('loads and saves both bubble stack settings', () => {
    expect(settings).toContain('cfg.bubbleStackCount ?? 3')
    expect(settings).toContain('cfg.bubbleDurationSeconds ?? 10')
    expect(settings).toContain('bubbleStackCount: boundedInteger')
    expect(settings).toContain('bubbleDurationSeconds: boundedInteger')
  })
})
