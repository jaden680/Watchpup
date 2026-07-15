import { execFileSync } from 'node:child_process'
import { chmodSync, copyFileSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const sources = [
  join(root, 'native', 'reminders-helper', 'main.swift'),
  join(root, 'native', 'reminders-helper', 'ReminderKitBridge.swift'),
]
const infoPlist = join(root, 'native', 'reminders-helper', 'Info.plist')
const calendarInfoPlist = join(root, 'native', 'reminders-helper', 'CalendarInfo.plist')
const output = join(root, 'dist', 'native', 'watchpup-reminders')
const helperApp = join(root, 'dist', 'native', 'Watchpup.app')
const helperContents = join(helperApp, 'Contents')
const helperExecutable = join(helperContents, 'MacOS', 'watchpup-eventkit-helper')
const moduleCache = join(root, 'dist', 'native', '.module-cache')
const architecture = process.arch === 'x64' ? 'x86_64' : 'arm64'

mkdirSync(moduleCache, { recursive: true })
execFileSync('xcrun', [
  'swiftc', ...sources,
  '-o', output,
  '-parse-as-library',
  '-target', `${architecture}-apple-macosx14.0`,
  '-framework', 'EventKit',
  '-Xlinker', '-sectcreate',
  '-Xlinker', '__TEXT',
  '-Xlinker', '__info_plist',
  '-Xlinker', infoPlist,
], {
  stdio: 'inherit',
  env: {
    ...process.env,
    CLANG_MODULE_CACHE_PATH: moduleCache,
    SWIFT_MODULECACHE_PATH: moduleCache,
  },
})
execFileSync('codesign', ['--force', '--sign', '-', '--identifier', 'com.jaden.watchpup.reminders-helper', output], { stdio: 'inherit' })

rmSync(helperApp, { recursive: true, force: true })
mkdirSync(join(helperContents, 'MacOS'), { recursive: true })
copyFileSync(output, helperExecutable)
copyFileSync(calendarInfoPlist, join(helperContents, 'Info.plist'))
chmodSync(helperExecutable, 0o755)
execFileSync('codesign', ['--force', '--deep', '--sign', '-', helperApp], { stdio: 'inherit' })
console.log(`eventkit helpers done: ${output}, ${helperApp}`)
