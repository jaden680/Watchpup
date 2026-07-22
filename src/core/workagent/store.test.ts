import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkAgentStore } from './store.js'
import type { WorkProposal } from './types.js'

function tempPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'watchpup-workagent-')), 'work-agent.json')
}

function proposal(overrides: Partial<WorkProposal> = {}): WorkProposal {
  return {
    reminderId: 'r-1',
    status: 'ready',
    source: 'auto',
    provider: 'claude',
    branch: 'watchpup/work-r1-abc',
    worktreePath: '/tmp/wt',
    repoPath: '/tmp/repo',
    startedAt: 1,
    ...overrides,
  }
}

describe('WorkAgentStore', () => {
  it('제안을 저장하고 다시 읽는다 (재기동 포함)', () => {
    const path = tempPath()
    try {
      const store = new WorkAgentStore(path)
      store.setProposal(proposal({ summary: '계획 요약' }))
      expect(store.proposal('r-1')?.summary).toBe('계획 요약')

      const reloaded = new WorkAgentStore(path)
      expect(reloaded.proposal('r-1')?.branch).toBe('watchpup/work-r1-abc')
      expect(reloaded.proposals()).toHaveLength(1)
    } finally {
      rmSync(join(path, '..'), { recursive: true, force: true })
    }
  })

  it('재기동 시 running 제안은 failed로 정리한다', () => {
    const path = tempPath()
    try {
      const store = new WorkAgentStore(path)
      store.setProposal(proposal({ status: 'running' }))
      const reloaded = new WorkAgentStore(path)
      const found = reloaded.proposal('r-1')
      expect(found?.status).toBe('failed')
      expect(found?.error).toContain('재시작')
    } finally {
      rmSync(join(path, '..'), { recursive: true, force: true })
    }
  })

  it('removeProposal은 해당 항목만 지운다', () => {
    const path = tempPath()
    try {
      const store = new WorkAgentStore(path)
      store.setProposal(proposal({ reminderId: 'a' }))
      store.setProposal(proposal({ reminderId: 'b' }))
      store.removeProposal('a')
      expect(store.proposal('a')).toBeUndefined()
      expect(store.proposal('b')).toBeDefined()
    } finally {
      rmSync(join(path, '..'), { recursive: true, force: true })
    }
  })

  it('prefs는 병합하고 기본값과 같은 항목은 정리한다', () => {
    const path = tempPath()
    try {
      const store = new WorkAgentStore(path)
      store.setPrefs('r-1', { auto: false, provider: 'codex', model: 'gpt-5.5' })
      expect(store.prefs('r-1')).toEqual({ auto: false, provider: 'codex', model: 'gpt-5.5' })

      // auto=true(기본), provider·model 빈 값 → 항목 자체가 정리됨
      store.setPrefs('r-1', { auto: true, provider: undefined, model: '' })
      expect(store.prefs('r-1')).toEqual({})
    } finally {
      rmSync(join(path, '..'), { recursive: true, force: true })
    }
  })
})
