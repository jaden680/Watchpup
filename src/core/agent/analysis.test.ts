import { describe, it, expect } from 'vitest'
import { parseAnalysis, parseReminderDraft, parseDueDate } from './analysis.js'

describe('parseAnalysis', () => {
  it('extracts the JSON block', () => {
    const out = 'noise\n{"summary":"s","advice":"a","todos":["t1","t2"],"draftReply":"r"}\ntrailing'
    const a = parseAnalysis(out)
    expect(a.summary).toBe('s')
    expect(a.todos).toEqual([{ text: 't1' }, { text: 't2' }])
    expect(a.draftReply).toBe('r')
  })
  it('parses object todos with playbookId', () => {
    const a = parseAnalysis('{"summary":"s","todos":[{"text":"원인 조사","playbookId":"code"},{"text":"직접 확인"}]}')
    expect(a.todos).toEqual([{ text: '원인 조사', playbookId: 'code' }, { text: '직접 확인', playbookId: undefined }])
  })
  it('parses valid category, ignores invalid', () => {
    expect(parseAnalysis('{"category":"issue"}').category).toBe('issue')
    expect(parseAnalysis('{"category":"논의"}').category).toBeUndefined()
    expect(parseAnalysis('{"summary":"s"}').category).toBeUndefined()
  })
  it('falls back safely on parse failure', () => {
    const a = parseAnalysis('completely non-json output')
    expect(a.summary).toContain('파싱 실패')
    expect(a.todos).toEqual([])
    expect(a.draftReply).toBe('')
  })
  it('coerces missing fields', () => {
    const a = parseAnalysis('{"summary":"only"}')
    expect(a.advice).toBe('')
    expect(Array.isArray(a.todos)).toBe(true)
  })
})

describe('parseReminderDraft', () => {
  it('정상 JSON을 파싱한다', () => {
    const d = parseReminderDraft('{"title":"버그 확인","notes":"요약 내용","subtasks":["로그 확인","재현"]}')
    expect(d).toEqual({ title: '버그 확인', notes: '요약 내용', subtasks: ['로그 확인', '재현'] })
  })

  it('코드펜스·잡텍스트가 섞여도 JSON 블록만 추출한다', () => {
    const d = parseReminderDraft('```json\n노트: {"title":"제목","notes":"내용","subtasks":[]}\n```\n끝')
    expect(d.title).toBe('제목')
    expect(d.notes).toBe('내용')
    expect(d.subtasks).toEqual([])
  })

  it('subtasks가 누락되거나 배열이 아니면 빈 배열로 처리한다', () => {
    expect(parseReminderDraft('{"title":"t","notes":"n"}').subtasks).toEqual([])
    expect(parseReminderDraft('{"title":"t","notes":"n","subtasks":"문자열"}').subtasks).toEqual([])
  })

  it('완전히 파싱 실패하면 빈 값을 반환한다', () => {
    const d = parseReminderDraft('완전히 JSON이 아닌 텍스트')
    expect(d).toEqual({ title: '', notes: '', subtasks: [] })
  })

  it('공백뿐인 subtask 항목은 제외한다', () => {
    const d = parseReminderDraft('{"title":"t","notes":"n","subtasks":["  ","실제 할 일","   "]}')
    expect(d.subtasks).toEqual(['실제 할 일'])
  })

  it('dueDate가 날짜만이면 로컬 09:00으로 해석한 epoch ms를 반환한다', () => {
    const d = parseReminderDraft('{"title":"t","notes":"n","subtasks":[],"dueDate":"2026-08-01"}')
    expect(d.dueAt).toBe(parseDueDate('2026-08-01'))
  })

  it('dueDate가 날짜+시간이면 그대로 파싱한다', () => {
    const d = parseReminderDraft('{"title":"t","notes":"n","subtasks":[],"dueDate":"2026-08-01T15:30:00"}')
    expect(d.dueAt).toBe(Date.parse('2026-08-01T15:30:00'))
  })

  it('dueDate가 null이면 dueAt도 null이다', () => {
    const d = parseReminderDraft('{"title":"t","notes":"n","subtasks":[],"dueDate":null}')
    expect(d.dueAt).toBeNull()
  })

  it('dueDate 키가 없으면 dueAt은 undefined로 남는다(기존 toEqual 호환)', () => {
    const d = parseReminderDraft('{"title":"t","notes":"n","subtasks":[]}')
    expect(d.dueAt).toBeUndefined()
  })
})

describe('parseDueDate', () => {
  it('빈 문자열이면 null', () => {
    expect(parseDueDate('')).toBeNull()
  })

  it('누락/undefined이면 null', () => {
    expect(parseDueDate(undefined)).toBeNull()
  })

  it('파싱 불가능한 문자열이면 null', () => {
    expect(parseDueDate('마감일 모름')).toBeNull()
  })

  it('날짜만(YYYY-MM-DD)이면 그날 로컬 09:00으로 해석한다', () => {
    expect(parseDueDate('2026-08-01')).toBe(new Date('2026-08-01T09:00:00').getTime())
  })

  it('날짜+시간이면 그대로 파싱한다', () => {
    expect(parseDueDate('2026-08-01T15:30:00')).toBe(Date.parse('2026-08-01T15:30:00'))
  })
})
