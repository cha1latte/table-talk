// Typed lines and taking a line back, in the throwaway Foundry (qa/foundry.ps1).  node qa/test-type.mjs
import { chromium } from 'file:///D:/dev/vnv/node_modules/playwright/index.mjs'

const BASE = `http://localhost:${process.env.QA_PORT || 30005}`
const results = []
const check = (name, ok, detail = '') => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  [${detail}]` : ''}`)
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
  await page.waitForFunction(() => window.game?.ready, null, { timeout: 120000 })
  await page.addStyleTag({ content: '.tour,.tour-overlay,.tour-fadeout,.tour-center-step{display:none!important}' })
  await page.waitForTimeout(1500)
  return page
}
const gmQueue = gm => gm.evaluate(() => [...document.querySelectorAll('#table-talk .tt-queue li:not(.tt-empty)')].map(li => li.innerText.replace(/\s+/g, ' ').trim()))

const browser = await chromium.launch({ channel: 'chrome', headless: true })
try {
  const gm = await person(browser, 'Gamemaster')
  await gm.evaluate(() => localStorage.removeItem(`table-talk.queue.${game.world.id}`))
  await gm.reload(); await gm.waitForFunction(() => window.game?.ready, null, { timeout: 120000 }); await gm.waitForTimeout(1500)
  const pl = await person(browser, "Kestrel's Player")

  check('player has a type box', await pl.locator('#table-talk .tt-type input').isVisible())
  await pl.fill('#table-talk .tt-type input', 'I search the  strongbox for snacks.')
  await pl.press('#table-talk .tt-type input', 'Enter')
  await pl.waitForTimeout(1500)
  let q = await gmQueue(gm)
  check('typed line reaches the GM queue, labelled', q.length === 1 && /Kestrel Vane/.test(q[0]) && /strongbox for snacks/.test(q[0]), JSON.stringify(q))
  check('type box clears after sending', (await pl.inputValue('#table-talk .tt-type input')) === '')
  const mine = await pl.evaluate(() => [...document.querySelectorAll('#table-talk .tt-mine li')].map(li => li.innerText.trim()))
  check('player sees their own waiting line', mine.length === 1 && /snacks/.test(mine[0]), JSON.stringify(mine))
  await pl.screenshot({ path: 'qa/out/type-player.png', clip: await pl.locator('#table-talk').boundingBox() })

  await pl.click('#table-talk .tt-mine .tt-remove')
  await pl.waitForTimeout(1500)
  q = await gmQueue(gm)
  check('player can take their line back', q.length === 0, JSON.stringify(q))
  check('their list empties', (await pl.locator('#table-talk .tt-mine li').count()) === 0)

  await gm.fill('#table-talk .tt-type input', 'GM note typed')
  await gm.press('#table-talk .tt-type input', 'Enter')
  await gm.waitForTimeout(800)
  q = await gmQueue(gm)
  check('GM can type a line too', q.length === 1 && /GM note typed/.test(q[0]), JSON.stringify(q))
  // a player can't remove someone else's line
  const gmLineId = await gm.evaluate(() => document.querySelector('#table-talk .tt-queue [data-remove]')?.dataset.remove)
  await pl.evaluate(id => game.socket.emit('module.table-talk', { type: 'remove', id, userId: game.user.id }), gmLineId)
  await pl.waitForTimeout(1200)
  check("a player can't delete someone else's line", (await gmQueue(gm)).length === 1)
  await gm.screenshot({ path: 'qa/out/type-gm.png', clip: await gm.locator('#table-talk').boundingBox() })
} catch (err) {
  check('run', false, err.stack)
} finally {
  await browser.close()
}
const failed = results.filter(r => !r).length
console.log(failed ? `\n${failed} failed` : '\nall passed')
process.exit(failed ? 1 : 0)
