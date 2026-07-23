import { describe, expect, it } from 'vitest'
import { sanitizeBranchSlug } from './run.js'

describe('sanitizeBranchSlug', () => {
  it('LLM 출력을 브랜치 슬러그로 정제한다 (마지막 줄 사용)', () => {
    expect(sanitizeBranchSlug('update-lottie')).toBe('update-lottie')
    expect(sanitizeBranchSlug('Sure! Here it is:\nFix-Bitrise-Build ')).toBe('fix-bitrise-build')
    expect(sanitizeBranchSlug('`update-lottie`')).toBe('update-lottie')
  })

  it('형식이 안 맞으면 빈 문자열 (호출측 폴백)', () => {
    expect(sanitizeBranchSlug('')).toBe('')
    expect(sanitizeBranchSlug('로띠 업데이트')).toBe('')
    expect(sanitizeBranchSlug('-')).toBe('')
  })
})
