// Drives claude-plugin/server.mjs the way Claude Code does (MCP over stdio) and the way the Foundry
// module does (HTTP), then checks what Claude would receive.  Run: node qa/test-server.mjs
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const home = mkdtempSync(join(tmpdir(), 'table-talk-home-'))
const PORT = 18796
const base = `http://127.0.0.1:${PORT}`

const child = spawn(process.execPath, [join(root, 'claude-plugin', 'server.mjs')], {
  env: { ...process.env, USERPROFILE: home, HOME: home, TABLE_TALK_PORT: String(PORT), TABLE_TALK_LISTEN: "1" },
  stdio: ['pipe', 'pipe', 'inherit'],
})

const inbox = []
let out = ''
child.stdout.setEncoding('utf8')
child.stdout.on('data', d => {
  out += d
  let nl
  while ((nl = out.indexOf('\n')) >= 0) {
    inbox.push(JSON.parse(out.slice(0, nl)))
    out = out.slice(nl + 1)
  }
})
const rpc = msg => child.stdin.write(JSON.stringify(msg) + '\n')
const sleep = ms => new Promise(r => setTimeout(r, ms))
async function waitFor(pred, what) {
  for (let i = 0; i < 100; i++) {
    const hit = inbox.find(pred)
    if (hit) return hit
    await sleep(30)
  }
  throw new Error(`timed out waiting for ${what}`)
}

let failed = 0
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  -> ${detail}`}`)
  if (!ok) failed++
}

const post = (body, origin, type = 'application/json') =>
  fetch(`${base}/batch`, {
    method: 'POST',
    headers: { 'content-type': type, ...(origin ? { origin } : {}) },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })

try {
  rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2026-07-28', capabilities: {}, clientInfo: { name: 'qa', version: '0' } } })
  const init = await waitFor(m => m.id === 1, 'initialize result')
  check('declares the claude/channel capability', !!init.result?.capabilities?.experimental?.['claude/channel'])
  check('refuses protocol 2026-07-28 (channels need the earlier handshake)', init.result?.protocolVersion === '2025-11-25', init.result?.protocolVersion)
  check('sends instructions for Claude', /table-talk/.test(init.result?.instructions ?? ''))
  rpc({ jsonrpc: '2.0', method: 'notifications/initialized' })
  rpc({ jsonrpc: '2.0', id: 2, method: 'ping' })
  check('answers ping', !!(await waitFor(m => m.id === 2, 'ping')).result)
  rpc({ jsonrpc: '2.0', id: 3, method: 'tools/list' })
  check('unknown methods get a JSON-RPC error', (await waitFor(m => m.id === 3, 'tools/list')).error?.code === -32601)

  // the HTTP side needs a moment to bind
  let health
  for (let i = 0; i < 50 && !health; i++) {
    try { health = await (await fetch(`${base}/health`, { headers: { origin: 'http://localhost:30000' } })).json() } catch { await sleep(50) }
  }
  check('health answers a local Foundry page', health?.ok === true, JSON.stringify(health))

  const pre = await fetch(`${base}/batch`, { method: 'OPTIONS', headers: { origin: 'https://mygame.forge-vtt.com', 'access-control-request-method': 'POST', 'access-control-request-private-network': 'true' } })
  check('preflight allows private-network access', pre.status === 204 && pre.headers.get('access-control-allow-private-network') === 'true')

  const lines = [
    { character: 'Big Elf', player: 'Shlo', text: 'I want to just fucking bash the lock in.' },
    { character: 'Gizmo', player: 'Techie', text: '  While he does that\n I watch the hallway.  ' },
    { character: 'GM', player: 'GM', text: '   ' },
  ]
  const r1 = await post({ lines, world: 'the-long-rest' }, 'http://localhost:30000')
  const j1 = await r1.json()
  check('batch from local Foundry is accepted', r1.status === 200 && j1.delivered === 2, JSON.stringify(j1))
  const note = await waitFor(m => m.method === 'notifications/claude/channel', 'channel notification')
  const expected = 'Spoken at the table (voice transcripts, 2 lines):\nBig Elf (Shlo): "I want to just fucking bash the lock in."\nGizmo (Techie): "While he does that I watch the hallway."'
  check('Claude receives the exact words, labelled by character', note.params.content === expected, JSON.stringify(note.params.content))
  check('meta carries line count and world', note.params.meta.lines === '2' && note.params.meta.world === 'the-long-rest', JSON.stringify(note.params.meta))

  const r2 = await post({ lines }, 'https://evil.example')
  const j2 = await r2.json()
  check('a page the GM never allowed is refused', r2.status === 403 && j2.fix === 'Allow Table Talk for https://evil.example', JSON.stringify(j2))
  check('the refusal is readable by the page (CORS)', r2.headers.get('access-control-allow-origin') === 'https://evil.example')

  mkdirSync(join(home, '.claude', 'channels', 'table-talk'), { recursive: true })
  writeFileSync(join(home, '.claude', 'channels', 'table-talk', 'config.json'), JSON.stringify({ allowedOrigins: ['https://mygame.forge-vtt.com'] }))
  const r3 = await post({ lines: [lines[0]] }, 'https://mygame.forge-vtt.com')
  check('an allowed remote origin works without restarting', r3.status === 200, String(r3.status))

  check('form-encoded posts are refused', (await post('x=1', 'http://localhost:30000', 'text/plain')).status === 415)
  check('empty batches are refused', (await post({ lines: [] }, 'http://localhost:30000')).status === 400)
  check('all-blank batches are refused', (await post({ lines: [lines[2]] }, 'http://localhost:30000')).status === 400)
  const before = inbox.filter(m => m.method === 'notifications/claude/channel').length
  check('only accepted batches reach Claude', before === 2, String(before))
} catch (err) {
  check('run', false, err.stack)
} finally {
  child.stdin.end()
  await sleep(200)
  child.kill()
  rmSync(home, { recursive: true, force: true })
}
console.log(failed ? `\n${failed} failed` : '\nall passed')
process.exit(failed ? 1 : 0)
