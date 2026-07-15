import { describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ClaudeModelCatalogService, parseClaudeModelMenu, type ClaudeModelCatalog } from './model-catalog.js'

const menu = `\x1b[H\r\x1b[8B\x1b[4GSelect model\r
\x1b[1B \x1b[4G  1.\x1b[9GDefault (recommended)  \x1b[32GSonnet 5\r
\x1b[3C\x1b[1B  2. Sonnet\x1b[32GSonnet 5\r
\x1b[3C\x1b[1B  3. Fable\x1b[32GFable 5\r
\x1b[3C\x1b[1B❯\x1b[6G4.\x1b[9GOpus\x1b[14G✔\x1b[32GOpus 4.8\r
\x1b[5C\x1b[1B5.\x1b[9GHaiku\x1b[32GHaiku 4.5\r`

describe('Claude model catalog', () => {
  it('Claude CLI /model 터미널 화면에서 선택지를 추출한다', () => {
    expect(parseClaudeModelMenu(menu)).toEqual([
      { value: 'default', label: 'Default (recommended)' },
      { value: 'sonnet', label: 'Sonnet' },
      { value: 'fable', label: 'Fable' },
      { value: 'opus', label: 'Opus' },
      { value: 'haiku', label: 'Haiku' },
    ])
  })

  it('CLI 버전과 함께 조회 결과를 캐시한다', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'watchpup-models-'))
    const cache = join(dir, 'models.json')
    let calls = 0
    const catalog: ClaudeModelCatalog = {
      options: [{ value: 'opus', label: 'Opus' }],
      cliVersion: '2.1.209',
      fetchedAt: '2026-07-15T00:00:00.000Z',
      source: 'cli',
    }
    const service = new ClaudeModelCatalogService(
      cache,
      async () => { calls += 1; return catalog },
      async () => '2.1.209',
    )

    const [first, second] = await Promise.all([service.get(), service.get()])
    expect(first).toEqual(catalog)
    expect(second).toEqual(catalog)
    expect((await service.get()).cached).toBe(true)
    expect(calls).toBe(1)
    expect(existsSync(cache)).toBe(true)
  })

  it('CLI 조회 실패 시 기본 모델 목록을 반환한다', async () => {
    const service = new ClaudeModelCatalogService(
      join(mkdtempSync(join(tmpdir(), 'watchpup-models-')), 'models.json'),
      async () => { throw new Error('offline') },
      async () => 'new-version',
    )

    const result = await service.get()
    expect(result.source).toBe('fallback')
    expect(result.options.map((option) => option.value)).toContain('haiku')
    expect(result.error).toBe('offline')
  })
})
