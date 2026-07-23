import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isGitRepo, scanGitRepos } from './repos-scan.js'

describe('scanGitRepos', () => {
  it('하위 1단계에서 git 레포만 골라 이름순으로 돌려준다', () => {
    const root = mkdtempSync(join(tmpdir(), 'watchpup-scan-'))
    try {
      mkdirSync(join(root, 'zigzag-ios', '.git'), { recursive: true })
      mkdirSync(join(root, 'design-system', '.git'), { recursive: true })
      mkdirSync(join(root, 'not-a-repo'), { recursive: true })
      mkdirSync(join(root, '.hidden', '.git'), { recursive: true })
      writeFileSync(join(root, 'file.txt'), '')

      const found = scanGitRepos(root, [join(root, 'zigzag-ios')])
      expect(found.map((candidate) => candidate.name)).toEqual(['design-system', 'zigzag-ios'])
      expect(found.find((candidate) => candidate.name === 'zigzag-ios')?.already).toBe(true)
      expect(found.find((candidate) => candidate.name === 'design-system')?.already).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('읽을 수 없는 폴더는 빈 배열', () => {
    expect(scanGitRepos('/nonexistent-path-xyz')).toEqual([])
  })

  it('isGitRepo는 .git 파일(worktree)도 인식한다', () => {
    const root = mkdtempSync(join(tmpdir(), 'watchpup-scan-'))
    try {
      mkdirSync(join(root, 'wt'))
      writeFileSync(join(root, 'wt', '.git'), 'gitdir: /somewhere')
      expect(isGitRepo(join(root, 'wt'))).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
