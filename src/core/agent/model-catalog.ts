import { execFile as execFileCallback } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { promisify } from 'node:util'

const execFile = promisify(execFileCallback)

export interface ClaudeModelOption {
  value: string
  label: string
}

export interface ClaudeModelCatalog {
  options: ClaudeModelOption[]
  cliVersion: string
  fetchedAt: string
  source: 'cli' | 'fallback'
  cached?: boolean
  error?: string
}

export const FALLBACK_CLAUDE_MODELS: ClaudeModelOption[] = [
  { value: 'default', label: 'Default (CLI 권장)' },
  { value: 'sonnet', label: 'Sonnet' },
  { value: 'fable', label: 'Fable' },
  { value: 'opus', label: 'Opus' },
  { value: 'haiku', label: 'Haiku' },
]

const EXPECT_MODEL_MENU = `set timeout 20
log_user 1
spawn -noecho /usr/bin/env $env(WATCHPUP_MODEL_CLI) --safe-mode
after 7000
send -- "/model\\r"
expect {
  -re {Esc} {}
  timeout { exit 2 }
}
send -- "\\033"
after 100
close
wait`

type Screen = string[][]

function renderTerminal(raw: string, width = 120, height = 80): string[] {
  const screen: Screen = Array.from({ length: height }, () => [])
  let x = 0
  let y = 0
  let savedX = 0
  let savedY = 0
  const write = (char: string): void => {
    if (y < 0 || y >= height) return
    screen[y][x] = char
    x = Math.min(width - 1, x + 1)
  }
  const move = (value: string | undefined, fallback = 1): number => {
    const parsed = Number.parseInt(value || '', 10)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
  }

  for (let i = 0; i < raw.length;) {
    const char = raw[i]
    if (char === '\x1b') {
      const next = raw[i + 1]
      if (next === '[') {
        let end = i + 2
        while (end < raw.length && !/[\x40-\x7e]/.test(raw[end])) end += 1
        if (end >= raw.length) break
        const params = raw.slice(i + 2, end).replace(/^[?>]/, '').split(';')
        const command = raw[end]
        const amount = move(params[0])
        if (command === 'A') y = Math.max(0, y - amount)
        else if (command === 'B') y = Math.min(height - 1, y + amount)
        else if (command === 'C') x = Math.min(width - 1, x + amount)
        else if (command === 'D') x = Math.max(0, x - amount)
        else if (command === 'G') x = Math.max(0, amount - 1)
        else if (command === 'H' || command === 'f') {
          y = Math.max(0, move(params[0]) - 1)
          x = Math.max(0, move(params[1]) - 1)
        } else if (command === 'K') {
          screen[y].length = Math.min(screen[y].length, x)
        } else if (command === 'J' && params[0] === '2') {
          for (const row of screen) row.length = 0
          x = 0
          y = 0
        }
        i = end + 1
        continue
      }
      if (next === ']') {
        let end = i + 2
        while (end < raw.length && raw[end] !== '\x07' && !(raw[end] === '\x1b' && raw[end + 1] === '\\')) end += 1
        i = raw[end] === '\x07' ? end + 1 : end + 2
        continue
      }
      if (next === '7') { savedX = x; savedY = y; i += 2; continue }
      if (next === '8') { x = savedX; y = savedY; i += 2; continue }
      if (next === '(' || next === ')') { i += 3; continue }
      i += 2
      continue
    }
    if (char === '\r') { x = 0; i += 1; continue }
    if (char === '\n') { y = Math.min(height - 1, y + 1); x = 0; i += 1; continue }
    if (char.charCodeAt(0) < 32) { i += 1; continue }
    write(char)
    i += 1
  }

  return screen.map((row) => {
    const output = Array.from({ length: Math.min(width, Math.max(row.length, 1)) }, (_, index) => row[index] || ' ')
    return output.join('').trimEnd()
  })
}

export function parseClaudeModelMenu(raw: string): ClaudeModelOption[] {
  const lines = renderTerminal(raw)
  const start = lines.findIndex((line) => line.includes('Select model'))
  if (start < 0) throw new Error('Claude CLI /model 메뉴를 찾지 못했습니다.')

  const options: ClaudeModelOption[] = []
  for (const line of lines.slice(start + 1)) {
    if (!/^\s*(?:❯\s*)?\d+\./.test(line)) continue
    const name = line.slice(8, 31).replace(/[✔✓]/g, '').trim()
    if (!name) continue
    const value = name.toLowerCase().startsWith('default')
      ? 'default'
      : name.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-|-$/g, '')
    if (!value || options.some((option) => option.value === value)) continue
    options.push({ value, label: name })
  }
  if (options.length < 2) throw new Error('Claude CLI /model 선택지를 파싱하지 못했습니다.')
  return options
}

async function claudeVersion(bin: string): Promise<string> {
  const { stdout } = await execFile(bin, ['--version'], { timeout: 5000 })
  return stdout.trim()
}

export async function discoverClaudeModels(bin = process.env.WATCHPUP_CLAUDE_BIN || 'claude'): Promise<ClaudeModelCatalog> {
  const cliVersion = await claudeVersion(bin)
  const { stdout } = await execFile('/usr/bin/expect', ['-c', EXPECT_MODEL_MENU], {
    timeout: 20_000,
    maxBuffer: 2 * 1024 * 1024,
    env: { ...process.env, CLAUDECODE: '', WATCHPUP_MODEL_CLI: bin },
  })
  return {
    options: parseClaudeModelMenu(stdout),
    cliVersion,
    fetchedAt: new Date().toISOString(),
    source: 'cli',
  }
}

type DiscoverModels = () => Promise<ClaudeModelCatalog>
type ReadVersion = () => Promise<string>

export class ClaudeModelCatalogService {
  private pending: Promise<ClaudeModelCatalog> | null = null

  constructor(
    private readonly cachePath: string,
    private readonly discover: DiscoverModels = () => discoverClaudeModels(),
    private readonly readVersion: ReadVersion = () => claudeVersion(process.env.WATCHPUP_CLAUDE_BIN || 'claude'),
  ) {}

  private readCache(): ClaudeModelCatalog | null {
    if (!existsSync(this.cachePath)) return null
    try {
      const parsed = JSON.parse(readFileSync(this.cachePath, 'utf8')) as ClaudeModelCatalog
      return Array.isArray(parsed.options) && parsed.options.length ? parsed : null
    } catch {
      return null
    }
  }

  private save(catalog: ClaudeModelCatalog): void {
    mkdirSync(dirname(this.cachePath), { recursive: true })
    writeFileSync(this.cachePath, JSON.stringify(catalog, null, 2) + '\n', 'utf8')
  }

  async get(): Promise<ClaudeModelCatalog> {
    const cached = this.readCache()
    try {
      const version = await this.readVersion()
      if (cached?.cliVersion === version) return { ...cached, cached: true }
      return await this.refresh()
    } catch (error) {
      if (cached) return { ...cached, cached: true, error: error instanceof Error ? error.message : String(error) }
      return {
        options: FALLBACK_CLAUDE_MODELS,
        cliVersion: '',
        fetchedAt: '',
        source: 'fallback',
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }

  async refresh(): Promise<ClaudeModelCatalog> {
    if (this.pending) return this.pending
    this.pending = this.discover()
      .then((catalog) => {
        this.save(catalog)
        return catalog
      })
      .finally(() => { this.pending = null })
    return this.pending
  }
}
