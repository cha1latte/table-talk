// GM "Speak as" picker (REQ-001..004), in the throwaway Foundry (qa/foundry.ps1).  node qa/test-speak-as.mjs
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
const SEL = '#table-talk .tt-speak-as select'
const gmQueue = gm => gm.evaluate(() => [...document.querySelectorAll('#table-talk .tt-queue li:not(.tt-empty)')].map(li => li.innerText.replace(/\s+/g, ' ').trim()))
const options = gm => gm.evaluate(sel => [...document.querySelectorAll(`${sel} option`)].map(o => o.textContent.trim()), SEL)

const browser = await chromium.launch({ channel: 'chrome', headless: true })
let gm
try {
  gm = await person(browser, 'Gamemaster')
  await gm.evaluate(async () => {
    localStorage.removeItem(`table-talk.queue.${game.world.id}`)
    for (const a of game.actors.filter(a => a.name.startsWith('TT '))) await a.delete()
    const player = game.users.find(u => !u.isGM)
    const OWNER = CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER
    await Actor.create({ name: 'TT Hero', type: 'character', ownership: { [player.id]: OWNER } })
    await Actor.create({ name: 'TT Villain', type: 'npc', ownership: { [player.id]: OWNER } })
    await Actor.create({ name: 'TT Gm Only', type: 'character' })
    await game.settings.set('table-talk', 'speakAs', '')
  })
  await gm.reload(); await ready(gm)
  const pl = await person(browser, "Kestrel's Player")

  // REQ-001
  check('REQ-001 GM sees a Speak-as dropdown', await gm.locator(SEL).isVisible())
  check('REQ-001 player has no Speak-as dropdown', (await pl.locator(SEL).count()) === 0 || !(await pl.locator(SEL).isVisible()))

  // REQ-002
  let opts = await options(gm)
  const assigned = await gm.evaluate(() => game.users.find(u => !u.isGM).character?.name)
  check('REQ-002 GM is first', opts[0] === 'GM', JSON.stringify(opts))
  check('REQ-002 lists the owned player character', opts.includes('TT Hero'), JSON.stringify(opts))
  check('REQ-002 lists the assigned character once', !assigned || opts.filter(o => o === assigned).length === 1, `${assigned} ${JSON.stringify(opts)}`)
  check('REQ-002 skips GM-only and NPC actors', !opts.includes('TT Gm Only') && !opts.includes('TT Villain'), JSON.stringify(opts))
  const rest = opts.slice(1)
  check('REQ-002 sorted by name', JSON.stringify(rest) === JSON.stringify([...rest].sort((a, b) => a.localeCompare(b))), JSON.stringify(rest))

  // REQ-003 default unchanged
  await gm.fill('#table-talk .tt-type input', 'plain gm line')
  await gm.press('#table-talk .tt-type input', 'Enter')
  await gm.waitForTimeout(800)
  let q = await gmQueue(gm)
  check('REQ-003 Speak as GM still labels "GM"', q.length === 1 && /^GM\b/.test(q[0]) && !/Gamemaster/.test(q[0]), JSON.stringify(q))

  // REQ-003 as character
  await gm.selectOption(SEL, { label: 'TT Hero' })
  await gm.waitForTimeout(500)
  await gm.fill('#table-talk .tt-type input', 'I chase the thief')
  await gm.press('#table-talk .tt-type input', 'Enter')
  await gm.waitForTimeout(800)
  q = await gmQueue(gm)
  check('REQ-003 line labelled "TT Hero (Gamemaster)" in the queue', q.length === 2 && /TT Hero \(Gamemaster\)/.test(q[1]) && /chase the thief/.test(q[1]), JSON.stringify(q))
  const stored = await gm.evaluate(() => JSON.parse(localStorage.getItem(`table-talk.queue.${game.world.id}`) || '[]').at(-1))
  check('REQ-003 line data: character = hero, player = Gamemaster', stored?.character === 'TT Hero' && stored?.player === 'Gamemaster', JSON.stringify(stored))

  // REQ-004 persists
  await gm.reload(); await ready(gm)
  check('REQ-004 pick survives a reload', (await gm.locator(`${SEL} option:checked`).innerText()).trim() === 'TT Hero')

  // REQ-004 fallback when the actor goes away
  await gm.evaluate(async () => { await game.actors.getName('TT Hero').delete() })
  await gm.waitForTimeout(800)
  opts = await options(gm)
  check('REQ-002 deleted actor leaves the list', !opts.includes('TT Hero'), JSON.stringify(opts))
  check('REQ-004 falls back to GM', (await gm.locator(`${SEL} option:checked`).innerText()).trim() === 'GM')
  await gm.fill('#table-talk .tt-type input', 'after delete')
  await gm.press('#table-talk .tt-type input', 'Enter')
  await gm.waitForTimeout(800)
  q = await gmQueue(gm)
  check('REQ-004 lines are "GM" again after the fallback', /^GM\b/.test(q.at(-1)) && /after delete/.test(q.at(-1)), JSON.stringify(q))
  await gm.screenshot({ path: 'qa/out/speak-as-gm.png', clip: await gm.locator('#table-talk').boundingBox() })
} catch (err) {
  check('run', false, err.stack)
} finally {
  if (gm) await gm.evaluate(async () => {
    for (const a of game.actors.filter(a => a.name.startsWith('TT '))) await a.delete()
    localStorage.removeItem(`table-talk.queue.${game.world.id}`)
    try { await game.settings.set('table-talk', 'speakAs', '') } catch {}
  }).catch(() => {})
  await browser.close()
}
const failed = results.filter(r => !r).length
console.log(failed ? `\n${failed} failed` : '\nall passed')
process.exit(failed ? 1 : 0)
