import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const panelSource = readFileSync(new URL('./panel.js', import.meta.url), 'utf8')
const settingsSource = readFileSync(new URL('./settings.js', import.meta.url), 'utf8')

describe('기능별 지연 접근', () => {
  it('패널 시작만으로 Apple Reminders를 초기화하지 않는다', () => {
    expect(panelSource.match(/initWorkView\(\)/g)).toHaveLength(1)
    expect(panelSource).toContain("if (normalized === 'work')")
  })

  it('Jira API 검증은 사용자가 연결할 때만 실행한다', () => {
    expect(settingsSource).toContain('window.watchpup.integrationStatus(true)')
    expect(settingsSource.match(/integrationStatus\(true\)/g)).toHaveLength(1)
  })
})
