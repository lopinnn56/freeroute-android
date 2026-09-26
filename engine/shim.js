// dsh-freeroute 宿主服务 shim：让引擎脱离 dsh 独立运行
// 提供：llm, timer, settings, credentials, subprocess, webServer, commands,
//       agentDefaultModel, ctx（含直接属性访问 ctx.llm / ctx.timer）
//
// 关键设计：subprocess 用纯 Node（http/https/tls/zlib）模拟 curl，不依赖任何
// 外部可执行文件。这样 APK 内无需打包 curl 二进制（Android 10+ 禁止从应用
// 数据目录执行文件），同一份代码在 Termux / Linux / Android 上行为一致。

import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { connect as tlsConnect } from 'node:tls'
import { createGunzip, createInflate, createBrotliDecompress } from 'node:zlib'
import { createServer as createHttpServer } from 'node:http'

// ---------- 路径 ----------
const DATA_DIR = `${homedir()}/.freeroute`
mkdirSync(DATA_DIR, { recursive: true })
const SETTINGS_FILE = `${DATA_DIR}/settings.json`
const CREDENTIALS_FILE = `${DATA_DIR}/credentials.json`
const DEFAULT_MODEL_FILE = `${DATA_DIR}/default-model.json`

// ---------- JSON 文件存储 ----------
function readJsonFile(path, fallback) {
  try {
    if (!statSync(path).isFile()) return fallback
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch { return fallback }
}
function writeJsonFile(path, data) {
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n', 'utf8')
}

// ---------- settings 服务 ----------
let settingsData = readJsonFile(SETTINGS_FILE, {})
function settingsRegister(ns, _schema) {
  if (!settingsData[ns]) settingsData[ns] = {}
  let watchCb = null
  return {
    get: () => settingsData[ns],
    watch: (cb) => { watchCb = cb; return () => { if (watchCb === cb) watchCb = null } }
  }
}
function settingsUpdate(ns, patch) {
  if (!settingsData[ns]) settingsData[ns] = {}
  Object.assign(settingsData[ns], patch)
  writeJsonFile(SETTINGS_FILE, settingsData)
}
function settingsMutate(ns, operations) {
  if (!settingsData[ns]) settingsData[ns] = {}
  for (const op of operations || []) {
    if (op && op.op === 'set') settingsData[ns][op.path] = op.value
    else if (op && op.op === 'unset') delete settingsData[ns][op.path]
  }
  writeJsonFile(SETTINGS_FILE, settingsData)
}
function settingsReplace(ns, data) {
  settingsData[ns] = data
  writeJsonFile(SETTINGS_FILE, settingsData)
}
function settingsDescribe() {
  return Object.entries(settingsData).map(([ns, user]) => ({ ns, user }))
}
function settingsSection(ns) { return settingsData[ns] || null }

// ---------- credentials 服务 ----------
let credentialsData = readJsonFile(CREDENTIALS_FILE, {})
function credentialsResolve(ref) {
  const val = credentialsData[ref]
  return val !== undefined && val !== null ? { configured: true, value: val } : null
}
function credentialsSet(ref, value) {
  credentialsData[ref] = value
  writeJsonFile(CREDENTIALS_FILE, credentialsData)
}
function credentialsUnset(ref) {
  delete credentialsData[ref]
  writeJsonFile(CREDENTIALS_FILE, credentialsData)
}
function credentialsDescribe(ref) {
  const val = credentialsData[ref]
  return val !== undefined && val !== null
    ? { configured: true, source: 'file', writable: true, value: val }
    : { configured: false, source: null, writable: false }
}

// ============================================================
// subprocess：纯 JS 模拟 curl
// ============================================================
// freeroute 的 transport.js / http.js 只以固定几种形态调用 curl：
//   [curl, -sS, -N, --connect-timeout, N, (--speed-limit/--speed-time/--max-time),
//    (--proxy P), -X POST, URL, -H k:v..., --data-binary @-, -w TRAILER]
//   [curl, -sS, -L, --connect-timeout, N, (--proxy P), -H k:v..., URL, -w TRAILER]
// 这里解析这些参数并用 Node 原生 HTTP 复现同样的流式语义。

function parseCurlArgv(argv) {
  const spec = {
    url: '', method: 'GET', headers: {}, proxy: null, data: null,
    followRedirects: false, connectTimeoutMs: 15000, maxTimeMs: 0,
    speedTimeSec: 0, writeOut: null, redirects: 0
  }
  const positionals = []
  let i = 1
  while (i < argv.length) {
    const a = argv[i]
    if (a === '-sS' || a === '-s' || a === '-S' || a === '-N' || a === '-#') { i++; continue }
    if (a === '-L') { spec.followRedirects = true; i++; continue }
    if (a === '-X' || a === '--request') { spec.method = String(argv[i + 1] || 'GET').toUpperCase(); i += 2; continue }
    if (a === '-H' || a === '--header') {
      const h = String(argv[i + 1] || '')
      const idx = h.indexOf(':')
      if (idx > 0) spec.headers[h.slice(0, idx).trim()] = h.slice(idx + 1).trim()
      i += 2; continue
    }
    if (a === '--proxy' || a === '-x') { spec.proxy = argv[i + 1]; i += 2; continue }
    if (a === '--connect-timeout') { spec.connectTimeoutMs = (Number(argv[i + 1]) || 15) * 1000; i += 2; continue }
    if (a === '--max-time' || a === '-m') { spec.maxTimeMs = (Number(argv[i + 1]) || 0) * 1000; i += 2; continue }
    if (a === '--speed-time' || a === '--speed-limit') {
      // --speed-time N：N 秒内收不到字节即中止（curl 的读空闲超时）。
      // --speed-limit 的数值本身无关紧要，配合 --speed-time 才有意义。
      if (a === '--speed-time') spec.speedTimeSec = Number(argv[i + 1]) || 0
      i += 2; continue
    }
    if (a === '--data-binary' || a === '--data' || a === '-d' || a === '--data-raw') {
      spec.data = argv[i + 1]; i += 2; continue
    }
    if (a === '-w' || a === '--write-out') { spec.writeOut = argv[i + 1]; i += 2; continue }
    if (a === '--compressed') { i++; continue }
    if (a.startsWith('-')) { i++; continue }
    positionals.push(a); i++
  }
  if (positionals.length > 0) spec.url = positionals[positionals.length - 1]
  return spec
}

function hasHeader(headers, name) {
  const lower = name.toLowerCase()
  for (const k of Object.keys(headers)) if (k.toLowerCase() === lower) return true
  return false
}

// 发起一次请求（含代理与重定向），resolve 出响应流
function doRequest(spec, bodyBuf, holder) {
  return new Promise((resolve, reject) => {
    let url
    try { url = new URL(spec.url) } catch (e) { reject(new Error('无效 URL: ' + spec.url)); return }
    const isHttps = url.protocol === 'https:'
    const headers = Object.assign({}, spec.headers)
    // curl 默认不发 Accept-Encoding；仅在显式 --compressed 时才需要。这里保持不发，
    // 让上游返回 identity，避免额外的解压分支。
    if (bodyBuf && bodyBuf.length > 0 && !hasHeader(headers, 'content-length') && !hasHeader(headers, 'transfer-encoding')) {
      headers['content-length'] = String(bodyBuf.length)
    }
    const opts = { method: spec.method, headers: headers }
    if (spec.connectTimeoutMs) opts.timeout = spec.connectTimeoutMs

    const onResponse = (res) => {
      // 跟随重定向
      if (spec.followRedirects && [301, 302, 303, 307, 308].indexOf(res.statusCode) >= 0 && res.headers.location) {
        res.resume()
        if (spec.redirects >= 10) { reject(new Error('重定向次数过多')); return }
        const next = new URL(res.headers.location, spec.url).toString()
        const nextSpec = Object.assign({}, spec, { url: next, redirects: spec.redirects + 1 })
        // 303 或 301/302 对 POST 转 GET（与 curl -L 一致）
        if (res.statusCode === 303 || ((res.statusCode === 301 || res.statusCode === 302) && nextSpec.method === 'POST')) {
          nextSpec.method = 'GET'
          delete nextSpec.headers['content-length']
        }
        resolve(doRequest(nextSpec, nextSpec.method === 'GET' ? null : bodyBuf, holder))
        return
      }
      resolve(res)
    }

    const send = (req) => {
      if (holder) holder.destroy = () => { try { req.destroy() } catch (e) {} }
      req.on('error', reject)
      req.on('timeout', () => { req.destroy(new Error('连接超时（' + spec.connectTimeoutMs + 'ms）')) })
      if (bodyBuf && bodyBuf.length > 0) req.write(bodyBuf)
      req.end()
    }

    try {
      if (spec.proxy) {
        const proxyUrl = new URL(spec.proxy)
        const proxyIsHttps = proxyUrl.protocol === 'https:'
        if (isHttps) {
          // HTTPS 目标经 HTTP 代理：CONNECT 隧道 + 隧道内 TLS
          const cmod = proxyIsHttps ? httpsRequest : httpRequest
          const connectReq = cmod({
            host: proxyUrl.hostname,
            port: Number(proxyUrl.port) || (proxyIsHttps ? 443 : 80),
            method: 'CONNECT',
            path: url.hostname + ':' + (url.port || 443),
            headers: { host: url.hostname + ':' + (url.port || 443) },
            timeout: spec.connectTimeoutMs || 15000
          })
          if (holder) holder.destroy = () => { try { connectReq.destroy() } catch (e) {} }
          connectReq.on('error', reject)
          connectReq.on('timeout', () => connectReq.destroy(new Error('代理连接超时')))
          connectReq.on('connect', (res, socket) => {
            if (res.statusCode !== 200) { reject(new Error('代理 CONNECT 失败 HTTP ' + res.statusCode)); socket.destroy(); return }
            const tlsSocket = tlsConnect({ socket: socket, servername: url.hostname })
            tlsSocket.on('error', reject)
            const req2 = httpsRequest({
              method: spec.method, headers: headers, path: url.pathname + url.search,
              createConnection: () => tlsSocket
            }, onResponse)
            send(req2)
          })
          connectReq.end()
        } else {
          // HTTP 目标经代理：请求行用绝对 URI，直连代理
          const mod = proxyIsHttps ? httpsRequest : httpRequest
          const req = mod({
            host: proxyUrl.hostname,
            port: Number(proxyUrl.port) || (proxyIsHttps ? 443 : 80),
            method: spec.method,
            path: url.toString(),
            headers: Object.assign({ host: url.host }, headers),
            timeout: spec.connectTimeoutMs || 15000
          }, onResponse)
          send(req)
        }
      } else {
        const mod = isHttps ? httpsRequest : httpRequest
        const req = mod(url, opts, onResponse)
        send(req)
      }
    } catch (e) { reject(e) }
  })
}

// 把一次 curl 调用变成「async iterable of Uint8Array」的 stdout 流。
// 用推入式队列把「事件回调」桥接成「for await」，并给出真正的 done Promise
// （异步生成器本身没有 .then，不能直接 await）。
function makeCurlProcess(spec, bodyBuf) {
  const queue = []
  let waiter = null
  let ended = false
  let killed = false
  let status = 0
  let exitCode = 0
  let stderrText = ''
  const holder = { destroy: () => {} }
  let idleTimer = null
  let maxTimer = null

  let doneResolve = null
  const donePromise = new Promise((res) => { doneResolve = res })

  const push = (chunk) => {
    if (killed || ended) return
    queue.push(chunk)
    if (waiter) { const w = waiter; waiter = null; w() }
  }
  const pushErr = (s) => { if (stderrText.length < 4096) stderrText += String(s) }
  const clearTimers = () => {
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null }
    if (maxTimer) { clearTimeout(maxTimer); maxTimer = null }
  }
  const finish = (code) => {
    if (ended) return
    ended = true
    exitCode = code
    clearTimers()
    // curl -w：把 %{http_code} 替换后的尾部串附加到 stdout 末尾
    if (spec.writeOut) queue.push(Buffer.from(spec.writeOut.replace(/%\{http_code\}/g, String(status)), 'utf8'))
    if (waiter) { const w = waiter; waiter = null; w() }
    doneResolve({ exitCode: exitCode })
  }
  const abort = (code, msg) => {
    pushErr(msg)
    try { holder.destroy() } catch (e) {}
    finish(code)
  }
  // --speed-time：两次数据之间超过 N 秒即中止（复现 curl 的读空闲超时）
  const touchIdle = () => {
    if (!spec.speedTimeSec) return
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => abort(28, 'curl: (28) 读空闲超过 ' + spec.speedTimeSec + ' 秒，已中止'), spec.speedTimeSec * 1000)
  }

  const terminate = () => {
    if (ended) return
    killed = true
    try { holder.destroy() } catch (e) {}
    finish(exitCode || 1)
  }
  const stdout = {
    [Symbol.asyncIterator]() { return this },
    async next() {
      for (;;) {
        if (queue.length > 0) return { value: queue.shift(), done: false }
        if (ended) return { value: undefined, done: true }
        await new Promise((res) => { waiter = res })
      }
    },
    async return() {
      terminate()
      return { value: undefined, done: true }
    }
  }

  const pump = (res) => {
    res.on('data', (chunk) => {
      if (ended) return
      touchIdle()
      push(chunk)
    })
    res.on('end', () => { if (!ended) finish(0) })
    res.on('error', (e) => {
      if (ended) return
      // 已被 terminate/abort 主动销毁时不再记连接失败（SIGTERM 语义）
      if (killed) finish(exitCode || 1)
      else abort(7, String((e && e.message) || e))
    })
  }

  ;(async () => {
    try {
      if (spec.maxTimeMs) {
        maxTimer = setTimeout(() => abort(28, 'curl: (28) 超过最大请求时长 ' + (spec.maxTimeMs / 1000) + ' 秒，已中止'), spec.maxTimeMs)
      }
      const res = await doRequest(spec, bodyBuf, holder)
      if (ended) { try { res.destroy() } catch (e) {} return }
      status = res.statusCode
      touchIdle()
      const enc = String(res.headers['content-encoding'] || '').toLowerCase()
      if (enc === 'gzip') { const d = createGunzip(); d.on('error', (e) => abort(7, String((e && e.message) || e))); res.pipe(d); pump(d) }
      else if (enc === 'deflate') { const d = createInflate(); d.on('error', (e) => abort(7, String((e && e.message) || e))); res.pipe(d); pump(d) }
      else if (enc === 'br') { const d = createBrotliDecompress(); d.on('error', (e) => abort(7, String((e && e.message) || e))); res.pipe(d); pump(d) }
      else pump(res)
    } catch (e) {
      if (killed || ended) { if (!ended) finish(exitCode || 1); return }
      abort(7, String((e && e.message) || e))
    }
  })()

  return {
    stdout: stdout,
    terminate: () => { try { stdout.return() } catch (e) {} },
    done: donePromise,
    collected: { stderr: { readFrom: () => ({ text: stderrText }) } }
  }
}

// subprocess 服务对外接口
async function resolveExecutable(name) { return name }
function spawn(options) {
  const { argv, stdio, signal, graceMs } = options
  const spec = parseCurlArgv(argv || [])
  // stdin 数据（--data-binary @-）
  let bodyBuf = null
  if (spec.data === '@-') {
    const d = stdio && stdio.stdin && typeof stdio.stdin === 'object' ? stdio.stdin.data : null
    if (d !== undefined && d !== null) bodyBuf = Buffer.isBuffer(d) ? d : Buffer.from(String(d), 'utf8')
  } else if (typeof spec.data === 'string') {
    bodyBuf = Buffer.from(spec.data, 'utf8')
  }

  const proc = makeCurlProcess(spec, bodyBuf)
  if (signal) {
    const onAbort = () => proc.terminate()
    signal.addEventListener('abort', onAbort, { once: true })
    proc.done.finally(() => { try { signal.removeEventListener('abort', onAbort) } catch {} })
  }
  return proc
}

// ============================================================
// webServer 服务
// ============================================================
const ROUTES = new Map()
function webRegister({ kind, path, handler }) {
  if (kind !== 'prefix') throw new Error('only prefix routes supported')
  ROUTES.set(path, handler)
  return () => { ROUTES.delete(path) }
}
let httpServer = null
let webPort = 0
function webStart() {
  return new Promise((resolve, reject) => {
    httpServer = createHttpServer(async (req, res) => {
      try {
        const path = String(req.url || '/').split('?')[0]
        let handler = null
        let best = -1
        for (const [prefix, h] of ROUTES) {
          if (path.startsWith(prefix) && prefix.length > best) { best = prefix.length; handler = h }
        }
        if (!handler) {
          res.writeHead(404, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: { message: 'unknown route: ' + path } }))
          return
        }
        await handler(req, res)
      } catch (err) {
        if (!res.writableEnded) {
          try {
            res.writeHead(500, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ error: { message: String((err && err.message) || err) } }))
          } catch {}
        }
      }
    })
    httpServer.on('error', reject)
    // 端口可经环境变量固定（Android 宿主需要预先知道端口才能让 WebView 加载）；
    // 未设置时监听 0 由内核分配随机端口（Termux / 本地调试）。
    const fixed = Number(process.env.FREEROUTE_PORT) || 0
    httpServer.listen(fixed, '127.0.0.1', () => {
      webPort = httpServer.address().port
      resolve(webPort)
    })
  })
}
function webStop() {
  return new Promise((resolve) => {
    if (httpServer) httpServer.close(() => { httpServer = null; resolve() })
    else resolve()
  })
}

// ---------- commands 服务（空壳） ----------
function commandsRegister(_cfg) { return () => {} }

// ---------- agentDefaultModel 服务 ----------
let defaultModelData = readJsonFile(DEFAULT_MODEL_FILE, null)
function agentCurrentSelection() { return defaultModelData }
function agentSaveSelection(sel) {
  defaultModelData = sel && typeof sel === 'object' ? sel : null
  writeJsonFile(DEFAULT_MODEL_FILE, defaultModelData)
}

// ---------- llm 服务（空壳，仅收下 adapter） ----------
const LLM_ADAPTERS = new Map()
function llmRegisterAdapter(providers, adapter) {
  for (const p of providers) LLM_ADAPTERS.set(p, adapter)
  return () => { for (const p of providers) LLM_ADAPTERS.delete(p) }
}

// ---------- timer 服务 ----------
function timerTimeout(fn, ms) { const id = setTimeout(fn, ms); return () => clearTimeout(id) }
function timerInterval(fn, ms) { const id = setInterval(fn, ms); return () => clearInterval(id) }

// ---------- 服务对象 ----------
const settingsShim = {
  register: settingsRegister, update: settingsUpdate, mutate: settingsMutate,
  replace: settingsReplace, describe: settingsDescribe, section: settingsSection
}
const credentialsShim = {
  resolve: credentialsResolve, set: credentialsSet, unset: credentialsUnset, describe: credentialsDescribe
}
const subprocessShim = { resolveExecutable, spawn }
const webServerShim = { register: webRegister, start: webStart, stop: webStop, get port() { return webPort } }
const commandsShim = { register: commandsRegister }
const agentDefaultModelShim = { currentSelection: agentCurrentSelection, saveSelection: agentSaveSelection }

// ---------- ctx 对象（context.js 用属性访问 ctx.llm / ctx.timer，其余用 ctx.get） ----------
const ctx = {
  llm: { registerAdapter: llmRegisterAdapter },
  timer: { timeout: timerTimeout, interval: timerInterval },
  get(name) {
    switch (name) {
      case 'llm': return this.llm
      case 'timer': return this.timer
      case 'settings': return settingsShim
      case 'credentials': return credentialsShim
      case 'subprocess': return subprocessShim
      case 'webServer': return webServerShim
      case 'commands': return commandsShim
      case 'agentDefaultModel': return agentDefaultModelShim
      default: return undefined
    }
  },
  effect(fn) {
    try { const d = fn(); return typeof d === 'function' ? d : () => {} } catch (e) { return () => {} }
  },
  on() { return () => {} }
}

export {
  ctx, settingsShim, credentialsShim, subprocessShim, webServerShim,
  commandsShim, agentDefaultModelShim, LLM_ADAPTERS
}
