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

  it('캘린더, Agent, Slack 소식, Work 순서의 타이밍 잔소리를 안내한다', () => {
    const priorities = [...document.querySelectorAll('.nagging-priorities li')].map((item) => item.textContent)
    expect(priorities).toHaveLength(4)
    expect(priorities[0]).toContain('캘린더 일정 5분 전')
    expect(priorities[1]).toContain('Agent 작업 종료 후')
    expect(priorities[2]).toContain('Slack 새 소식')
    expect(priorities[3]).toContain('미완료 Work 작업')
    expect(document.getElementById('nagging-calendar-settings')?.textContent).toContain('캘린더 권한')
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
})
