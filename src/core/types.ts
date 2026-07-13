// ---- claude 스트림 (전송계층 독립) ----
export type AgentStreamEvent =
  | { type: 'system'; sessionId?: string; raw: unknown }
  | { type: 'progress'; text: string }
  | { type: 'tool'; name: string; input?: unknown }
  | { type: 'assistant_text'; text: string }
  | { type: 'result'; text: string; sessionId?: string; costUsd?: number; isError: boolean }
  | { type: 'error'; message: string }

export interface AgentResult {
  text: string
  sessionId?: string
  costUsd?: number
  isError: boolean
  toolsUsed: string[]
}

export interface SessionRecord {
  sessionId: string
  lastActiveAt: number
  turns: number
  lastSeenTs?: string
}

// ---- Watchpup 도메인 (신규) ----
export type MentionStatus = 'analyzing' | 'ready' | 'replied' | 'dismissed'

export interface Todo {
  text: string
  done: boolean
  /** 이 할 일을 watchpup가 대신 수행할 수 있으면 그 playbook id (있으면 UI에 "실행" 버튼) */
  playbookId?: string
}

/** 분석이 낸 할 일 한 건. playbookId가 있으면 자동 실행 가능. */
export interface TodoSpec {
  text: string
  playbookId?: string
}

/** Watchpup가 제안하는 행동 = 실행할 playbook(워크플로우) */
export interface SuggestedAction {
  label: string       // 사용자에게 보일 버튼 문구
  playbookId: string  // 매칭되는 playbook id
}

/** claude -p 가 구조화 출력해야 하는 분석 결과 */
export interface MentionAnalysis {
  headline: string     // 말풍선용 초단문(≤40자): 뭘 해야 하는지 / 핵심 한마디
  summary: string
  advice: string
  todos: TodoSpec[]    // 제안 할 일들 (playbookId 있으면 자동 실행 가능)
  draftReply: string   // Slack 답장 초안 (빈 문자열이면 답장 불필요)
  actions: SuggestedAction[] // 제안 행동(playbook). 없으면 빈 배열
  sources?: string[]   // 분석 중 실제 참조한 소스(예: 노션·코드·웹·슬랙). 라우팅 파악용
  category?: MentionCategory // 스레드 성격 분류(이슈/프로젝트/문의/잡담)
}

/** 스레드 성격 분류 — 목록 필터용 */
export type MentionCategory = 'issue' | 'project' | 'inquiry' | 'review' | 'share' | 'schedule' | 'chat'
export const MENTION_CATEGORIES: MentionCategory[] = ['issue', 'project', 'inquiry', 'review', 'share', 'schedule', 'chat']

/** 감지된 한 건의 멘션(스레드) — Obsidian 노트 1개에 대응 */
export interface Mention {
  id: string           // requestId (uuid)
  channel: string
  channelName?: string
  threadTs: string
  messageTs: string
  permalink?: string
  authorId: string     // 나를 멘션한 사람
  authorName?: string
  text: string         // 트리거 메시지 본문
  mentionedAt: number  // epoch ms
  status: MentionStatus
  sessionId?: string   // claude resume 세션 id
  analysis?: MentionAnalysis
  todos: Todo[]        // 사용자가 토글 가능한 상태 반영본
  readAt?: number      // 사용자가 확인(패널에서 열람)한 시각. 없으면 안 읽음
  direct?: boolean     // 마지막 갱신이 나를 직접 @멘션인지(true) vs 스레드 후속 답글(false)
  thread?: ThreadMsg[] // 스레드 대화(슬랙처럼 표시용). 최신 tail 위주
  rating?: number      // 이 분석 답변에 대한 사용자 만족도(1~5). 학습 신호
  tracked?: boolean    // 이 스레드의 후속을 계속 추적할지. false면 후속 폴링 제외(기본 추적)
}

/** 상세 뷰의 스레드 대화 한 줄 */
export interface ThreadMsg {
  author: string
  text: string
  mine: boolean  // 내가 쓴 메시지인지
  ts?: string    // Slack 메시지 ts(epoch 초.마이크로) — 시간 표시용
  reactions?: ThreadReaction[]
}

export interface ThreadReaction {
  name: string
  count: number
  reacted: boolean // 현재 연결된 사용자 토큰의 계정이 누른 리액션인지
}

// ---- Claude / Codex / Slack 통합 활동 HUD ----
export type ActivitySource = 'claude' | 'codex' | 'slack'
export type ActivityState = 'running' | 'done' | 'waiting' | 'error'

/** 펫 아래의 세션 HUD에 표시할 한 줄. 로컬 로그 경로는 렌더러로 내보내지 않는다. */
export interface ActivitySession {
  id: string
  source: ActivitySource
  sessionId: string
  title: string
  detail?: string
  state: ActivityState
  updatedAt: number
  contextPercent?: number
  canOpen: boolean
}

export type PetState = 'idle' | 'thinking' | 'ready' | 'chatting'
