import { z } from 'zod'

export const mcpServerSchema = z.object({
  id: z.string().min(1).regex(/^[a-zA-Z0-9_]+$/),
  label: z.string().default(''),
  enabled: z.boolean().default(true),
  transport: z.enum(['stdio', 'http', 'sse', 'inherited']).default('stdio'),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  url: z.string().url().optional(),
  headers: z.record(z.string()).optional(),
  writeTools: z.array(z.string()).default([]),
  secretEnv: z.record(z.string()).optional(),
  env: z.record(z.string()).optional(),
})
export type McpServer = z.infer<typeof mcpServerSchema>

export const obsidianSchema = z.object({
  enabled: z.boolean().default(false),
  vaultPath: z.string().default(''),
  folder: z.string().default('watchpup'),
  useCli: z.boolean().default(false),
})

// Playbook = 액션 워크플로우 정의. 클릭 시 steps를 claude -p로 자율 수행.
// write:true면 실행 전 승인 필요, false면 바로 실행.
export const playbookSchema = z.object({
  id: z.string().min(1).regex(/^[a-zA-Z0-9._-]+$/),
  name: z.string().min(1),
  when: z.string().default(''), // 언제 쓰는지(제안 판단 근거)
  steps: z.string().default(''), // 무엇을 어떻게 (claude에게 줄 목표/절차)
  write: z.boolean().default(false),
  enabled: z.boolean().default(true),
})
export type Playbook = z.infer<typeof playbookSchema>

export function defaultPlaybooks(): Playbook[] {
  return [
    { id: 'reply', name: '답장 작성·게시', when: '스레드에 답장이 필요할 때', steps: '스레드 맥락과 사용자 입장에 맞는 답장을 작성해 해당 스레드에 게시하세요.', write: true, enabled: true },
    { id: 'summarize', name: '스레드 요약 정리', when: '길거나 복잡한 스레드의 핵심을 정리할 때', steps: '스레드의 결정사항·액션아이템·담당자를 불릿으로 정리하세요. 게시하지 말고 결과만 반환.', write: false, enabled: true },
    { id: 'investigate', name: '관련 자료 조사', when: '배경/근거/관련 문서가 필요할 때', steps: '사용 가능한 MCP·코드·웹에서 관련 근거를 조사해 출처와 함께 정리하세요. 쓰기 금지.', write: false, enabled: true },
    { id: 'code', name: '코드 원인 조사', when: '에러 원인·버그·구현 위치를 코드에서 찾아야 할 때', steps: '등록된 로컬 레포에서 Grep/Glob/Read로 관련 코드를 찾아, 원인 또는 구현 위치를 파일:라인 근거와 함께 설명하세요. 추측 금지, 실제 코드만 인용. 쓰기 금지.', write: false, enabled: true },
    { id: 'jira', name: '지라 티켓 생성', when: '작업/버그를 티켓으로 등록해야 할 때', steps: '프로젝트·이슈타입·제목·설명을 정리하고 Jira MCP로 티켓을 생성하세요.', write: true, enabled: false },
  ]
}

export const watchpupConfigSchema = z.object({
  botName: z.string().default('watchpup'),
  // Watchpup 페르소나/말투(자유서술) — 분석·답장·말풍선 톤에 반영. 빈 값이면 기본 톤.
  persona: z.string().default(''),
  // 말풍선 표시 방식: status(주제+상태 한 줄, 기본) | summary(핵심 요약 한 줄) | witty(페르소나 위트)
  bubbleStyle: z.enum(['status', 'summary', 'witty']).default('status'),
  model: z.string().default('opus'),
  maxBudgetUsd: z.number().min(0).default(0),
  requestTimeoutMs: z.number().int().positive().default(300_000),
  maxConcurrency: z.number().int().positive().max(20).default(2),
  sessionCacheMax: z.number().int().positive().default(128),
  sessionIdleMs: z.number().int().positive().default(3_600_000),
  threadFetchLimit: z.number().int().positive().max(1000).default(100),
  // 개인화: 감지 대상 = 나
  mySlackUserId: z.string().default(''),
  // 내가 참여한 스레드의 후속 메시지도 감지할지
  followThreads: z.boolean().default(true),
  // 멘션 감지원: 봇(소켓, 초대된 채널 즉시) / 내 계정 검색(전 채널 폴링)
  enableBot: z.boolean().default(true),
  enableUserSearch: z.boolean().default(false),
  searchIntervalSec: z.number().int().min(15).max(600).default(45),
  // 이 일수보다 오래된 메시지는 수집하지 않음(그룹 언급 등 과거 스레드가 뒤늦게 딸려오는 것 방지). 0=제한 없음
  ingestMaxAgeDays: z.number().min(0).max(90).default(7),
  // 내가 속한 유저그룹(@team) — 설정에서 검색·등록. 이 그룹들의 멘션도 감지.
  myGroups: z.array(z.object({ id: z.string().min(1), handle: z.string().default('') })).default([]),
  // 펫 캐릭터 세트(상태별 글리프). renderer/pet/themes.js 참조.
  petTheme: z.string().default('paw'),
  // 펫을 항상 다른 창 위에 표시할지 (off면 일반 창처럼 뒤로 갈 수 있음)
  petAlwaysOnTop: z.boolean().default(true),
  // 펫 표시 크기(%). 이모지·커스텀 이미지·Codex Pet에 공통 적용.
  petSizePercent: z.number().int().min(50).max(200).default(100),
  // 펫 위에 잠깐 표시되는 상태/분석 말풍선 크기(%).
  bubbleSizePercent: z.number().int().min(60).max(140).default(100),
  // 동시에 보이는 말풍선 최대 개수와 일반 말풍선 노출 시간.
  bubbleStackCount: z.number().int().min(1).max(5).default(3),
  bubbleDurationSeconds: z.number().int().min(3).max(60).default(10),
  // 펫 아래에 표시되는 Claude/Codex/Slack 세션 HUD 크기(%).
  hudSizePercent: z.number().int().min(60).max(140).default(100),
  // 펫·말풍선·HUD가 공유하는 가로 기준선. 화면 오른쪽 배치를 고려해 오른쪽이 기본.
  hudAlignment: z.enum(['left', 'right']).default('right'),
  // 세션 HUD를 화면에 표시할지. 수집은 이 값과 무관하게 계속된다.
  showActivityHud: z.boolean().default(false),
  // 베타: 선택한 Work 목록의 미완료 작업을 무작위 간격으로 말풍선에서 상기한다.
  naggingEnabled: z.boolean().default(false),
  naggingMinMinutes: z.number().int().min(1).max(120).default(5),
  naggingMaxMinutes: z.number().int().min(1).max(120).default(12),
  // 로컬 GitHub CLI의 읽지 않은 최근 PR 알림을 잔소리 후보에 섞는다.
  githubPrNaggingEnabled: z.boolean().default(true),
  // 구독한 Slack 채널·키워드의 새 루트 메시지를 무작위 잔소리에 섞는다.
  slackNewsEnabled: z.boolean().default(false),
  slackNewsChannels: z.array(z.string()).default(['all_전사공유', 'all_전사공지', 'all_random']),
  slackNewsKeywords: z.array(z.string()).default([]),
  // Xcode·Android Studio의 로컬 빌드 로그 변경을 감지해 완료 즉시 말풍선으로 알린다.
  buildAlertsEnabled: z.boolean().default(false),
  xcodeBuildAlertsEnabled: z.boolean().default(true),
  androidBuildAlertsEnabled: z.boolean().default(true),
  // Work 자동 제안(에이전트): 시간 날 때 Work 상위 작업의 실행 계획을 격리 worktree에서 미리 세워 제안.
  workAgentEnabled: z.boolean().default(false),
  workAgentProvider: z.enum(['claude', 'codex']).default('claude'),
  // 빈 값 = 전역 Claude 모델(model)을 따름
  workAgentModel: z.string().default(''),
  // 빈 값 = Codex CLI 기본 모델
  workAgentCodexModel: z.string().default(''),
  workAgentIntervalMinutes: z.number().int().min(5).max(240).default(30),
  // Orca가 설치·실행 중이면 제안 작업을 Orca 터미널에서 눈에 보이게 실행 (claude 전용, 없으면 헤드리스 폴백)
  workAgentUseOrca: z.boolean().default(true),
  // 브랜치명을 haiku로 영어 슬러그화 (호출 비용 소액 발생). 꺼져 있으면 work-<id축약> 형태
  workAgentEnglishBranch: z.boolean().default(false),
  // Work 탭에서 사용할 Apple Reminders 목록. Watchpup이 자체적으로 선택을 저장한다.
  reminderListId: z.string().default(''),
  reminderListName: z.string().default(''),
  reminderAccountName: z.string().default(''),
  reminderListSelectionExplicit: z.boolean().default(false),
  showCompletedReminders: z.boolean().default(false),
  reminderTaskSortOrder: z.enum(['manual', 'dueDateThenTitle', 'createdNewest', 'updatedNewest', 'titleAscending']).default('dueDateThenTitle'),
  reminderTaskManualOrder: z.array(z.string()).default([]),
  // 커스텀 펫 이미지 폴더(설정 시 이모지 대신 이미지 사용, 공모양 배경 제거).
  // 폴더에 idle/thinking/ready/chatting.(gif|png|apng|webp|jpg) 파일을 두면 상태별로 사용.
  petImageDir: z.string().default(''),
  // Codex Pet 팩 폴더(pet.json + 스프라이트시트). 설정 시 gif/이모지보다 우선.
  petCodexDir: z.string().default(''),
  // 코드 원인 조사용 로컬 레포 경로들 — claude가 Grep/Read로 접근(--add-dir)
  repos: z.array(z.string()).default([]),
  mcpServers: z.array(mcpServerSchema).default([]),
  playbooks: z.array(playbookSchema).default(() => defaultPlaybooks()),
  obsidian: obsidianSchema.default({}),
  workDir: z.string().default('./data/workdir'),
  dataDir: z.string().default('./data'),
  keychainService: z.string().default('watchpup'),
})

export type WatchpupConfig = z.infer<typeof watchpupConfigSchema>
export function parseConfig(input: unknown): WatchpupConfig {
  return watchpupConfigSchema.parse(input ?? {})
}
