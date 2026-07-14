/**
 * 간편 연동 — 노션/지라를 토큰 기반 독립 MCP 서버로 watchpup에 등록.
 * claude.ai 통합과 달리 watchpup가 직접 실행하므로 격리 상태에서도 동작한다.
 * 토큰은 Keychain에만 저장하고, config에는 secretEnv(env→Keychain key) 매핑만 남긴다.
 */
import type { ConfigStore } from '../src/core/config/store.js'
import type { Keychain } from '../src/core/secrets/keychain.js'
import type { WatchpupConfig } from '../src/core/config/schema.js'

const NOTION_KEY = 'MCP_NOTION_TOKEN'
export const JIRA_KEY = 'MCP_JIRA_TOKEN'

export interface IntegrationStatus {
  notion: { connected: boolean }
  jira: { connected: boolean; site: string; email: string; authenticated?: boolean; error?: string }
}

function serverById(config: WatchpupConfig, id: string) {
  return config.mcpServers.find((s) => s.id === id)
}

export async function integrationStatus(configStore: ConfigStore): Promise<IntegrationStatus> {
  const c = configStore.get()
  const jira = serverById(c, 'jira')
  return {
    notion: { connected: !!serverById(c, 'notion') },
    jira: {
      connected: !!jira,
      site: jira?.env?.ATLASSIAN_SITE_NAME ?? '',
      email: jira?.env?.ATLASSIAN_USER_EMAIL ?? '',
    },
  }
}

/** 노션 연동: Integration Token → Keychain, MCP 서버 등록. */
export async function connectNotion(
  configStore: ConfigStore,
  keychain: Keychain,
  token: string,
): Promise<WatchpupConfig> {
  if (token && token.trim()) await keychain.set(NOTION_KEY, token.trim())
  return configStore.upsertMcpServer({
    id: 'notion',
    label: 'Notion',
    enabled: true,
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@notionhq/notion-mcp-server'],
    secretEnv: { NOTION_TOKEN: NOTION_KEY },
    writeTools: [],
  } as never)
}

/** 지라 연동: 사이트·이메일(평문 env) + API 토큰(Keychain) → MCP 서버 등록. */
export async function connectJira(
  configStore: ConfigStore,
  keychain: Keychain,
  input: { site: string; email: string; token: string },
): Promise<WatchpupConfig> {
  if (input.token && input.token.trim()) await keychain.set(JIRA_KEY, input.token.trim())
  return configStore.upsertMcpServer({
    id: 'jira',
    label: 'Jira',
    enabled: true,
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@aashari/mcp-server-atlassian-jira'],
    env: { ATLASSIAN_SITE_NAME: input.site.trim(), ATLASSIAN_USER_EMAIL: input.email.trim() },
    secretEnv: { ATLASSIAN_API_TOKEN: JIRA_KEY },
    writeTools: [],
  } as never)
}

/** 연동 해제: MCP 서버 제거(토큰은 Keychain에 남겨둠 — 재연동 시 재사용). */
export function disconnectIntegration(configStore: ConfigStore, id: 'notion' | 'jira'): WatchpupConfig {
  return configStore.removeMcpServer(id)
}
