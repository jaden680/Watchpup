// 렌더러 공유 상태 — 여러 모듈이 참조하는 단일 소스.
// state는 객체이므로 import해도 프로퍼티 접근/변경이 그대로 공유된다.

export const state = {
  mentions: new Map(),       // id → Mention (refresh 때 새 Map으로 교체)
  activities: [],            // Claude/Codex 로컬 세션 목록
  current: null,             // 선택된 mentionId
  currentActivity: null,     // 선택된 Claude/Codex activityId
  chats: new Map(),          // id → { messages } (mentions 교체와 무관하게 보존)
  pendingEls: new Map(),     // id → 진행 중 채팅 말풍선 el
  actionLogs: new Map(),     // id → { entries } 액션 실행 트랜스크립트
  actionEls: new Map(),      // id → 진행 중 액션 로그 el
  runningActions: new Set(), // 실행 중인 mentionId
}

// 멘션별 채팅 기록 (state.mentions는 refresh()에서 새 객체로 교체되므로 별도 보관)
export function getChat(mentionId) {
  let chat = state.chats.get(mentionId)
  if (!chat) {
    chat = { messages: [] }
    state.chats.set(mentionId, chat)
  }
  return chat
}

// 멘션별 액션(워크플로우 실행) 트랜스크립트 — chats와 동일한 방식으로 별도 보관
export function getActionLog(mentionId) {
  let log = state.actionLogs.get(mentionId)
  if (!log) {
    log = { entries: [] }
    state.actionLogs.set(mentionId, log)
  }
  return log
}

// 멘션의 "최근 슬랙 메시지 시각" — 트리거 메시지와 스레드 답글(tail) 중 가장 최신 ts.
// messageTs/thread ts는 슬랙 "초.마이크로" 문자열이라 parseFloat으로 비교 가능한 수로 변환.
export function lastMessageTs(mention) {
  let max = parseFloat(mention?.messageTs || '0') || 0
  if (Array.isArray(mention?.thread)) {
    for (const t of mention.thread) {
      const ts = parseFloat(t?.ts || '0') || 0
      if (ts > max) max = ts
    }
  }
  return max
}

// 멘션 정렬 — order: 'lastMessage'(기본, 최근 슬랙 메시지순) | 'fetched'(가져온 순서=mentionedAt순)
export function sortedMentions(order = 'lastMessage') {
  const list = [...state.mentions.values()]
  if (order === 'fetched') {
    return list.sort((a, b) => b.mentionedAt - a.mentionedAt)
  }
  return list.sort((a, b) => {
    const diff = lastMessageTs(b) - lastMessageTs(a)
    return diff !== 0 ? diff : b.mentionedAt - a.mentionedAt
  })
}

// 네비게이션/렌더 콜백 레지스트리 — panel이 자기 함수를 등록해 다른 모듈(views 등)이
// 순환 import 없이 호출한다. { select, renderList, runAction, ensureMentionsTab, refresh, renderDetail }
export const nav = {}
