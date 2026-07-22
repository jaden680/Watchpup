// ---- Work 자동 제안(에이전트) 도메인 ----
// Work 탭 작업의 실행 계획(WATCHPUP-PLAN.md)을 격리 worktree에서 미리 세워 커밋해두고,
// 사용자가 계획을 확인·논의(채팅)할 수 있게 제안하는 기능의 타입. 코드 작업은 하지 않는다.

export type WorkAgentProvider = 'claude' | 'codex'

export type WorkProposalStatus = 'running' | 'ready' | 'failed'

/** 작업 1건에 대한 제안 결과. reminderId(=WorkItem.id)당 최대 1개. */
export interface WorkProposal {
  reminderId: string
  status: WorkProposalStatus
  /** 자동 폴러가 만든 제안인지, 사용자가 직접 실행한 것인지 */
  source: 'auto' | 'manual'
  provider: WorkAgentProvider
  model?: string
  /** 상세 카드에 보여줄 한 줄 요약 (계획 전문은 plan 파일에서 확인) */
  summary?: string
  branch: string
  worktreePath: string
  repoPath: string
  /** 분기 시점 커밋 — 커밋 수 계산 기준 */
  baseRev?: string
  /** 세션 재개용 id (claude --resume / codex resume) */
  sessionId?: string
  commits?: number
  filesChanged?: number
  startedAt: number
  finishedAt?: number
  error?: string
}

/** 태스크별 에이전트 설정. 비어있으면 전역 설정(workAgent*)을 따른다. */
export interface WorkTaskPrefs {
  /** false면 이 작업은 자동 제안 대상에서 제외 (기본 true) */
  auto?: boolean
  provider?: WorkAgentProvider
  model?: string
  /** 이 작업을 진행할 레포 경로. 비어있으면 링크 매칭 → 기본 레포 순으로 자동 결정 */
  repo?: string
}
