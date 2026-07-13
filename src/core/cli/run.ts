import { join } from 'node:path'
import { keychain, SecretKeys } from '../secrets/keychain.js'
import { ConfigStore } from '../config/store.js'
import { SessionStore } from '../session/store.js'
import { KeyedMutex } from '../session/locks.js'
import { Semaphore } from '../session/semaphore.js'
import { StateStore } from '../state/store.js'
import { MentionStore } from '../state/mentions.js'
import { LessonStore } from '../state/lessons.js'
import { WatchpupGateway } from '../slack/gateway.js'
import { AuditStore } from '../observability/audit.js'
import type { Mention } from '../types.js'

const configStore = new ConfigStore()
const config = configStore.get()
const botToken = await keychain.get(SecretKeys.slackBotToken)
const appToken = await keychain.get(SecretKeys.slackAppToken)
const userToken = await keychain.get(SecretKeys.slackUserToken)
if (!config.mySlackUserId) { console.error('watchpup.config.yaml 의 mySlackUserId 를 설정하세요.'); process.exit(1) }

const mentions = new MentionStore(join(config.dataDir, 'mentions'))
const gw = new WatchpupGateway({
  config, sessions: new SessionStore(join(config.dataDir, 'sessions.json'), config.sessionCacheMax, config.sessionIdleMs),
  keychain, mutex: new KeyedMutex(), semaphore: new Semaphore(config.maxConcurrency),
  state: new StateStore(join(config.dataDir, 'watchpup-state.json')), mentions,
  audit: new AuditStore(join(config.dataDir, 'audit.jsonl')),
  lessons: new LessonStore(join(config.dataDir, 'lessons.json')),
})
if (config.enableBot && botToken && appToken) gw.attachSocket(botToken, appToken)
if (config.enableUserSearch && userToken) gw.attachUserSearch(userToken, config.mySlackUserId, config.searchIntervalSec)
if (!gw.hasSource()) {
  console.error('감지원이 없습니다. 봇 토큰(setup) 또는 User Token + enableUserSearch 를 설정하세요.')
  process.exit(1)
}
gw.on('pet', (s) => console.log('[pet]', s))
gw.on('mention:new', (m: Mention) => console.log('[new]', m.channelName, m.text))
gw.on('mention:ready', (m: Mention) => {
  console.log('[ready]', m.analysis?.summary)
  console.log('  조언:', m.analysis?.advice)
  console.log('  todos:', m.todos.map((t) => t.text))
  console.log('  답장초안:', m.analysis?.draftReply)
})
await gw.start()
console.log('watchpup-core 실행 중. 나를 멘션해보세요.')
