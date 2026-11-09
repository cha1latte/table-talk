// "Players can send" (REQ-101..103), in the throwaway Foundry (qa/foundry.ps1).  node qa/test-players-send.mjs
import http from 'node:http'
import { chromium } from 'file:///D:/dev/vnv/node_modules/playwright/index.mjs'

const BASE = `http://localhost:${process.env.QA_PORT || 30005}`
const results = []
const check = (name, ok, detail = '') => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  [${detail}]` : ''}`)
}
const ready = async page => {
  await page.waitForFunction(() => window.game?.ready, null, { timeout: 120000 })
  await page.addStyleTag({ content: '.tour,.tour-overlay,.tour-fadeout,.tour-center-step{display:none!important}' })
  await page.waitForTimeout(1500)
}
async function person(browser, user) {
  const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage()
  page.on('pageerror', e => console.log(`[${user} pageerror]`, e.message.slice(0, 200)))
  await page.goto(`${BASE}/join`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('select[name=userid], input[name=username]')
  if (await page.locator('select[name=userid]').count()) await page.selectOption('select[name=userid]', { label: user })
  else await page.fill('input[name=username]', user)
  await page.click('button[name=join]')
  await page.waitForURL('**/game', { timeout: 60000 })
  await ready(page)
  return page
}

// A stand-in for the Claude Code channel: records every batch.
const batches = []
const fake = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'content-type')
  if (req.method === 'OPTIONS') return res.end()
  let body = ''
  req.on('data', c => { body += c })
  req.on('end', () => {
    if (req.url === '/batch') batches.push(JSON.parse(body))
    res.setHeader('content-type', 'application/json')
    res.end('{"ok":true}')
  })
})
await new Promise(r => fake.listen(39123, '127.0.0.1', r))
const FAKE = 'http://127.0.0.1:39123'

const BTN = '#table-talk .tt-player-send'
const status = p => p.locator('#table-talk .tt-status').innerText()
const gmQueueLen = gm => gm.evaluate(() => document.querySelectorAll('#table-talk .tt-queue li:not(.tt-empty)').length)
const say = async (p, text) => {
  await p.fill('#table-talk .tt-type input', text)
  await p.press('#table-talk .tt-type input', 'Enter')
  await p.waitForTimeout(800)
}

const browser = await chromium.launch({ channel: 'chrome', headless: true })
let gm, oldUrl
try {
  gm = await person(browser, 'Gamemaster')
  oldUrl = await gm.evaluate(async url => {
    localStorage.removeItem(`table-talk.queue.${game.world.id}`)
    const old = game.settings.get('table-talk', 'channelUrl')
    await game.settings.set('table-talk', 'channelUrl', url)
    await game.settings.set('table-talk', 'playersSend', false)
    return old
  }, FAKE)
  await gm.reload(); await ready(gm)
  const pl = await person(browser, "Kestrel's Player")

  // REQ-101 off by default / off = no button, nothing sends
  check('REQ-101 setting is off by default', await gm.evaluate(() => game.settings.settings.get('table-talk.playersSend').default === false))
  check('REQ-101 off: player has no Send button', !(await pl.locator(BTN).isVisible()))
  await say(pl, 'line while off')
  await pl.locator('body').click({ position: { x: 700, y: 400 } })
  await pl.keyboard.press('Shift+G')
  await pl.evaluate(() => game.socket.emit('module.table-talk', { type: 'send' }))
  await pl.waitForTimeout(1200)
  check('REQ-103 off: Shift+G and a forged send do nothing', batches.length === 0 && (await gmQueueLen(gm)) === 1, `batches=${batches.length}`)
  check('REQ-103 off: the forged send is refused with a reason', /Players can send/.test(await status(pl)), await status(pl))
  check('REQ-101 a player cannot change the setting', await pl.evaluate(async () => {
    try { await game.settings.set('table-talk', 'playersSend', true); return false } catch { return true }
  }) && !(await gm.evaluate(() => game.settings.get('table-talk', 'playersSend'))))

  // REQ-101 on
  await gm.evaluate(() => game.settings.set('table-talk', 'playersSend', true))
  await pl.waitForTimeout(1000)
  check('REQ-101 on: player sees a Send button', await pl.locator(BTN).isVisible())
  check('REQ-101 GM sees no player Send button', !(await gm.locator(BTN).isVisible()))
  check('REQ-102 button is live while lines wait', await pl.locator(BTN).isEnabled())

  // REQ-102 click sends the whole queue, GM's included
  await gm.fill('#table-talk .tt-type input', 'gm aside'); await gm.press('#table-talk .tt-type input', 'Enter')
  await say(pl, 'I sneak along the wall')
  await pl.click(BTN)
  await pl.waitForTimeout(1500)
  const texts = batches.at(-1)?.lines?.map(l => l.text) ?? []
  check('REQ-102 one batch with every waiting line', batches.length === 1 && ['line while off', 'gm aside', 'I sneak along the wall'].every(t => texts.includes(t)), JSON.stringify(texts))
  check('REQ-102 queue is empty afterwards', (await gmQueueLen(gm)) === 0)
  check('REQ-102 player is told it went', /sent the table's turn/.test(await status(pl)), await status(pl))
  check('REQ-102 button greys out when nothing waits', !(await pl.locator(BTN).isEnabled()))

  // REQ-102 Shift+G works for the player
  await say(pl, 'second turn')
  await pl.locator('body').click({ position: { x: 700, y: 400 } })
  await pl.keyboard.press('Shift+G')
  await pl.waitForTimeout(1500)
  check('REQ-102 Shift+G sends for the player', batches.length === 2 && batches[1].lines.some(l => l.text === 'second turn'), `batches=${batches.length}`)

  // REQ-103 failure reaches the player
  await gm.evaluate(() => game.settings.set('table-talk', 'channelUrl', 'http://127.0.0.1:39124'))
  await say(pl, 'into the void')
  await pl.click(BTN)
  await pl.waitForTimeout(2500)
  check('REQ-103 player sees why it failed', /Claude Code|Couldn't send|isn't|not/i.test(await status(pl)) && !/sent the table's turn/.test(await status(pl)), await status(pl))
  check('REQ-103 failed line stays queued', (await gmQueueLen(gm)) === 1)
  await pl.screenshot({ path: 'qa/out/players-send.png', clip: await pl.locator('#table-talk').boundingBox() })
} catch (err) {
  check('run', false, err.stack)
} finally {
  if (gm) await gm.evaluate(async old => {
    localStorage.removeItem(`table-talk.queue.${game.world.id}`)
    await game.settings.set('table-talk', 'playersSend', false)
    await game.settings.set('table-talk', 'channelUrl', old ?? '')
  }, oldUrl).catch(() => {})
  await browser.close()
  fake.close()
}
const failed = results.filter(r => !r).length
console.log(failed ? `\n${failed} failed` : '\nall passed')
process.exit(failed ? 1 : 0)
