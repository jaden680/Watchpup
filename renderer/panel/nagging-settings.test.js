import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import { describe, expect, it } from 'vitest'

const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8')
const document = new JSDOM(html).window.document

describe('잔소리 베타 설정', () => {
  it('별도 설정 탭을 제공하고 기본값은 꺼져 있다', () => {
    const tab = document.querySelector('.sset-tab[data-sset="nagging"]')
    const enabled = document.querySelector('input[name="naggingEnabled"]')

    expect(tab?.textContent).toContain('잔소리')
    expect(enabled?.checked).toBe(false)
  })

  it('몇 분 단위의 랜덤 범위를 설정할 수 있다', () => {
    const min = document.querySelector('input[name="naggingMinMinutes"]')
    const max = document.querySelector('input[name="naggingMaxMinutes"]')

    expect(min?.value).toBe('5')
    expect(max?.value).toBe('12')
  })

  it('캘린더, Agent, GitHub PR, Slack 소식, Work 순서의 타이밍 잔소리를 안내한다', () => {
    const priorities = [...document.querySelectorAll('.nagging-priorities li')].map((item) => item.textContent)
    expect(priorities).toHaveLength(5)
    expect(priorities[0]).toContain('캘린더 일정 5분 전')
    expect(priorities[1]).toContain('Agent 작업 종료 후')
    expect(priorities[2]).toContain('GitHub PR')
    expect(priorities[3]).toContain('Slack 새 소식')
    expect(priorities[4]).toContain('미완료 Work 작업')
    expect(document.getElementById('nagging-calendar-settings')?.textContent).toContain('캘린더 권한')
  })

  it('GitHub PR 확인은 기본으로 켜져 있고 로컬 gh 로그인을 사용한다', () => {
    const enabled = document.querySelector('input[name="githubPrNaggingEnabled"]')
    expect(enabled?.checked).toBe(true)
    expect(enabled?.closest('.nagging-github-pr')?.textContent).toContain('20분')
  })

  it('기본 공지 채널과 사용자 키워드 구독 입력을 제공한다', () => {
    const enabled = document.querySelector('input[name="slackNewsEnabled"]')
    const channels = document.querySelector('textarea[name="slackNewsChannels"]')
    const keywords = document.querySelector('textarea[name="slackNewsKeywords"]')

    expect(enabled?.checked).toBe(false)
    expect(channels?.value).toContain('all_전사공유')
    expect(channels?.value).toContain('all_전사공지')
    expect(channels?.value).toContain('all_random')
    expect(keywords).not.toBeNull()
  })

  it('실제로 표시된 잔소리를 확인하는 디버그 로그 영역을 제공한다', () => {
    expect(document.getElementById('nagging-log-list')).not.toBeNull()
    expect(document.getElementById('nagging-log-refresh')?.textContent).toContain('새로고침')
    expect(document.getElementById('nagging-log-clear')?.textContent).toContain('비우기')
  })
})
