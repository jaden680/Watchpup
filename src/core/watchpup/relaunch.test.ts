import { describe, expect, it } from 'vitest'
import { localRelaunchArgs } from './relaunch.js'

describe('localRelaunchArgs', () => {
  it('resolves a relative Electron entry path before relaunch', () => {
    expect(localRelaunchArgs(
      ['/app/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron', 'dist/electron/main.js', '--flag'],
      '/repo/watchpup',
    )).toEqual(['/repo/watchpup/dist/electron/main.js', '--flag'])
  })

  it('keeps an absolute entry path unchanged', () => {
    expect(localRelaunchArgs(['/electron', '/repo/dist/electron/main.js'], '/other')).toEqual([
      '/repo/dist/electron/main.js',
    ])
  })
})
