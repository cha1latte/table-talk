// Players' Foundry chat and rolls joining the GM's queue, in the throwaway Foundry (qa/foundry.ps1).
// Runs the real channel server on a spare port to see what Claude would receive.  node qa/test-chat.mjs
import { chromium } from 'file:///D:/dev/vnv/node_modules/playwright/index.mjs'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const BASE = `http://localhost:${process.env.QA_PORT || 30005}`
const CHANNEL_PORT = 18797
const results = []
const check = (name, ok, detail = '') => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  [${detail}]` : ''}`)
}
const sleep = ms => new Promise(r => setTimeout(r, ms))

// The channel server, as Claude Code would run it.
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const home = mkdtempSync(join(tmpdir(), 'table-talk-home-'))
const channel = spawn(process.execPath, [join(root, 'claude-plugin', 'server.mjs')], {
  env: { ...process.env, USERPROFILE: home, HOME: home, TABLE_TALK_PORT: String(CHANNEL_PORT), TABLE_TALK_LISTEN: '1' },
  stdio: ['pipe', 'pipe', 'inherit'],
})
const delivered = []
let buf = ''
channel.stdout.setEncoding('utf8')
channel.stdout.on('data', d => {
  buf += d
  let nl
  while ((nl = buf.indexOf('\n')) >= 0) {
    const msg = JSON.parse(buf.slice(0, nl))
    buf = buf.slice(nl + 1)
    if (msg.method === 'notifications/claude/channel') delivered.push(msg.params.content)
  }
})
channel.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'qa', version: '0' } } }) + '\n')

async function person(browser, user) {
  const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage()
  page.on('pageerror', e => /register as spell list/.test(e.message) || console.log(`[${user} pageerror]`, e.message.slice(0, 200)))
  await page.goto(`${BASE}/join`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('select[name=userid], input[name=username]')
  if (await page.locator('select[name=userid]').count()) await page.selectOption('select[name=userid]', { label: user })
  else await page.fill('input[name=username]', user)
  await page.click('button[name=join]')
  await page.waitForURL('**/game', { timeout: 60000 })
  await page.waitForFunction(() => window.game?.ready, null, { timeout: 120000 })
  await page.addStyleTag({ content: '.tour,.tour-overlay,.tour-fadeout,.tour-center-step{display:none!important}' })
  await page.waitForTimeout(1500)
  return page
}
const gmQueue = gm => gm.evaluate(() => [...document.querySelectorAll('#table-talk .tt-queue li:not(.tt-empty)')].map(li => ({
  text: li.innerText.replace(/\s+/g, ' ').trim(),
  icon: li.querySelector('.tt-via')?.className.match(/fa-(comment|dice-d20|keyboard)/)?.[1] ?? null,
})))
// The real chat command path, exactly as if the player typed it into Foundry's chat box.
const say = (page, text) => page.evaluate(t => ui.chat.processMessage(t), text)

const browser = await chromium.launch({ channel: 'chrome', headless: true })
try {
  const gm = await person(browser, 'Gamemaster')
  await gm.evaluate(async port => {
    localStorage.removeItem(`table-talk.queue.${game.world.id}`)
    await game.settings.set('table-talk', 'chat', 'queue')
    await game.settings.set('table-talk', 'channelUrl', `http://127.0.0.1:${port}`)
    await game.messages.documentClass.deleteDocuments([], { deleteAll: true })
  }, CHANNEL_PORT)
  await gm.reload(); await gm.waitForFunction(() => window.game?.ready, null, { timeout: 120000 }); await gm.waitForTimeout(1500)
  const pl = await person(browser, "Kestrel's Player")
  const other = await person(browser, 'Second Player')

  await say(pl, 'Can I see the far wall from here?')
  await say(pl, '/ooc brb, getting snacks')
  await say(pl, '/ic Nobody move.')
  await say(pl, '/em raises the lantern.')
  await say(pl, '/w Gamemaster I quietly pocket the silver key.')
  await say(pl, '/w [Second Player] psst, follow my lead')
  await say(pl, '/r 1d20 + 5 # Perception')
  await say(pl, '/br 1d20')
  await say(pl, '/sr 1d20')
  await say(gm, 'The GM narrates something.')
  await pl.evaluate(() => ChatMessage.create({ content: 'Familiar reaction answer', flags: { familiar: { reaction: 'yes' } } }))
  await pl.evaluate(() => ChatMessage.create({ content: '<div class="card">Kestrel uses Longsword</div>', flags: { [game.system.id]: { activity: { type: 'attack' } } } }))
  await say(other, 'I follow Kestrel.')
  await gm.waitForTimeout(1500)

  const q = await gmQueue(gm)
  const texts = q.map(l => l.text)
  console.log(JSON.stringify(q, null, 1))
  check('plain chat joins the queue under the character', texts.some(t => /^Kestrel Vane \(Kestrel's Player\) Can I see the far wall from here\?/.test(t)))
  check('/ooc chat joins', texts.some(t => /brb, getting snacks/.test(t)))
  check('a whisper to the GM joins', texts.some(t => /pocket the silver key/.test(t)))
  check('a whisper between players does not', !texts.some(t => /follow my lead/.test(t)))
  check('a roll joins with its formula and result', texts.some(t => /Perception: 1d20 \+ 5 = \d+/.test(t)), texts.find(t => /1d20/.test(t)))
  check('a blind roll joins (the GM sees it)', texts.filter(t => /1d20 = \d+$/.test(t)).length === 1, String(texts.filter(t => /1d20 = \d+$/.test(t)).length))
  check("the GM's own messages do not", !texts.some(t => /GM narrates/.test(t)))
  check("Familiar's flagged messages do not", !texts.some(t => /reaction answer/.test(t)))
  check('system cards without a roll do not', !texts.some(t => /uses Longsword/.test(t)))
  check('another player joins under their own name', texts.some(t => /I follow Kestrel/.test(t)))
  check('exactly the expected 8 lines', q.length === 8, String(q.length))
  check('chat lines show a chat icon, rolls a die', q.filter(l => l.icon === 'comment').length === 6 && q.filter(l => l.icon === 'dice-d20').length === 2, JSON.stringify(q.map(l => l.icon)))
  const mine = await pl.evaluate(() => [...document.querySelectorAll('#table-talk .tt-mine li')].map(li => li.innerText.trim()))
  check('the player sees their chat lines waiting (and can take them back)', mine.length === 7, JSON.stringify(mine))
  await gm.screenshot({ path: 'qa/out/chat-gm-queue.png', clip: await gm.locator('#table-talk').boundingBox() })

  // Send: Claude gets every line, tagged by how it came in.
  await gm.click('#table-talk .tt-send')
  for (let i = 0; i < 50 && !delivered.length; i++) await sleep(100)
  const batch = delivered[0] ?? ''
  console.log(batch)
  check('Send delivers a tagged batch to Claude', /^From the table \(8 lines\):/.test(batch), batch.split('\n')[0])
  check('tags: chat, in character, emote, whisper, roll', /\[chat\]: "Can I see/.test(batch) && /\[chat\]: "brb/.test(batch)
    && /\[chat, in character\]: "Nobody move\."/.test(batch) && /\[emote\]: "Kestrel Vane raises the lantern\."/.test(batch)
    && /\[chat, whispered to the GM\]: "I quietly pocket/.test(batch) && /\[roll\]: "Perception: 1d20 \+ 5 = \d+"/.test(batch), batch)
  await gm.waitForTimeout(800)
  check('queue empties after Send', (await gmQueue(gm)).length === 0)

  // "Send straight away": chat goes by itself; spoken and typed lines keep waiting for the GM.
  await gm.evaluate(() => game.settings.set('table-talk', 'chat', 'send'))
  await pl.fill('#table-talk .tt-type input', 'Typed line that should wait.')
  await pl.press('#table-talk .tt-type input', 'Enter')
  await pl.waitForTimeout(800)
  await say(pl, 'I try the door handle.')
  await say(pl, '/r 1d20 # Dexterity')
  for (let i = 0; i < 60 && delivered.length < 2; i++) await sleep(100)
  const auto = delivered[1] ?? ''
  console.log(auto)
  check('chat sends by itself, message and roll together', /^From the table \(2 lines\):/.test(auto) && /door handle/.test(auto) && /\[roll\]: "Dexterity/.test(auto), auto)
  check('typed panel lines are not auto-sent', !/should wait/.test(auto))
  await gm.waitForTimeout(800)
  const left = (await gmQueue(gm)).map(l => l.text)
  check('the typed line still waits for the GM, marked typed', left.length === 1 && /should wait/.test(left[0]), JSON.stringify(left))
  const plStatus = await pl.locator('#table-talk .tt-status').innerText()
  check('player status counts their waiting line', /1 waiting/.test(plStatus), plStatus)

  // Familiar's Table Chat answers chat itself: Table Talk stays out of the way and says why.
  // Familiar isn't installed in the throwaway world; stand in for its setting on the GM's client.
  await gm.evaluate(() => game.settings.register('familiar', 'tableChatEnabled', { scope: 'world', config: false, type: Boolean, default: true }))
  await gm.evaluate(() => game.settings.set('table-talk', 'chat', 'queue'))
  await say(pl, 'Hey @Familiar what do I see?')
  await gm.waitForTimeout(1500)
  check('nothing forwarded while Familiar Table Chat is on', !(await gmQueue(gm)).some(l => /what do I see/.test(l.text)))
  check('GM panel explains why', await gm.locator('#table-talk .tt-chat-note').isVisible())
  await gm.screenshot({ path: 'qa/out/chat-gm-familiar.png', clip: await gm.locator('#table-talk').boundingBox() })

  // Off means off.
  await gm.reload(); await gm.waitForFunction(() => window.game?.ready, null, { timeout: 120000 }); await gm.waitForTimeout(1500)
  await gm.evaluate(() => game.settings.set('table-talk', 'chat', 'off'))
  await say(pl, 'This should be ignored.')
  await gm.waitForTimeout(1500)
  check('"Don\'t add it" forwards nothing', !(await gmQueue(gm)).some(l => /ignored/.test(l.text)))
  await gm.evaluate(() => game.settings.set('table-talk', 'chat', 'queue'))
} catch (err) {
  check('run', false, err.stack)
} finally {
  await browser.close()
  channel.stdin.end()
  await sleep(200)
  channel.kill()
  rmSync(home, { recursive: true, force: true })
}
const failed = results.filter(r => !r).length
console.log(failed ? `\n${failed} failed` : '\nall passed')
process.exit(failed ? 1 : 0)
