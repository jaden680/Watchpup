import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = join(root, 'native', 'reminders-helper', 'main.swift')
const infoPlist = join(root, 'native', 'reminders-helper', 'Info.plist')
const output = join(root, 'dist', 'native', 'watchpup-reminders')
const moduleCache = join(root, 'dist', 'native', '.module-cache')
const architecture = process.arch === 'x64' ? 'x86_64' : 'arm64'

mkdirSync(moduleCache, { recursive: true })
execFileSync('xcrun', [
  'swiftc', source,
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
console.log(`reminders helper done: ${output}`)
