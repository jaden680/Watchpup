import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { githubRepoName, proposalResumeCommand, resolveWorkAgentRepo } from './work-agent.js'
import type { WatchpupConfig } from '../src/core/config/schema.js'
import type { WorkItem } from '../src/core/work/types.js'
import type { WorkProposal } from '../src/core/workagent/types.js'

function gitRepo(root: string, name: string): string {
  const path = join(root, name)
  mkdirSync(join(path, '.git'), { recursive: true })
  return path
}

function item(links: WorkItem['links'] = []): WorkItem {
  return {
    id: 'r-1', title: '작업', notes: '', listId: 'l', listName: 'n', account: 'a',
    completed: false, childIds: [], depth: 0, links,
  }
}

describe('githubRepoName', () => {
  it('GitHub URL에서 레포 이름을 뽑는다', () => {
    expect(githubRepoName('https://github.com/kakaostyle/zigzag-ios/pull/12')).toBe('zigzag-ios')
    expect(githubRepoName('https://github.com/foo/Bar.git')).toBe('bar')
    expect(githubRepoName('https://example.com/foo/bar')).toBeNull()
  })
})

describe('resolveWorkAgentRepo', () => {
  it('태스크 지정 레포 → 링크 매칭 → 기본 레포 → 첫 레포 순서로 고른다', () => {
    const root = mkdtempSync(join(tmpdir(), 'watchpup-repos-'))
    try {
      const zigzag = gitRepo(root, 'zigzag-ios')
      const design = gitRepo(root, 'design-system-ios')
      const preferred = gitRepo(root, 'preferred')
      const config = { repos: [design, zigzag], workAgentRepo: '' } as unknown as WatchpupConfig
      const linked = item([{ id: 'l', kind: 'github', title: '', url: 'https://github.com/ks/zigzag-ios/pull/1', host: 'github.com' }])

      expect(resolveWorkAgentRepo(linked, config, preferred)).toBe(preferred)
      expect(resolveWorkAgentRepo(linked, config)).toBe(zigzag)
      expect(resolveWorkAgentRepo(item(), { ...config, workAgentRepo: zigzag } as WatchpupConfig)).toBe(zigzag)
      expect(resolveWorkAgentRepo(item(), config)).toBe(design)
      expect(resolveWorkAgentRepo(item(), { repos: [], workAgentRepo: '' } as unknown as WatchpupConfig)).toBeNull()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('proposalResumeCommand', () => {
  it('provider·세션 유무에 맞는 명령을 만든다', () => {
    const base = { reminderId: 'r', status: 'ready', source: 'auto', branch: 'b', worktreePath: '/wt', repoPath: '/repo', startedAt: 1 } as WorkProposal
    expect(proposalResumeCommand({ ...base, provider: 'claude', sessionId: 'sid' })).toBe('claude --resume sid')
    expect(proposalResumeCommand({ ...base, provider: 'claude' })).toBe('claude')
    expect(proposalResumeCommand({ ...base, provider: 'codex', sessionId: 'sid' })).toBe('codex resume sid')
  })
})
