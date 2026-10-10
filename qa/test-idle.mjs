// A Table Talk server started by anything other than a Claude Code session launched with the
// Table Talk channel flag must stay off the port.   node qa/test-idle.mjs
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const home = mkdtempSync(join(tmpdir(), 'tt-idle-'))
const PORT = 18798
const child = spawn(process.execPath, [join(root, 'claude-plugin', 'server.mjs')], {
  env: { ...process.env, USERPROFILE: home, HOME: home, TABLE_TALK_PORT: String(PORT), TABLE_TALK_LISTEN: '' },
  stdio: ['pipe', 'ignore', 'inherit'],
})
await new Promise(r => setTimeout(r, 6000))
let reachable = true
try { await fetch(`http://127.0.0.1:${PORT}/health`) } catch { reachable = false }
const log = readFileSync(join(home, '.claude', 'channels', 'table-talk', 'debug.log'), 'utf8')
child.stdin.end(); child.kill()
rmSync(home, { recursive: true, force: true })
const ok = !reachable && /staying idle/.test(log)
console.log(`${ok ? 'PASS' : 'FAIL'}  a non-channel session leaves the port free${ok ? '' : `  -> reachable=${reachable} log=${log}`}`)
process.exit(ok ? 0 : 1)
