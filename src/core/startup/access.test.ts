import { describe, expect, it } from 'vitest'
import { startupSlackSecrets } from './access.js'

const disabled = {
  enableBot: false,
  enableUserSearch: false,
  followThreads: false,
  naggingEnabled: false,
  slackNewsEnabled: false,
}

describe('startupSlackSecrets', () => {
  it('Slack 기능이 꺼져 있으면 시작 시 토큰을 읽지 않는다', () => {
    expect(startupSlackSecrets(disabled)).toEqual({ bot: false, app: false, user: false })
  })

  it('Socket Mode를 쓸 때만 Bot/App 토큰을 읽는다', () => {
    expect(startupSlackSecrets({ ...disabled, enableBot: true })).toEqual({ bot: true, app: true, user: false })
  })

  it.each([
    { enableUserSearch: true },
    { followThreads: true },
    { naggingEnabled: true, slackNewsEnabled: true },
  ])('User Token 백그라운드 기능에만 User Token을 읽는다: %o', (patch) => {
    expect(startupSlackSecrets({ ...disabled, ...patch })).toEqual({ bot: false, app: false, user: true })
  })
})
