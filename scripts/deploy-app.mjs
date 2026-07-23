#!/usr/bin/env node
/**
 * 로컬 배포: out/mac-arm64/Watchpup.app → /Applications 교체 후 재실행.
 *
 * ⚠️ 서명 금지 — electron-builder가 키체인의 Apple Development 인증서로 자동 서명하면
 * 실행 시 SIGKILL(런타임 검증 거부)되거나 XProtect가 악성코드로 오탐한다.
 * 반드시 CSC_IDENTITY_AUTO_DISCOVERY=false 로 빌드한다 (npm run deploy가 처리).
 * 기존 앱은 rm 하지 않고 Desktop/git/.trash/날짜/ 로 이동한다.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const SOURCE = join(process.cwd(), 'out', 'mac-arm64', 'Watchpup.app')
const TARGET = '/Applications/Watchpup.app'
const now = new Date()
const localDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
const trashDir = join(homedir(), 'Desktop', 'git', '.trash', localDate)

if (!existsSync(SOURCE)) {
  console.error(`빌드 산출물이 없습니다: ${SOURCE}\n먼저 npm run deploy 로 실행하세요.`)
  process.exit(1)
}

// 1) 실행 중이면 종료
try { execFileSync('osascript', ['-e', 'quit app "Watchpup"'], { timeout: 10_000 }) } catch { /* 미실행 */ }
try { execFileSync('pkill', ['-f', 'Watchpup.app/Contents/MacOS/Watchpup'], { timeout: 5_000 }) } catch { /* 이미 종료 */ }

// 2) 기존 앱은 휴지통(.trash)으로
if (existsSync(TARGET)) {
  mkdirSync(trashDir, { recursive: true })
  const stamp = new Date().toTimeString().slice(0, 8).replaceAll(':', '')
  renameSync(TARGET, join(trashDir, `Watchpup-${stamp}.app`))
  console.log(`기존 앱 → ${trashDir}`)
}

// 3) 새 빌드 복사 + 실행 (`open -a Watchpup`은 내장 헬퍼 앱을 열 수 있어 경로로 연다)
execFileSync('ditto', [SOURCE, TARGET])
execFileSync('open', [TARGET])
console.log('배포 완료: Watchpup 재실행됨')
