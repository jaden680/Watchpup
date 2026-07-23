import { describe, expect, it } from 'vitest'
import { branchSlug } from './run.js'

describe('branchSlug', () => {
  it('작업 제목을 브랜치용 슬러그로 만든다 ([태그] 제거, 한글 유지)', () => {
    expect(branchSlug('[iOS] 로띠 업데이트', 'ABC-123')).toBe('로띠-업데이트')
    expect(branchSlug('EWS 로그반영 - Image failure', 'ABC-123')).toBe('EWS-로그반영-Image-failure')
    expect(branchSlug('아주 긴 제목이 들어와도 스물네 글자에서 잘라냅니다 진짜로요', 'ABC-123').length).toBeLessThanOrEqual(24)
  })

  it('제목이 비거나 기호뿐이면 id 축약으로 폴백', () => {
    expect(branchSlug('', 'EB0CA6FF-FF55')).toBe('eb0ca6ff')
    expect(branchSlug('[]!!', 'EB0CA6FF-FF55')).toBe('eb0ca6ff')
  })
})
