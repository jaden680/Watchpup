import { describe, expect, it } from 'vitest'
import { parseOrcaTerminalHandle } from './work-agent-orca.js'

describe('parseOrcaTerminalHandle', () => {
  it('중첩된 응답에서 handle을 찾는다', () => {
    expect(parseOrcaTerminalHandle('{"terminal":{"handle":"term-1","title":"t"}}')).toBe('term-1')
    expect(parseOrcaTerminalHandle('{"result":{"startupTerminal":{"handle":"term-2"}}}')).toBe('term-2')
    expect(parseOrcaTerminalHandle('{"handle":"top"}')).toBe('top')
  })

  it('handle이 없거나 JSON이 아니면 null', () => {
    expect(parseOrcaTerminalHandle('{"terminal":{"id":"x"}}')).toBeNull()
    expect(parseOrcaTerminalHandle('not-json')).toBeNull()
  })
})
