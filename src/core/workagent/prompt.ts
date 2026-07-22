/**
 * Work 자동 제안 프롬프트: work item(제목·메모·링크·서브태스크)을 에이전트 입력으로 직렬화.
 * renderer의 buildWorkPrompt(work-support.js)와 같은 정보 구성을 main 프로세스에서 사용한다.
 */
import type { WorkItem } from '../work/types.js'

const USER_NOTE = /<note>\s*([\s\S]*?)\s*<\/note>/i

export const PLAN_FILE = 'WATCHPUP-PLAN.md'

export function userNoteContent(notes = ''): string {
  return notes.match(USER_NOTE)?.[1]?.trim() || ''
}

export function workAgentSystemPrompt(): string {
  return [
    '너는 시니어 소프트웨어 엔지니어다. 주어진 git worktree 안에서만 작업한다.',
    '지금 단계는 구현이 아니라 계획 수립이다. 소스 코드를 수정하지 마라.',
    '작업에 첨부된 링크(Jira·Slack·Notion·GitHub 등)는 사용 가능한 도구로 읽고, 레포 코드는 Grep/Read로 조사해 맥락을 파악한다. 접근할 수 없는 링크는 건너뛰고 계획에 그 사실을 남긴다.',
    `조사 결과를 바탕으로 worktree 루트에 ${PLAN_FILE} 파일을 작성한다. 구성: 배경/목표, 관련 코드 위치(파일:라인), 단계별 구현 계획, 리스크와 열린 질문.`,
    `작업이 끝나면 반드시 \`git add -A && git commit -m "<간결한 한국어 커밋 메시지>"\` 로 커밋한다. 변경 파일은 ${PLAN_FILE} 하나여야 한다.`,
    '절대 push 하거나 PR을 만들지 말고, 다른 브랜치/다른 레포를 건드리지 마라. 이 계획은 사용자와 논의하기 위한 제안이다.',
    '마지막 응답은 무엇을 조사해 어떤 계획을 세웠는지 한국어 3~6줄로 정리하고, 맨 끝 줄에 `한줄요약: <80자 이내 핵심>` 형식 한 줄을 반드시 붙인다.',
  ].join('\n')
}

/** 계획 논의(채팅) 세션용 시스템 프롬프트 — 제안 세션을 resume해서 이어간다. */
export function workAgentChatSystemPrompt(): string {
  return [
    `사용자와 ${PLAN_FILE}의 계획에 대해 논의하는 중이다. 질문에는 근거(조사한 코드·링크)를 들어 답한다.`,
    `계획 수정 요청이면 ${PLAN_FILE}을 고치고 \`git add -A && git commit\` 으로 커밋한 뒤 무엇을 바꿨는지 알려준다.`,
    '소스 코드는 수정하지 마라. 절대 push 하거나 PR을 만들지 마라.',
    '답변은 한국어로 간결하게.',
  ].join('\n')
}

export function workAgentPrompt(input: { item: WorkItem; subtasks?: WorkItem[]; parent?: WorkItem | null }): string {
  const { item, subtasks = [], parent = null } = input
  const lines = [
    `아래 Watchpup Work 작업의 실행 계획을 이 worktree에서 미리 세워줘. 결과는 ${PLAN_FILE} 커밋으로 남긴다.`,
    '',
    '작업',
    `- ID: ${item.id}`,
    `- Title: ${item.title || '제목 없음'}`,
    `- List: ${item.account} / ${item.listName}`,
  ]
  if (parent) lines.push(`- Parent: ${parent.title || '제목 없음'} (${parent.id})`)
  if (item.dueAt) lines.push(`- Due: ${new Date(item.dueAt).toISOString()}`)

  const note = userNoteContent(item.notes)
  if (note) lines.push('', 'Note', note)
  if (item.links?.length) {
    lines.push('', 'Links')
    for (const link of item.links) lines.push(`- [${link.kind}] ${link.title}: ${link.url}`)
  }
  if (subtasks.length) {
    lines.push('', 'Subtasks')
    for (const subtask of subtasks) lines.push(`- [${subtask.completed ? 'x' : ' '}] ${subtask.title}`)
  }
  return lines.join('\n')
}

/** 에이전트 최종 텍스트에서 카드용 한 줄 요약을 뽑는다. `한줄요약:` 라인 우선, 없으면 첫 줄 축약. */
export function extractProposalSummary(text: string): string {
  const tagged = [...text.matchAll(/^한줄요약\s*[:：]\s*(.+)$/gm)].at(-1)?.[1]?.trim()
  if (tagged) return truncate(tagged, 120)
  const firstLine = text.split('\n').map((line) => line.trim()).find(Boolean) || ''
  return truncate(firstLine, 120)
}

function truncate(value: string, max: number): string {
  return value.length > max ? value.slice(0, max - 1) + '…' : value
}
