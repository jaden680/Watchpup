import { build } from 'esbuild'
import { writeFileSync } from 'node:fs'
import './scripts/build-reminders-helper.mjs'

const common = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  external: ['electron', '@napi-rs/keyring'],
  sourcemap: true,
  logLevel: 'info',
}
await build({ ...common, entryPoints: ['electron/main.ts'], outfile: 'dist/electron/main.js' })
await build({ ...common, entryPoints: ['electron/preload.ts'], outfile: 'dist/electron/preload.js' })

// 루트 package.json이 "type":"module"이므로, dist/electron/*.js(CJS 번들)를 Node/Electron이
// ESM으로 오인하지 않도록 이 서브트리를 commonjs로 고정한다.
writeFileSync('dist/electron/package.json', JSON.stringify({ type: 'commonjs' }, null, 2) + '\n')

console.log('electron bundle done')
