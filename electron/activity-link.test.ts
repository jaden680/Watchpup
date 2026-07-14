import { describe, expect, it } from 'vitest'
import { activityTarget } from './activity-link.js'

describe('activityTarget', () => {
  it('Codex와 Claude 세션 딥링크를 만든다', () => {
    expect(activityTarget('codex:thread-1')).toEqual({ kind: 'external', url: 'codex://threads/thread-1' })
    expect(activityTarget('claude:session 1')).toEqual({ kind: 'external', url: 'claude://resume?session=session%201' })
  })

  it('Slack은 저장된 멘션으로 연결하고 알 수 없는 출처는 거부한다', () => {
    expect(activityTarget('slack:mention-1')).toEqual({ kind: 'mention', id: 'mention-1' })
    expect(activityTarget('unknown:x')).toBeNull()
    expect(activityTarget('codex:')).toBeNull()
  })
})
