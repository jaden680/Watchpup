import { EventEmitter } from 'node:events'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import yaml from 'js-yaml'
import { parseConfig, type WatchpupConfig, type Playbook } from './schema.js'

export class ConfigStore extends EventEmitter {
  readonly path: string
  private config: WatchpupConfig
  constructor(configPath?: string) {
    super()
    this.path = configPath || process.env.WATCHPUP_CONFIG || './watchpup.config.yaml'
    const raw = existsSync(this.path) ? yaml.load(readFileSync(this.path, 'utf8')) : {}
    this.config = parseConfig({ ...(raw as object), ...this.envOverrides() })
  }
  private envOverrides(): Record<string, unknown> {
    const o: Record<string, unknown> = {}
    if (process.env.WATCHPUP_DATA_DIR) o.dataDir = process.env.WATCHPUP_DATA_DIR
    if (process.env.WATCHPUP_WORK_DIR) o.workDir = process.env.WATCHPUP_WORK_DIR
    if (process.env.WATCHPUP_KEYCHAIN_SERVICE) o.keychainService = process.env.WATCHPUP_KEYCHAIN_SERVICE
    if (process.env.WATCHPUP_MODEL) o.model = process.env.WATCHPUP_MODEL
    if (process.env.WATCHPUP_MY_SLACK_USER_ID) o.mySlackUserId = process.env.WATCHPUP_MY_SLACK_USER_ID
    return o
  }
  get(): WatchpupConfig { return structuredClone(this.config) }
  save(): void {
    mkdirSync(dirname(this.path), { recursive: true })
    writeFileSync(this.path, yaml.dump(this.config, { lineWidth: 120, sortKeys: false }), 'utf8')
    this.emit('change', this.get())
  }
  update(patch: Partial<WatchpupConfig>): WatchpupConfig {
    this.config = parseConfig({ ...this.config, ...patch })
    this.save()
    return this.get()
  }
  // ---- Playbook(워크플로우) CRUD ----
  upsertPlaybook(p: Playbook): WatchpupConfig {
    const list = this.config.playbooks.filter((x) => x.id !== p.id)
    list.push(p)
    return this.update({ playbooks: list })
  }
  removePlaybook(id: string): WatchpupConfig {
    return this.update({ playbooks: this.config.playbooks.filter((x) => x.id !== id) })
  }
  // ---- MCP 서버 CRUD ----
  upsertMcpServer(s: WatchpupConfig['mcpServers'][number]): WatchpupConfig {
    const list = this.config.mcpServers.filter((x) => x.id !== s.id)
    list.push(s)
    return this.update({ mcpServers: list })
  }
  removeMcpServer(id: string): WatchpupConfig {
    return this.update({ mcpServers: this.config.mcpServers.filter((x) => x.id !== id) })
  }
}
