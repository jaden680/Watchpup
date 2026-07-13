#!/usr/bin/env node
// npx github:jaden680/Watchpup 로 어디서 실행하든 같은 설정/데이터를 쓰도록
// 홈 디렉토리(~/.watchpup) 고정 경로를 기본값으로 준다 (명시적 env가 있으면 그걸 우선).
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const home = join(homedir(), '.watchpup')

process.env.WATCHPUP_CONFIG ||= join(home, 'watchpup.config.yaml')
process.env.WATCHPUP_DATA_DIR ||= join(home, 'data')
process.env.WATCHPUP_WORK_DIR ||= join(home, 'data', 'workdir')

const mainJs = join(root, 'dist', 'electron', 'main.js')
if (!existsSync(mainJs)) {
  console.error('빌드 결과물이 없습니다:', mainJs, '\n"npm run build:app"을 먼저 실행하세요.')
  process.exit(1)
}

const electronPath = (await import('electron')).default
const child = spawn(electronPath, [mainJs], { stdio: 'inherit', env: process.env })
child.on('exit', (code) => process.exit(code ?? 0))
child.on('error', (err) => {
  console.error('Watchpup 실행 실패:', err.message)
  process.exit(1)
})
