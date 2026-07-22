/**
 * 레포 폴더 스캔: 선택한 폴더의 하위(1단계)에서 git 레포(.git 존재)를 찾는다.
 * "레포들을 모아둔 상위 폴더"를 골랐을 때 선택 등록 UI에 후보로 보여주기 위한 헬퍼.
 */
import { existsSync, readdirSync } from 'node:fs'
import { basename, join } from 'node:path'

export interface RepoCandidate {
  path: string
  name: string
  already: boolean
}

export function isGitRepo(path: string): boolean {
  return existsSync(join(path, '.git'))
}

export function scanGitRepos(dir: string, existing: Iterable<string> = []): RepoCandidate[] {
  const registered = new Set(existing)
  let entries: string[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => join(dir, entry.name))
  } catch {
    return []
  }
  return entries
    .filter(isGitRepo)
    .map((path) => ({ path, name: basename(path), already: registered.has(path) }))
    .sort((a, b) => a.name.localeCompare(b.name, 'ko', { sensitivity: 'base' }))
}
