/**
 * claude -p 구조화 출력 파서 (순수 함수). 하나의 책임: 텍스트 → MentionAnalysis(관대한 폴백).
 */
import type { MentionAnalysis, MentionCategory, SuggestedAction, TodoSpec } from '../types.js'
import { MENTION_CATEGORIES } from '../types.js'

function parseCategory(raw: unknown): MentionCategory | undefined {
  return typeof raw === 'string' && (MENTION_CATEGORIES as string[]).includes(raw)
    ? (raw as MentionCategory)
    : undefined
}

function parseActions(raw: unknown): SuggestedAction[] {
  if (!Array.isArray(raw)) return []
  const out: SuggestedAction[] = []
  for (const a of raw) {
    if (a && typeof a === 'object') {
      const label = (a as { label?: unknown }).label
      const playbookId = (a as { playbookId?: unknown }).playbookId
      if (typeof label === 'string' && typeof playbookId === 'string' && label && playbookId) {
        out.push({ label, playbookId })
      }
    }
  }
  return out
}

// todos: 문자열 또는 {text, playbookId?} 둘 다 허용
function parseTodos(raw: unknown): TodoSpec[] {
  if (!Array.isArray(raw)) return []
  const out: TodoSpec[] = []
  for (const t of raw) {
    if (typeof t === 'string' && t.trim()) {
      out.push({ text: t })
    } else if (t && typeof t === 'object') {
      const text = (t as { text?: unknown }).text
      const playbookId = (t as { playbookId?: unknown }).playbookId
      if (typeof text === 'string' && text.trim()) {
        out.push({ text, playbookId: typeof playbookId === 'string' && playbookId ? playbookId : undefined })
      }
    }
  }
  return out
}

/** 스레드 기반 미리알림 초안(순수 파싱 결과). 하류(main 핸들러)가 buildMentionReminder로 폴백 병합. */
export interface ReminderDraftText {
  title: string
  notes: string
  subtasks: string[]
  dueAt?: number | null
}

function parseReminderSubtasks(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  for (const t of raw) {
    if (typeof t !== 'string') continue
    const trimmed = t.trim()
    if (trimmed) out.push(trimmed)
  }
  return out
}

/** LLM dueDate 문자열 → epoch ms. 빈/누락/파싱불가 → null. 날짜만(YYYY-MM-DD)이면 로컬 그날 09:00으로 해석. */
export function parseDueDate(raw: unknown): number | null {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (!trimmed) return null
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/
  const ms = dateOnly.test(trimmed) ? new Date(`${trimmed}T09:00:00`).getTime() : Date.parse(trimmed)
  return Number.isFinite(ms) ? ms : null
}

/** reminderPrompt 출력 텍스트 → ReminderDraftText(관대한 폴백). 파싱 전체 실패 시 빈 값. */
export function parseReminderDraft(text: string): ReminderDraftText {
  try {
    const start = text.indexOf('{')
    const end = text.lastIndexOf('}')
    if (start < 0 || end <= start) throw new Error('no json')
    const obj = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>
    const base: ReminderDraftText = {
      title: typeof obj.title === 'string' ? obj.title : '',
      notes: typeof obj.notes === 'string' ? obj.notes : '',
      subtasks: parseReminderSubtasks(obj.subtasks),
    }
    if ('dueDate' in obj) base.dueAt = parseDueDate(obj.dueDate)
    return base
  } catch {
    return { title: '', notes: '', subtasks: [] }
  }
}

export function parseAnalysis(text: string): MentionAnalysis {
  try {
    const start = text.indexOf('{')
    const end = text.lastIndexOf('}')
    if (start < 0 || end <= start) throw new Error('no json')
    const obj = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>
    return {
      headline: typeof obj.headline === 'string' ? obj.headline : '',
      summary: typeof obj.summary === 'string' ? obj.summary : '',
      advice: typeof obj.advice === 'string' ? obj.advice : '',
      todos: parseTodos(obj.todos),
      draftReply: typeof obj.draftReply === 'string' ? obj.draftReply : '',
      actions: parseActions(obj.actions),
      category: parseCategory(obj.category),
    }
  } catch {
    return { headline: '분석 실패', summary: '분석 결과 파싱 실패', advice: text.slice(0, 2000), todos: [], draftReply: '', actions: [] }
  }
}
