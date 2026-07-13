import { describe, expect, it } from 'vitest'
import { resolveWatchpupConfigPath } from './path.js'

describe('resolveWatchpupConfigPath', () => {
  it('worktree가 달라도 사용자 홈의 설정 파일을 사용한다', () => {
    expect(resolveWatchpupConfigPath({}, '/Users/test')).toBe('/Users/test/.watchpup/watchpup.config.yaml')
  })

  it('WATCHPUP_CONFIG가 있으면 명시 경로를 우선한다', () => {
    expect(resolveWatchpupConfigPath({ WATCHPUP_CONFIG: '/tmp/custom.yaml' }, '/Users/test')).toBe('/tmp/custom.yaml')
  })
})
