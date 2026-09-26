// test.mjs — 端到端验证引擎 + Web UI（模拟 Android 宿主的启动方式）
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 模拟宿主：先给定沙箱数据目录与固定端口，再加载引擎
const sandbox = mkdtempSync(join(tmpdir(), 'freeroute-test-'))
process.env.FREEROUTE_HOME = sandbox
process.env.HOME = sandbox
process.env.DSH_HOME = join(sandbox, '.dsh')
process.env.FREEROUTE_PORT = '18787'

const { startEngine } = await import('./start.mjs')
const port = await startEngine()
console.log('--- 引擎已启动, port =', port, 'home =', sandbox, '---')
const base = 'http://127.0.0.1:' + port

async function check(name, url, opts) {
  try {
    const r = await fetch(url, opts)
    const ct = r.headers.get('content-type') || ''
    let detail = ''
    if (ct.includes('json')) detail = JSON.stringify(await r.json()).slice(0, 150)
    else detail = (await r.text()).length + ' bytes'
    console.log(`[${r.status}] ${name} -> ${detail}`)
    return { status: r.status, json: ct.includes('json') }
  } catch (e) {
    console.log(`[ERR] ${name} -> ${e.message}`)
    return { status: 0 }
  }
}

const post = (m, a) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ method: m, args: a || {} }) })

await check('health', base + '/freeroute/health')
await check('models', base + '/freeroute/v1/models')
await check('rpc state', base + '/freeroute/rpc', post('state'))
await check('rpc engineInfo', base + '/freeroute/rpc', post('engineInfo'))
await check('rpc log', base + '/freeroute/rpc', post('log', { tail: 3 }))
await check('rpc catalogSync', base + '/freeroute/rpc', post('catalogSync'))
await check('rpc unknown', base + '/freeroute/rpc', post('nope'))
await check('webui index', base + '/freeroute/app/')
await check('webui css', base + '/freeroute/app/app.css')
await check('webui js', base + '/freeroute/app/app.js')
await check('chat (无 Key 应 502)', base + '/freeroute/v1/chat/completions',
  { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'auto', messages: [{ role: 'user', content: 'hi' }] }) })
await check('unknown route', base + '/nope')

console.log('--- 测试完成 ---')
process.exit(0)
