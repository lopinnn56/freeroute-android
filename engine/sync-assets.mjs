// 把 engine/ + webui/ 汇入 Android assets，作为 APK 内单一事实源。
// 产物：android/app/src/main/assets/nodejs-project/{engine,webui}/
import { cpSync, mkdirSync, rmSync, existsSync, writeFileSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const dest = join(root, 'android', 'app', 'src', 'main', 'assets', 'nodejs-project')

rmSync(dest, { recursive: true, force: true })
mkdirSync(join(dest, 'engine'), { recursive: true })
mkdirSync(join(dest, 'webui'), { recursive: true })

for (const f of ['shim.js', 'engine.mjs', 'start.mjs']) {
  cpSync(join(root, 'engine', f), join(dest, 'engine', f))
}
for (const f of ['index.html', 'app.css', 'app.js']) {
  cpSync(join(root, 'webui', f), join(dest, 'webui', f))
}
// 宿主 Node 以 ESM 运行：package.json 声明 type:module 并固定入口
writeFileSync(join(dest, 'package.json'), JSON.stringify({
  name: 'freeroute-engine',
  version: JSON.parse(readFileSync(join(root, 'engine', 'package.json'), 'utf8') || '{"version":"0.0.0"}').version || '0.0.0',
  type: 'module',
  private: true,
  main: 'engine/start.mjs'
}, null, 2) + '\n', 'utf8')

console.log('assets 就绪 ->', dest)
console.log('  engine/: shim.js engine.mjs start.mjs package.json')
console.log('  webui/:  index.html app.css app.js')
