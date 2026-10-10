// End-to-end test in the throwaway Foundry (qa/foundry.ps1, port 30005): real Chrome, a spoken WAV as
// each player's microphone, the real channel server, and a stand-in for Claude Code reading what
// the channel pushes.   node qa/e2e.mjs [--headed]
import { chromium } from 'file:///D:/dev/vnv/node_modules/playwright/index.mjs'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(root, 'qa', 'out')
const BASE = `http://localhost:${process.env.QA_PORT || 30005}`
const CHANNEL_PORT = 18797
const headless = !process.argv.includes('--headed')
const sleep = ms => new Promise(r => setTimeout(r, ms))
const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  [${detail}]` : ''}`)
}

// --- the channel server, with this script playing Claude Code on its stdio ----------------------
const home = mkdtempSync(join(tmpdir(), 'tt-e2e-'))
const channel = spawn(process.execPath, [join(root, 'claude-plugin', 'server.mjs')], {
  env: { ...process.env, USERPROFILE: home, HOME: home, TABLE_TALK_PORT: String(CHANNEL_PORT), TABLE_TALK_LISTEN: "1" },
  stdio: ['pipe', 'pipe', 'inherit'],
})
const pushed = []
let buf = ''
channel.stdout.setEncoding('utf8')
channel.stdout.on('data', d => {
  buf += d
  let nl
  while ((nl = buf.indexOf('\n')) >= 0) {
    const msg = JSON.parse(buf.slice(0, nl))
    buf = buf.slice(nl + 1)
    if (msg.method === 'notifications/claude/channel') pushed.push(msg.params)
  }
})
channel.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'e2e', version: '0' } } }) + '\n')

// --- browsers: one per person, each with its own "microphone" -----------------------------------
async function person(user, wav, { viewport = { width: 1400, height: 900 } } = {}) {
  const browser = await chromium.launch({
    channel: 'chrome',
    headless,
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${wav}`, '--autoplay-policy=no-user-gesture-required'],
  })
  const ctx = await browser.newContext({ viewport, permissions: ['microphone'] })
  const page = await ctx.newPage()
  page.on('pageerror', e => console.log(`[${user} pageerror]`, e.message.slice(0, 300)))
  page.on('console', m => { if (/table-talk/i.test(m.text())) console.log(`[${user} console]`, m.text().slice(0, 300)) })
  await page.goto(`${BASE}/join`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('select[name=userid], input[name=username]')
  if (await page.locator('select[name=userid]').count()) await page.selectOption('select[name=userid]', { label: user })
  else await page.fill('input[name=username]', user)
  await page.click('button[name=join]')
  await page.waitForURL('**/game', { timeout: 60000 })
  await page.waitForFunction(() => window.game?.ready, null, { timeout: 120000 })
  await page.addStyleTag({ content: '.tour,.tour-overlay,.tour-fadeout,.tour-center-step{display:none!important}' })
  await page.waitForTimeout(1500)
  return { browser, page, user }
}

async function reloadReady(page) {
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => window.game?.ready, null, { timeout: 120000 })
  await page.waitForTimeout(1500)
}

async function hold(page, ms) {
  await page.evaluate(() => document.activeElement?.blur?.())
  await page.keyboard.down('g')
  await page.waitForTimeout(ms)
  await page.keyboard.up('g')
}

const statusOf = page => page.evaluate(() => {
  const p = document.querySelector('#table-talk .tt-status')
  return { text: p?.textContent ?? null, kind: p?.dataset.kind ?? null }
})

async function waitStatus(page, kinds, timeout) {
  const end = Date.now() + timeout
  let last
  while (Date.now() < end) {
    last = await statusOf(page)
    if (kinds.includes(last.kind)) return last
    await sleep(300)
  }
  return last
}

const shot = (page, name) => page.locator('#table-talk').screenshot({ path: join(OUT, `${name}.png`) }).catch(e => console.log('shot failed', name, e.message))

let gm, a, b
try {
  gm = await person('Gamemaster', join(OUT, 'sendit.wav'))
  await gm.page.evaluate(() => game.settings.set('table-talk', 'engine', 'whisper')).catch(() => {})
  const active = await gm.page.evaluate(() => game.modules.get('table-talk')?.active)
  if (!active) {
    await gm.page.evaluate(async () => {
      const config = foundry.utils.deepClone(game.settings.get('core', 'moduleConfiguration'))
      config['table-talk'] = true
      config.familiar = false
      await game.settings.set('core', 'moduleConfiguration', config)
    })
    await sleep(1500)
    await reloadReady(gm.page)
  }
  check('module is active in the world', await gm.page.evaluate(() => game.modules.get('table-talk')?.active === true))
  await gm.page.evaluate(port => game.settings.set('table-talk', 'channelUrl', `http://127.0.0.1:${port}`), CHANNEL_PORT)
  await gm.page.evaluate(() => localStorage.removeItem(`table-talk.queue.${game.world.id}`))
  await gm.page.evaluate(() => game.settings.set('table-talk', 'engine', 'whisper'))
  await reloadReady(gm.page)
  await gm.page.waitForFunction(() => document.querySelector('#table-talk .tt-link')?.dataset.state === 'ok', null, { timeout: 15000 }).catch(() => {})
  check('GM sees Claude Code as listening (green dot)', await gm.page.evaluate(() => document.querySelector('#table-talk .tt-link')?.dataset.state) === 'ok')
  await shot(gm.page, '01-gm-empty')

  a = await person("Kestrel's Player", join(OUT, 'lock.wav'))
  check('player panel shows the hold-to-talk button', await a.page.locator('#table-talk .tt-talk').isVisible())
  check('player does not see the GM queue', await a.page.locator('#table-talk .tt-gm').isHidden())
  await shot(a.page, '02-player-idle')

  // Chrome's built-in recognition ignores the fake microphone and listens to the real one, so
  // automated runs only ever use Whisper (fed from the WAV through getUserMedia).
  await a.page.evaluate(() => game.settings.set('table-talk', 'engine', 'whisper'))
  const engineA = 'whisper'
  await hold(a.page, 5500)
  const sa = await waitStatus(a.page, ['ok', 'warn', 'error'], 300000)
  console.log('player A status:', JSON.stringify(sa))
  await shot(a.page, '03-player-after-talking')

  // Player B: Whisper running in the browser
  b = await person('Second Player', join(OUT, 'hallway.wav'))
  await b.page.evaluate(() => game.settings.set('table-talk', 'engine', 'whisper'))
  await hold(b.page, 5500)
  const sb = await waitStatus(b.page, ['ok', 'warn', 'error'], 300000)
  console.log('player B status:', JSON.stringify(sb))
  await shot(b.page, '04-player-b-whisper')

  await sleep(1500)
  const queued = await gm.page.evaluate(() => [...document.querySelectorAll('#table-talk .tt-queue li:not(.tt-empty)')].map(li => li.innerText.replace(/\s+/g, ' ').trim()))
  console.log('GM queue:', JSON.stringify(queued, null, 1))
  check('GM queue holds both players\' lines', queued.length === 2, `${queued.length} lines`)
  check('line A is labelled with the linked character', /Kestrel Vane/.test(queued.join(' | ')))
  check('line A kept the exact words', /bash the lock/i.test(queued.join(' ')))
  check('line A kept the swearing', /fucking/i.test(queued.join(' ')), queued.find(q => /lock/i.test(q)) ?? '')
  check('line B (Whisper) kept the words', /hallway/i.test(queued.join(' ')))
  check('player sees their line is waiting', /Waiting for the GM|waiting for the GM/i.test((await statusOf(a.page)).text ?? ''))
  await shot(gm.page, '05-gm-queue')

  // GM sends by voice ("Okay GM, send it."), falling back to Shift+G
  check('GM is on Whisper too (never the real microphone)', await gm.page.evaluate(() => game.settings.get('table-talk', 'engine')) === 'whisper')
  await hold(gm.page, 4500)
  await waitStatus(gm.page, ['ok', 'warn', 'error'], 120000)
  await sleep(2000)
  let sentBy = 'voice'
  if (!pushed.length) {
    console.log('spoken send did not fire; GM status:', JSON.stringify(await statusOf(gm.page)))
    sentBy = 'Shift+G'
    await gm.page.keyboard.press('Shift+G')
    await sleep(3000)
  }
  check(`GM sent the queue (${sentBy})`, pushed.length === 1, `${pushed.length} pushes`)
  if (pushed[0]) {
    console.log('\n--- what Claude Code receives ---\n' + pushed[0].content + '\n--- meta ' + JSON.stringify(pushed[0].meta) + '\n')
    check('batch reaches Claude with both lines', pushed[0].meta.lines === '2')
  }
  check('GM queue is empty after sending', await gm.page.evaluate(() => document.querySelectorAll('#table-talk .tt-queue li:not(.tt-empty)').length) === 0)
  await sleep(800)
  check('players are told the turn was sent', /sent the table's turn/i.test((await statusOf(a.page)).text ?? ''))
  await shot(gm.page, '06-gm-sent')
  await shot(a.page, '07-player-sent')
  await gm.page.screenshot({ path: join(OUT, '08-gm-full.png') })
  writeFileSync(join(OUT, 'e2e.json'), JSON.stringify({ engineA, results, pushed }, null, 1))
} catch (err) {
  check('run', false, err.stack)
} finally {
  for (const p of [gm, a, b]) await p?.browser.close().catch(() => {})
  channel.stdin.end()
  channel.kill()
  rmSync(home, { recursive: true, force: true })
}
const failed = results.filter(r => !r.ok).length
console.log(failed ? `\n${failed} failed` : '\nall passed')
process.exit(failed ? 1 : 0)
