import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import { describe, expect, it } from 'vitest'

const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8')
const document = new JSDOM(html).window.document

describe('Work layout', () => {
  it('작업 목록 아래에 한 줄 생성 composer를 고정한다', () => {
    const column = document.getElementById('work-list-col')
    const list = document.getElementById('work-list')
    const form = document.getElementById('work-create-form')

    expect(column?.lastElementChild).toBe(form)
    expect(list?.nextElementSibling).toBe(form)
    expect(form?.classList.contains('hidden')).toBe(false)
  })

  it('생성 시에는 제목만 받고 메모는 상세에서 편집한다', () => {
    const form = document.getElementById('work-create-form')

    expect(form?.querySelector('#work-create-title')).not.toBeNull()
    expect(form?.querySelector('textarea')).toBeNull()
  })
})
