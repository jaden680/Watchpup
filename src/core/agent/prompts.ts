/**
 * Watchpup 분석용 시스템/유저 프롬프트 빌더 (순수 함수).
 */
import type { Playbook } from '../config/schema.js'

export function watchpupSystemPrompt(botName: string, persona?: string): string {
  const p = (persona ?? '').trim()
  return [
    `당신은 "${botName}", 사용자 개인의 업무 비서입니다.`,
    p ? `페르소나/말투: ${p} (이 톤을 요약·조언·답장 초안 전반에 자연스럽게 반영)` : '',
    'Slack에서 사용자가 멘션된 스레드를 읽고, 사용자를 대신해 상황을 분석합니다.',
    '노션/코드/웹 등 사용 가능한 MCP 도구로 필요한 맥락을 스스로 조사하세요. 쓰기 작업은 하지 마세요.',
    '반드시 아래 JSON만 출력하세요(코드펜스 없이, 다른 텍스트 금지):',
    '{"category":"이 스레드의 성격 — issue|project|inquiry|review|share|schedule|chat 중 하나","headline":"펫 말풍선용 초단문(20자 이내, 명사구로 사용자가 뭘 해야 하는지 딱 한마디. 예: \\"답장 필요\\", \\"검토 요청\\", \\"결정 대기\\", \\"확인만\\")","summary":"스레드 요약","advice":"사용자가 취할 조언","todos":[{"text":"할 일","playbookId":"이 할 일을 watchpup가 대신 수행할 수 있는 playbook id (해당 없으면 생략)"}],"draftReply":"사용자가 스레드에 남길 답장 초안(불필요하면 빈 문자열)","actions":[{"label":"버튼 문구","playbookId":"적용할 playbook id"}]}',
    'category 분류 기준: issue=버그·장애·오류·문제 해결 / project=기능·작업 진행·기획·설계 / inquiry=질문·요청·확인·정보 문의 / review=검토·승인·리뷰 요청(내가 판단·승인해야 함) / share=공지·FYI·문서/링크 공유·진행상황 업데이트(내 행동 불필요한 정보성) / schedule=미팅·일정 조율·초대 / chat=순수 잡담·인사 등 그 외. 정보 공유성이면 chat이 아니라 share로 분류.',
    'todos 각 항목의 playbookId: 그 할 일이 아래 playbook 중 하나로 watchpup가 대신 수행 가능하면 그 id를 넣고(예: "코드에서 원인 조사"→code, "정리 노트 작성"→노션 playbook), 사람이 직접 해야 하는 일이면 playbookId를 생략하세요.',
    'actions에는 아래 제공된 playbook 중 이 상황에 적합한 것만 0~3개 고르세요. 없으면 빈 배열. playbookId(todos·actions 공통)는 반드시 제공된 목록의 id와 일치해야 합니다.',
  ].filter(Boolean).join('\n')
}

function playbooksSection(playbooks: Playbook[]): string {
  const enabled = playbooks.filter((p) => p.enabled)
  if (!enabled.length) return '사용 가능한 playbook 없음 → actions는 빈 배열.'
  const lines = enabled.map((p) => `- id:${p.id} | ${p.name} | 언제: ${p.when}${p.write ? ' | (쓰기)' : ''}`)
  return ['사용 가능한 playbook(행동 제안 후보):', ...lines].join('\n')
}

/** 자가발전으로 축적된 교훈을 프롬프트에 주입(최신 우선, 상위 몇 개). */
function lessonsSection(lessons?: string[]): string {
  const ls = (lessons ?? []).filter(Boolean).slice(0, 8)
  if (!ls.length) return ''
  return ['', '지난 실행에서 배운 점(반드시 반영):', ...ls.map((l) => `- ${l}`)].join('\n')
}

/** 액션(playbook) 실행 프롬프트: 목표(steps)를 수행하도록 지시 */
export function playbookActionPrompt(args: { playbook: Playbook; context: string; lessons?: string[]; extra?: string }): string {
  const p = args.playbook
  const extra = (args.extra || '').trim()
  return [
    `아래 작업을 사용자를 대신해 수행하세요. 작업명: ${p.name}`,
    `목표/절차: ${p.steps}`,
    p.write
      ? '이 작업은 쓰기(게시/생성)가 허용되었습니다. 승인된 범위 내에서만 수행하세요.'
      : '읽기 전용입니다. 쓰기 도구는 사용하지 말고 결과만 정리해 반환하세요.',
    extra ? `이번 실행에 대한 사용자의 추가 지시(우선 반영): ${extra}` : '',
    lessonsSection(args.lessons),
    '--- 맥락 ---',
    args.context,
    '--- 끝 ---',
    // 앞선 멘션 분석 턴에서 JSON 스키마로 답했더라도, 이 응답은 그 형식을 따르지 않는다.
    '수행 후, 무엇을 했는지(또는 무엇을 정리했는지) 한국어 산문으로 간결히 보고하세요.',
    '중요: 이번 응답은 JSON·코드블록·키:값 구조가 아니라, 사람이 그대로 읽을 수 있는 자연스러운 한국어 문장으로만 작성하세요.',
  ].join('\n')
}

/** 스레드 기반 미리알림(Reminder) 초안 생성 프롬프트. extra가 있으면 우선 반영 지시로 삽입.
 *  now가 있으면(예: "2026-07-15 (화)") 상대/연도 없는 날짜 표현을 정확한 연도로 환산하도록 지시한다. */
export function reminderPrompt(args: {
  threadText: string
  authorName: string
  channelName?: string
  extra?: string
  now?: string
}): string {
  const extra = (args.extra || '').trim()
  const now = (args.now || '').trim()
  return [
    `채널: ${args.channelName ?? '(unknown)'}`,
    `이 스레드에서 ${args.authorName} 님이 당신의 사용자를 멘션했습니다.`,
    now ? `오늘 날짜: ${now}` : '',
    '--- 스레드 내용 ---',
    args.threadText,
    '--- 끝 ---',
    extra ? `사용자 추가 지시(우선 반영): ${extra}` : '',
    '위 스레드를 바탕으로 미리 알림(Reminder) 초안을 만드세요.',
    '반드시 아래 JSON만 출력하세요(코드펜스 없이, 다른 텍스트 금지):',
    '{"title":"미리알림 제목(간결, 한국어, 40자 내외 권장)","notes":"미리알림 메모 본문(스레드 핵심 맥락/배경 요약). 링크·작성자·채널 라벨은 넣지 마세요(하류에서 별도로 붙입니다)","subtasks":["해야 할 세부 작업"],"dueDate":"스레드에 마감/기한이 명시되거나 강하게 암시된 경우에만 연도를 포함한 ISO 8601(YYYY-MM-DD 또는 YYYY-MM-DD 날짜+시간)로 채우고, 그렇지 않으면 null"}',
    '해야 할 세부 작업이 없으면 subtasks는 빈 배열로 출력하세요.',
    now
      ? '연도가 없는 날짜("7월 20일" 등)나 "이번 주 금요일" 같은 상대 표현은 위 오늘 날짜를 기준으로 연도를 포함한 정확한 YYYY-MM-DD(필요하면 날짜+시간)로 변환해 dueDate에 채우세요. 마감/기한이 불명확하면 억지로 추론하지 말고 dueDate를 null로 출력하세요.'
      : '마감일이 불명확하면 억지로 추론하지 말고 dueDate를 null로 출력하세요.',
  ].filter(Boolean).join('\n')
}

export function analysisUserPrompt(args: {
  threadText: string
  authorName: string
  channelName?: string
  playbooks?: Playbook[]
  lessons?: string[]
}): string {
  return [
    `채널: ${args.channelName ?? '(unknown)'}`,
    `이 스레드에서 ${args.authorName} 님이 당신의 사용자를 멘션했습니다.`,
    '--- 스레드 내용 ---',
    args.threadText,
    '--- 끝 ---',
    playbooksSection(args.playbooks ?? []),
    lessonsSection(args.lessons),
    '위 스레드를 분석해 요약·조언·해야 할 일·답장 초안·제안 행동(actions)을 JSON으로 출력하세요.',
  ].join('\n')
}
