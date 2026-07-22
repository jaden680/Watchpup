/**
 * Work 자동 제안 보조: 제안 세션 열기(Orca 우선 → Terminal.app 폴백) + 작업 레포 매칭.
 */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { basename, join } from 'node:path'
import { promisify } from 'node:util'
import type { WatchpupConfig } from '../src/core/config/schema.js'
import type { WorkItem } from '../src/core/work/types.js'
import type { WorkProposal } from '../src/core/workagent/types.js'
import { switchToOrcaTerminal } from './work-agent-orca.js'

const pexec = promisify(execFile)

/** 제안 세션을 이어서 열 셸 명령. claude는 세션 id가 없으면 그 worktree의 최근 세션을 잇는다. */
export function proposalResumeCommand(proposal: WorkProposal): string {
  if (proposal.provider === 'codex') {
    return proposal.sessionId ? `codex resume ${proposal.sessionId}` : 'codex'
  }
  return proposal.sessionId ? `claude --resume ${proposal.sessionId}` : 'claude --continue'
}

async function orcaAvailable(): Promise<boolean> {
  try {
    await pexec('orca', ['status', '--json'], { timeout: 4_000 })
    return true
  } catch {
    return false
  }
}

async function openInOrca(proposal: WorkProposal, command: string): Promise<boolean> {
  const terminalArgs = [
    'terminal', 'create',
    '--worktree', `path:${proposal.worktreePath}`,
    '--title', `watchpup ${proposal.branch.split('/').pop() || 'work'}`,
    '--command', command,
    '--json',
  ]
  try {
    await pexec('orca', terminalArgs, { timeout: 15_000 })
    return true
  } catch {
    // worktree가 Orca에 등록돼 있지 않으면 폴더를 등록한 뒤 한 번 더 시도
    try {
      await pexec('orca', ['repo', 'add', '--path', proposal.worktreePath, '--json'], { timeout: 15_000 })
      await pexec('orca', terminalArgs, { timeout: 15_000 })
      return true
    } catch {
      return false
    }
  }
}

async function openInTerminalApp(proposal: WorkProposal, command: string): Promise<void> {
  const shellCommand = `cd '${proposal.worktreePath.replace(/'/g, `'\\''`)}' && ${command}`
  const escaped = shellCommand.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  await pexec('osascript', [
    '-e', `tell application "Terminal" to do script "${escaped}"`,
    '-e', 'tell application "Terminal" to activate',
  ], { timeout: 10_000 })
}

/** 제안 세션 열기. 실행했던 Orca 터미널 → Orca 새 터미널 → Terminal.app 순으로 시도. */
export async function openProposalSession(proposal: WorkProposal): Promise<{ via: 'orca' | 'terminal' }> {
  if (!proposal.worktreePath || !existsSync(proposal.worktreePath)) {
    throw new Error('제안 worktree가 더 이상 존재하지 않아요. 다시 실행해주세요.')
  }
  const command = proposalResumeCommand(proposal)
  if (await orcaAvailable()) {
    if (await switchToOrcaTerminal(proposal)) return { via: 'orca' }
    if (await openInOrca(proposal, command)) return { via: 'orca' }
  }
  await openInTerminalApp(proposal, command)
  return { via: 'terminal' }
}

/** GitHub owner/repo 링크에서 repo 이름 추출 (매칭용). */
export function githubRepoName(url: string): string | null {
  const match = url.match(/github\.com\/[^/\s]+\/([^/\s?#]+)/i)
  return match ? match[1].replace(/\.git$/i, '').toLowerCase() : null
}

/**
 * 작업할 레포 결정: 태스크별 지정 레포 → 작업의 GitHub 링크와 등록 레포 이름 매칭
 * → 설정의 기본 레포 → 첫 등록 레포. 없으면 null.
 */
export function resolveWorkAgentRepo(item: WorkItem, config: WatchpupConfig, preferredRepo?: string): string | null {
  if (preferredRepo && existsSync(join(preferredRepo, '.git'))) return preferredRepo
  const repos = (config.repos ?? []).filter((path) => existsSync(join(path, '.git')))
  for (const link of item.links ?? []) {
    if (link.kind !== 'github') continue
    const name = githubRepoName(link.url)
    if (!name) continue
    const matched = repos.find((path) => basename(path).toLowerCase() === name)
    if (matched) return matched
  }
  if (config.workAgentRepo && existsSync(join(config.workAgentRepo, '.git'))) return config.workAgentRepo
  return repos[0] ?? null
}
