// build-engine.mjs: 把 freeroute-dynamic/host.js 编译成独立可运行的 Node 引擎模块
// 复刻 scripts/build-static.mjs 的变换，但去掉 Typert Remote 依赖：
//   harness.handle RPC 循环 -> 收集到模块级 rpcMap；导出 apply() 与 getRpc()
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

const hostPath = join(root, '..', 'dsh-freeroute', 'freeroute-dynamic', 'host.js')
const src = readFileSync(hostPath, 'utf8')

const marker = "return {\n  inject: ['llm', 'timer', 'settings', 'credentials', 'subprocess'],\n  apply(ctx) {"
const i = src.indexOf(marker)
if (i < 0) throw new Error('apply wrapper marker not found')
const head = src.slice(0, i)
let body = src.slice(i + marker.length)
// strip the two closers the dynamic wrapper appended: apply's `}` and the return object's `}`
body = body.replace(/\s*\}\s*\}\s*$/, '\n')

const loop = `    for (const pair of Object.entries(rpc)) {
      const name = pair[0]
      const handler = pair[1]
      ctx.effect(function () { return harness.handle(name, handler) })
    }`
if (!body.includes(loop)) throw new Error('rpc registration loop not found')
body = body.replace(loop, `    // standalone: collect RPC handlers into a module-level map
    for (const pair of Object.entries(rpc)) {
      rpcMap.set(pair[0], pair[1])
    }`)
if (body.includes('harness.handle(')) throw new Error('unexpected residual harness.handle call')

const out = `/**
 * freeroute standalone engine — free-tier model aggregation, running without dsh.
 * Assembled from dsh-freeroute src/ (dynamic body) with the Typert RPC loop
 * replaced by a module-level rpcMap. Provides an OpenAI-compatible local
 * endpoint (\`/freeroute/v1\`) plus \`/freeroute/state\` etc. RPC methods.
 */
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'

const rpcMap = new Map()

${head.trimStart()}

export function apply(ctx, _config = {}) {
  // JSON 配置文件层（~/.freeroute/freeroute.json）所需的 node 能力
  const __nodeFs = { mkdirSync, readFileSync, renameSync, statSync, writeFileSync }
  const __nodeOs = { homedir }
${body}
}

/** 收集到的 RPC handler map（name -> async handler(args)） */
export function getRpc() { return rpcMap }
`

writeFileSync(join(root, 'engine', 'engine.mjs'), out)
console.log('engine/engine.mjs written:', out.length, 'bytes')
