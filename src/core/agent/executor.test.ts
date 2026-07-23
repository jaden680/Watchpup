import { describe, it, expect, beforeAll } from 'vitest'
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildClaudeArgs, runClaude } from './executor.js'
import { parseConfig } from '../config/schema.js'

let bin: string
beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), 'watchpup-bin-'))
  bin = join(dir, 'fake-claude.mjs')
  // stdin을 읽고, stream-json 두 줄(assistant text + result)을 stdout으로 출력
  writeFileSync(bin, `#!/usr/bin/env node
let s=''; process.stdin.on('data',d=>s+=d); process.stdin.on('end',()=>{
  process.stdout.write(JSON.stringify({type:'system',session_id:'sid-1'})+'\\n')
  process.stdout.write(JSON.stringify({type:'assistant',message:{content:[{type:'text',text:'hi'}]}})+'\\n')
  process.stdout.write(JSON.stringify({type:'result',result:'final',session_id:'sid-1',is_error:false})+'\\n')
})`)
  chmodSync(bin, 0o755)
  process.env.WATCHPUP_CLAUDE_BIN = process.execPath // node로 스크립트 실행
})

describe('runClaude', () => {
  it('Default 선택 시 CLI의 계정 기본 모델을 사용한다', () => {
    const dir = mkdtempSync(join(tmpdir(), 'watchpup-wd-'))
    const config = parseConfig({ workDir: dir, dataDir: dir, model: 'default' })
    const args = buildClaudeArgs({
      prompt: 'test', config, agents: {}, allowedTools: [], disallowedTools: [],
      systemPrompt: 'sys', isResume: false,
    })

    expect(args).not.toContain('--model')
  })

  it('parses stream-json into AgentResult', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'watchpup-wd-'))
    const cfg = parseConfig({ workDir: dir, dataDir: dir })
    const events: string[] = []
    // WATCHPUP_CLAUDE_BIN이 node이므로 첫 인자로 스크립트 경로가 필요 → executor는 args만 넘김.
    // 이를 위해 CLAUDE_BIN을 fake 스크립트 자체로 지정(아래 대안 참조).
    process.env.WATCHPUP_CLAUDE_BIN = bin
    const res = await runClaude({
      prompt: 'test', config: cfg, agents: {}, allowedTools: [], disallowedTools: [],
      systemPrompt: 'sys', isResume: false, onEvent: (e) => events.push(e.type),
    })
    expect(res.text).toBe('final')
    expect(res.sessionId).toBe('sid-1')
    expect(res.isError).toBe(false)
    expect(events).toContain('result')
  })

  it('정상 종료했지만 result 이벤트가 없으면 error로 스트림을 끝낸다', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'watchpup-empty-bin-'))
    const emptyBin = join(dir, 'empty-claude.mjs')
    writeFileSync(emptyBin, `#!/usr/bin/env node
process.stdin.resume(); process.stdin.on('end',()=>process.exit(0))`)
    chmodSync(emptyBin, 0o755)
    process.env.WATCHPUP_CLAUDE_BIN = emptyBin
    const cfg = parseConfig({ workDir: dir, dataDir: dir })
    const events: string[] = []

    const res = await runClaude({
      prompt: 'test', config: cfg, agents: {}, allowedTools: [], disallowedTools: [],
      systemPrompt: 'sys', isResume: false, onEvent: (e) => events.push(e.type),
    })

    expect(res.isError).toBe(true)
    expect(events.at(-1)).toBe('error')
  })
})
