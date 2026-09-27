// start.mjs — 引擎启动入口（Termux 本地验证 / Android 宿主共用）
//
// 环境准备必须发生在「加载引擎」之前：ESM 的 import 会被提升并在模块体之前求值，
// 而 shim.js / engine.mjs 都在模块顶层读取 HOME 来定位配置目录。因此这里改用
// 动态 import —— 先落实 HOME / 数据目录 / 端口 / 工作目录，再加载引擎。
//
// 启动参数（Android 宿主 EngineService 传入）：
//   --home=<dir>   数据目录（配置与密钥落在此处，默认取 $HOME）
//   --port=<n>     固定监听端口（默认随机；Android 需预先知道端口）
import { appendFileSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = resolve(HERE, '..') // nodejs-project/

// ---------- 1. 启动参数 ----------
function argValue(name) {
  const prefix = '--' + name + '='
  for (const a of process.argv.slice(2)) if (a.indexOf(prefix) === 0) return a.slice(prefix.length)
  const i = process.argv.indexOf('--' + name)
  if (i >= 0 && process.argv[i + 1] && process.argv[i + 1].indexOf('--') !== 0) return process.argv[i + 1]
  return null
}

// 数据目录优先级：--home > FREEROUTE_HOME > HOME > 项目根
const home = argValue('home') || process.env.FREEROUTE_HOME || process.env.HOME || PROJECT_ROOT
process.env.HOME = home
process.env.FREEROUTE_HOME = home
// dsh 风格配置（~/.dsh/freeroute.json）与日志都落在数据目录内
if (!process.env.DSH_HOME) process.env.DSH_HOME = join(home, '.dsh')

const portArg = argValue('port') || process.env.FREEROUTE_PORT
if (portArg) process.env.FREEROUTE_PORT = String(portArg)

// 引擎按相对路径加载 webui，固定工作目录到项目根
try { process.chdir(PROJECT_ROOT) } catch (e) { /* 只读安装目录时忽略 */ }

// ---------- 启动里程碑日志（与宿主的 boot.log 同一文件） ----------
// 宿主 BootLog 清空后只写宿主步骤；引擎把每一步 milestone 追加进同一文件，
// 失败页直接展示，即可看到引擎卡在哪一行。同名 msg 也走 console → logcat。
let logFile = ''
function bootLog(msg) {
  const d = new Date()
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  const ss = String(d.getSeconds()).padStart(2, '0')
  const ms = String(d.getMilliseconds()).padStart(3, '0')
  try { console.log('[engine] ' + msg) } catch {}
  if (!logFile) {
    const base = process.env.HOME || ''
    if (base && base[0] === '/' && existsSync(base)) logFile = join(base, 'boot.log')
  }
  if (logFile) { try { appendFileSync(logFile, `${hh}:${mm}:${ss}.${ms} [engine] ${msg}\n`) } catch {} }
}
bootLog('argv: ' + process.argv.slice(1).join(' '))
bootLog('home=' + home + '  port=' + (process.env.FREEROUTE_PORT || '随机') + '  dsh=' + (process.env.DSH_HOME || '-'))

// ---------- 2. 加载引擎（此时 HOME 已就绪） ----------
bootLog('加载 shim.js …')
const { ctx, webServerShim } = await import('./shim.js')
bootLog('加载 engine.mjs …')
const { apply, getRpc } = await import('./engine.mjs')

const STARTED_AT = Date.now()
bootLog('apply(engine) …')
apply(ctx)
const rpc = getRpc()
bootLog('apply 完成，注册 RPC 与 Web 路由 …')

// ---------- 3. 补充 RPC ----------
// 日志读取（原插件只写文件，不提供读取接口）
function resolveLogPath() {
  if (process.env.DSH_HOME) return join(process.env.DSH_HOME, 'freeroute', 'freeroute.log')
  return join(process.env.HOME || '/tmp', '.dsh', 'freeroute', 'freeroute.log')
}
rpc.set('freeroute.log', async function (args) {
  const tail = args && Number(args.tail) > 0 ? Math.min(Number(args.tail), 2000) : 400
  try {
    const path = resolveLogPath()
    if (!existsSync(path)) return { ok: true, lines: [], path: path, total: 0 }
    const all = readFileSync(path, 'utf8').split('\n').filter(function (l) { return l.length > 0 })
    return { ok: true, lines: all.slice(-tail), path: path, total: all.length }
  } catch (e) {
    return { ok: false, lines: [], error: String((e && e.message) || e) }
  }
})
// 引擎运行信息（端口 / 启动时间 / 版本），供 UI 顶栏显示
rpc.set('freeroute.engine-info', async function () {
  return {
    ok: true,
    port: webServerShim.port,
    startedAt: STARTED_AT,
    uptimeMs: Date.now() - STARTED_AT,
    pid: process.pid,
    node: process.version,
    platform: process.platform,
    home: process.env.FREEROUTE_HOME || null
  }
})
rpc.set('freeroute.clear-log', async function () {
  try {
    const path = resolveLogPath()
    if (existsSync(path)) writeFileSync(path, '', 'utf8')
    return { ok: true }
  } catch (e) { return { ok: false, error: String((e && e.message) || e) } }
})
// 停机（Android 侧调用，让 Node 优雅退出）
rpc.set('freeroute.shutdown', async function () {
  setTimeout(function () { shutdown('RPC') }, 50)
  return { ok: true }
})

// ---------- 4. Web UI 的 JSON-RPC 别名 ----------
const RPC_METHOD_ALIAS = {
  state: 'freeroute.state',
  setKey: 'freeroute.set-key',
  clearKey: 'freeroute.clear-key',
  applyPatch: 'freeroute.apply-patch',
  removeUpstream: 'freeroute.remove-upstream',
  restoreUpstream: 'freeroute.restore-upstream',
  catalogSync: 'freeroute.catalog.sync',
  freellmapiSync: 'freeroute.freellmapi.sync',
  probe: 'freeroute.probe',
  test: 'freeroute.test',
  setDefault: 'freeroute.set-default',
  getKeys: 'freeroute.get-keys',
  log: 'freeroute.log',
  clearLog: 'freeroute.clear-log',
  engineInfo: 'freeroute.engine-info',
  shutdown: 'freeroute.shutdown'
}

function corsHeaders() {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type'
  }
}

function rpcHandler(req, res) {
  Promise.resolve().then(async function () {
    if (req.method === 'OPTIONS') { res.writeHead(204, corsHeaders()); res.end(); return }
    if (req.method !== 'POST') {
      res.writeHead(405, Object.assign({ 'content-type': 'application/json' }, corsHeaders()))
      res.end(JSON.stringify({ ok: false, error: { message: 'method not allowed' } }))
      return
    }
    const dec = new TextDecoder()
    let raw = ''
    for await (const c of req) raw += dec.decode(c, { stream: true })
    raw += dec.decode()
    let body
    try { body = JSON.parse(raw) } catch { body = {} }
    const method = typeof body.method === 'string' ? body.method : ''
    const args = body.args || {}
    let rpcName = RPC_METHOD_ALIAS[method] || method
    let handler = rpc.get(rpcName)
    if (!handler) { rpcName = 'freeroute.' + rpcName; handler = rpc.get(rpcName) }
    if (!handler) {
      res.writeHead(404, Object.assign({ 'content-type': 'application/json' }, corsHeaders()))
      res.end(JSON.stringify({ ok: false, error: { message: 'unknown rpc method: ' + method } }))
      return
    }
    try {
      const result = await handler(args)
      res.writeHead(200, Object.assign({ 'content-type': 'application/json' }, corsHeaders()))
      res.end(JSON.stringify({ ok: true, data: result }))
    } catch (err) {
      res.writeHead(500, Object.assign({ 'content-type': 'application/json' }, corsHeaders()))
      res.end(JSON.stringify({ ok: false, error: { message: String((err && err.message) || err), code: (err && err.code) || 'UNKNOWN' } }))
    }
  }).catch(function (e) {
    try {
      res.writeHead(500, Object.assign({ 'content-type': 'application/json' }, corsHeaders()))
      res.end(JSON.stringify({ ok: false, error: { message: String((e && e.message) || e) } }))
    } catch {}
  })
}

// ---------- 5. 静态 Web UI ----------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon'
}
let WEB_ROOT = join(PROJECT_ROOT, 'webui')
export function setWebRoot(dir) { WEB_ROOT = dir }

function uiHandler(req, res) {
  Promise.resolve().then(async function () {
    if (!WEB_ROOT) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end('<h1>freeroute engine</h1><p>Web UI 未挂载。API: <a href="/freeroute/v1/models">/freeroute/v1/models</a></p>')
      return
    }
    // 剥掉路由前缀 /freeroute/app，剩余部分才是 WEB_ROOT 下的相对路径
    let path = String(req.url || '/').split('?')[0]
    path = path.replace(/^\/freeroute\/app/, '') || '/'
    let rel = path === '/' ? '/index.html' : path
    rel = rel.replace(/\.\.+/g, '') // 目录穿越防护
    const file = join(WEB_ROOT, rel)
    try {
      if (!existsSync(file) || !statSync(file).isFile()) {
        const index = join(WEB_ROOT, 'index.html') // SPA 回退
        if (existsSync(index)) {
          res.writeHead(200, { 'content-type': MIME['.html'] })
          res.end(readFileSync(index))
          return
        }
        res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found'); return
      }
      res.writeHead(200, { 'content-type': MIME[file.slice(file.lastIndexOf('.'))] || 'application/octet-stream' })
      res.end(readFileSync(file))
    } catch (e) {
      res.writeHead(500, { 'content-type': 'text/plain' }); res.end(String((e && e.message) || e))
    }
  })
}

webServerShim.register({ kind: 'prefix', path: '/freeroute/rpc', handler: rpcHandler })
webServerShim.register({ kind: 'prefix', path: '/freeroute/app', handler: uiHandler })

/** 启动引擎，返回实际监听端口 */
export async function startEngine() {
  return await webServerShim.start()
}

// 优雅停机：SIGTERM/SIGINT（Android 宿主经 freeroute.shutdown RPC 触发）
let shuttingDown = false
async function shutdown(sig) {
  if (shuttingDown) return
  shuttingDown = true
  console.log('[freeroute engine] 收到 ' + sig + '，正在停机…')
  try { await webServerShim.stop() } catch (e) {}
  process.exit(0)
}
process.on('SIGTERM', function () { shutdown('SIGTERM') })
process.on('SIGINT', function () { shutdown('SIGINT') })

export { rpc, RPC_METHOD_ALIAS }

// ---------- 6. 直接运行时（node start.mjs） ----------
const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
// Android 宿主显式传 --start（并一贯传 --port）：规避不同壳下 isMain 判定差异，
// 保证引擎一定启动。本地直接 node start.mjs 时 isMain 仍生效。
const wantsStart = isMain || process.argv.indexOf('--start') >= 0 ||
  process.argv.some(function (a) { return a === '--port' || a.indexOf('--port=') === 0 })
bootLog('isMain=' + isMain + '  wantsStart=' + wantsStart)
if (wantsStart) {
  bootLog('startEngine() …')
  startEngine().then(function (port) {
    bootLog('已监听 http://127.0.0.1:' + port + '/freeroute/v1')
    console.log('[freeroute engine] OpenAI 兼容端点: http://127.0.0.1:' + port + '/freeroute/v1')
    console.log('[freeroute engine] 健康检查:      http://127.0.0.1:' + port + '/freeroute/health')
    console.log('[freeroute engine] RPC 接口:       http://127.0.0.1:' + port + '/freeroute/rpc')
    console.log('[freeroute engine] Web UI:         http://127.0.0.1:' + port + '/freeroute/app/')
    console.log('[freeroute engine] 数据目录:       ' + (process.env.FREEROUTE_HOME || process.env.HOME))
  }).catch(function (e) {
    const m = ((e && e.stack) || String(e)).split('\n')[0]
    bootLog('启动失败: ' + m)
    console.error('[freeroute engine] 启动失败:', e)
    process.exit(1)
  })
}

// 任何未捕获的异常/拒绝都落盘 + 进 logcat：失败页即可见，而非静默卡住
function crashLog(tag, err) {
  const m = err && err.stack ? err.stack : String(err)
  bootLog(tag + ': ' + m.split('\n')[0])
  console.error('[freeroute engine] ' + tag, err)
}
process.on('unhandledRejection', function (r) { crashLog('unhandledRejection', r) })
process.on('uncaughtException', function (e) { crashLog('uncaughtException', e) })
