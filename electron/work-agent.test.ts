import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { proposalResumeCommand, resolveWorkAgentRepo } from './work-agent.js'
import type { WorkProposal } from '../src/core/workagent/types.js'

describe('resolveWorkAgentRepo', () => {
  it('태스크별 지정 레포만 인정하고, 없거나 유효하지 않으면 null', () => {
    const root = mkdtempSync(join(tmpdir(), 'watchpup-repos-'))
    try {
      const preferred = join(root, 'preferred')
      mkdirSync(join(preferred, '.git'), { recursive: true })

      expect(resolveWorkAgentRepo(preferred)).toBe(preferred)
      expect(resolveWorkAgentRepo()).toBeNull()
      expect(resolveWorkAgentRepo('')).toBeNull()
      expect(resolveWorkAgentRepo(join(root, 'ghost'))).toBeNull()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('proposalResumeCommand', () => {
  it('provider·세션 유무에 맞는 명령을 만든다', () => {
    const base = { reminderId: 'r', status: 'ready', source: 'auto', branch: 'b', worktreePath: '/wt', repoPath: '/repo', startedAt: 1 } as WorkProposal
    expect(proposalResumeCommand({ ...base, provider: 'claude', sessionId: 'sid' })).toBe('claude --resume sid')
    expect(proposalResumeCommand({ ...base, provider: 'claude' })).toBe('claude --continue')
    expect(proposalResumeCommand({ ...base, provider: 'codex', sessionId: 'sid' })).toBe('codex resume sid')
  })
})
