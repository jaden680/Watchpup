/**
 * Work 자동 제안 저장소: 제안 결과 + 태스크별 설정을 JSON으로 영속.
 * work item 본체는 Apple Reminders 소유이므로, watchpup는 제안/설정만 reminderId 키로 보관한다.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { PLAN_FILE, planSummary } from './prompt.js'
import type { WorkProposal, WorkTaskPrefs } from './types.js'

interface WorkAgentData {
  proposals: Record<string, WorkProposal>
  prefs: Record<string, WorkTaskPrefs>
}

const EMPTY: WorkAgentData = { proposals: {}, prefs: {} }

export class WorkAgentStore {
  private data: WorkAgentData

  constructor(private readonly path: string) {
    this.data = existsSync(path)
      ? { ...structuredClone(EMPTY), ...(JSON.parse(readFileSync(path, 'utf8')) as Partial<WorkAgentData>) }
      : structuredClone(EMPTY)
    // 앱이 꺼지며 중단된 실행 정리: 계획 파일이 이미 있으면 준비됨으로 복구,
    // 아니면 실패 처리(외부 세션이 계속 돌고 있을 수 있어 세션 열기를 안내).
    let dirty = false
    for (const proposal of Object.values(this.data.proposals)) {
      if (proposal.status !== 'running') continue
      dirty = true
      proposal.finishedAt = proposal.finishedAt ?? Date.now()
      const planPath = proposal.worktreePath ? join(proposal.worktreePath, PLAN_FILE) : ''
      if (planPath && existsSync(planPath)) {
        proposal.status = 'ready'
        try {
          proposal.summary = planSummary(readFileSync(planPath, 'utf8')) || proposal.summary
        } catch { /* 요약 없이 복구 */ }
        continue
      }
      proposal.status = 'failed'
      proposal.error = proposal.worktreePath
        ? '앱이 재시작되어 추적이 중단되었어요. 세션이 아직 진행 중일 수 있어요 — "세션 열기"로 확인해보세요.'
        : '앱이 재시작되어 실행이 중단되었어요.'
    }
    if (dirty) this.persist()
  }

  private persist(): void {
    mkdirSync(dirname(this.path), { recursive: true })
    writeFileSync(this.path, JSON.stringify(this.data, null, 2), 'utf8')
  }

  proposal(reminderId: string): WorkProposal | undefined {
    const found = this.data.proposals[reminderId]
    return found ? structuredClone(found) : undefined
  }

  proposals(): WorkProposal[] {
    return Object.values(structuredClone(this.data.proposals))
  }

  setProposal(proposal: WorkProposal): void {
    this.data.proposals[proposal.reminderId] = structuredClone(proposal)
    this.persist()
  }

  removeProposal(reminderId: string): void {
    if (!(reminderId in this.data.proposals)) return
    delete this.data.proposals[reminderId]
    this.persist()
  }

  prefs(reminderId: string): WorkTaskPrefs {
    return structuredClone(this.data.prefs[reminderId] ?? {})
  }

  setPrefs(reminderId: string, patch: WorkTaskPrefs): WorkTaskPrefs {
    const merged: WorkTaskPrefs = { ...this.data.prefs[reminderId], ...patch }
    // 기본값과 같은 항목은 지워서 파일을 깔끔하게 유지
    if (merged.auto !== false) delete merged.auto
    if (!merged.provider) delete merged.provider
    if (!merged.model?.trim()) delete merged.model
    if (!merged.repo?.trim()) delete merged.repo
    if (Object.keys(merged).length) this.data.prefs[reminderId] = merged
    else delete this.data.prefs[reminderId]
    this.persist()
    return structuredClone(merged)
  }
}
