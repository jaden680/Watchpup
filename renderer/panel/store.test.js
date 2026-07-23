import { describe, expect, it } from 'vitest'
import { lastMessageTs } from './store.js'

describe('lastMessageTs', () => {
  it('messageTs만 있으면 그 값을 사용한다', () => {
    expect(lastMessageTs({ messageTs: '1700000000.000100' })).toBeCloseTo(1700000000.0001)
  })

  it('thread가 있으면 messageTs와 thread ts 중 가장 큰 값을 사용한다', () => {
    const mention = {
      messageTs: '1700000000.000100',
      thread: [
        { ts: '1700000001.000200' },
        { ts: '1700000005.000300' }, // 가장 최신
        { ts: '1700000002.000400' },
      ],
    }
    expect(lastMessageTs(mention)).toBeCloseTo(1700000005.0003)
  })

  it('messageTs가 thread보다 최신이면 messageTs를 사용한다', () => {
    const mention = {
      messageTs: '1700000010.000000',
      thread: [{ ts: '1700000001.000200' }],
    }
    expect(lastMessageTs(mention)).toBeCloseTo(1700000010)
  })

  it('아무 값도 없으면 0을 반환한다', () => {
    expect(lastMessageTs({})).toBe(0)
    expect(lastMessageTs(undefined)).toBe(0)
  })

  it('문자열 ts를 숫자로 파싱한다', () => {
    expect(lastMessageTs({ messageTs: '123.456', thread: [{ ts: 'not-a-number' }] })).toBeCloseTo(123.456)
  })
})
