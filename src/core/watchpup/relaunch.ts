import { isAbsolute, resolve } from 'node:path'

/** 로컬 Electron 재시작은 상대 엔트리 경로를 잃지 않도록 절대 경로로 고정한다. */
export function localRelaunchArgs(argv: string[], cwd: string): string[] | undefined {
  const entry = argv[1]
  if (!entry) return undefined
  return [isAbsolute(entry) ? entry : resolve(cwd, entry), ...argv.slice(2)]
}
