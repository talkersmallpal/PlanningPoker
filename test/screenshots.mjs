// Headless UI walkthrough + screenshots. Usage: NODE_PATH=<dir with playwright> node test/screenshots.mjs
import { spawn } from 'child_process';
import path from 'path';
import assert from 'assert/strict';
import net from 'net';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { startMockJira } from './mock-jira.mjs';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'screenshots');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const port = await new Promise((res) => { const s = net.createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); });
const mock = await startMockJira({ email: 'bot@example.com', token: 'tok' });
const app = spawn(process.execPath, ['build/server.js'], { cwd: ROOT, env: { PATH: process.env.PATH, PORT: String(port), HOST: '127.0.0.1', JIRA_BASE_URL: mock.url, JIRA_EMAIL: 'bot@example.com', JIRA_API_TOKEN: 'tok' }, stdio: 'inherit' });
await sleep(800);
const base = `http://127.0.0.1:${port}`;
const browser = await chromium.launch();
const errors = [];
const watch = (page, label) => { page.on('pageerror', (e) => errors.push(`${label}: ${e.message}`)); page.on('console', (m) => m.type() === 'error' && errors.push(`${label}: ${m.text()}`)); };
try {
  const adminCtx = await browser.newContext({ viewport: { width: 1360, height: 1000 } });
  const admin = await adminCtx.newPage(); watch(admin, 'admin');
  await admin.goto(base);
  await admin.fill('input[name=name]', 'Team – new service refinement');
  await admin.fill('input[name=adminName]', 'Alice');
  await admin.uncheck('input[name=adminVotes]');
  await admin.fill('textarea[name=queueText]', 'https://url1/browse/PROJ-123\nhttps://url1/browse/PROJ-124/?foo=1\nhttps://url1/browse/PROJ-125');
  await admin.screenshot({ path: path.join(OUT, '01-start-session.png'), fullPage: true });
  await admin.click('button[type=submit]');
  await admin.waitForSelector('#room:not(.hidden)');
  const link = admin.url();

  const names = ['Bob', 'Carol', 'Dave'];
  const members = [];
  for (const n of names) {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    const p = await ctx.newPage(); watch(p, n);
    await p.goto(link);
    await p.waitForSelector('#register:not(.hidden)');
    if (n === 'Bob') await p.screenshot({ path: path.join(OUT, '02-member-register-mobile.png') });
    await p.fill('#registerForm input[name=name]', n);
    await p.click('#registerForm button[type=submit]');
    await p.waitForSelector('#room:not(.hidden)');
    members.push(p);
  }
  await admin.click('#startBtn');
  await members[0].waitForSelector('#voteArea:not(.hidden)');
  const linkCheck = await admin.evaluate(() => {
    const a = document.querySelector('#storyTitle a.ticket-url, #storyTitle a, #queue a.ticket-url, #queue a');
    return a ? { href: a.getAttribute('href'), text: a.textContent, target: a.getAttribute('target'), rel: a.getAttribute('rel') } : null;
  });
  console.log('Ticket link:', JSON.stringify(linkCheck));
  const vote = async (p, v) => p.locator('#deck .pcard', { hasText: new RegExp(`^${v.replace('.', '\\.')}$`) }).click();
  await vote(members[0], '5');
  await vote(members[1], '8');
  await sleep(300);
  await members[0].screenshot({ path: path.join(OUT, '03-member-voting-mobile.png'), fullPage: true });
  await admin.screenshot({ path: path.join(OUT, '04-admin-voting.png'), fullPage: true });
  await vote(members[2], '3');
  await admin.waitForSelector('#results:not(.hidden)');
  await sleep(3000);
  // Type a new agreed SP: hours must update live on input (5 → 20h becomes 8 → 32h)
  await admin.fill('#finalInput', '8');
  await admin.waitForFunction(() => document.querySelector('#agreedHoursPreview').textContent.includes('32h'));
  await sleep(700);
  const stats = await admin.evaluate(() => ({ avg: document.querySelector('#stAvg').textContent, avgH: document.querySelector('#stAvgH').textContent, med: document.querySelector('#stMed').textContent, medH: document.querySelector('#stMedH').textContent, agreed: document.querySelector('#stFinal').textContent, agreedH: document.querySelector('#stFinalH').textContent, preview: document.querySelector('#agreedHoursPreview').textContent, cards: [...document.querySelectorAll('#revealCards .rcard')].map((e) => e.textContent), ticketHref: document.querySelector('#storyTitle a')?.getAttribute('href'), ticketText: document.querySelector('#storyTitle a')?.textContent, ticketTarget: document.querySelector('#storyTitle a')?.getAttribute('target') }));
  console.log('UI stats after reveal:', JSON.stringify(stats));
  await admin.screenshot({ path: path.join(OUT, '05-admin-revealed.png'), fullPage: true });
  await members[1].waitForSelector('#results:not(.hidden)');
  await sleep(400);
  await members[1].screenshot({ path: path.join(OUT, '06-member-revealed-mobile.png'), fullPage: true });
  // finish story -> queue advances (no automatic Jira write: statuses start as "Not sent")
  await admin.click('#nextBtn');
  await admin.waitForFunction(() => document.querySelectorAll('#historyBody tr').length === 1);
  for (const sp of ['5', '5']) {
    await members[0].waitForSelector('#voteArea:not(.hidden)');
    await sleep(300);
    for (const m of members) await vote(m, sp);
    await admin.waitForSelector('#results:not(.hidden)');
    await sleep(3000);
    const n = (await admin.$$('#historyBody tr')).length;
    await admin.click('#nextBtn');
    await admin.waitForFunction((k) => document.querySelectorAll('#historyBody tr').length === k + 1, n);
  }
  await sleep(300);
  await admin.screenshot({ path: path.join(OUT, '07-admin-next-story-queue.png'), fullPage: true });

  // ---- UPDATE Jiras ----
  const box = admin.locator('#jiraUpdateBox');
  await box.scrollIntoViewIfNeeded();
  assert(await admin.isVisible('#jiraUpdateBtn') && await admin.isEnabled('#jiraUpdateBtn'), 'admin sees an enabled UPDATE Jiras button');
  assert.deepEqual(await admin.$$eval('#jiraMode option', (o) => o.map((x) => x.textContent)), ['Story points', 'Time (Original estimate)', 'Both']);
  assert.deepEqual(await admin.$$eval('table.history thead th', (o) => o.map((x) => x.textContent.trim())), ['Issue', 'Agreed SP', 'Hours', 'Rate', 'Status']);
  assert.deepEqual(await admin.$$eval('#historyBody td.st-cell', (o) => o.map((x) => x.textContent.trim())), ['Not sent', 'Not sent', 'Not sent']);
  await admin.waitForFunction(() => document.querySelector('#jiraFieldInfo').textContent.includes('customfield_10016'));
  await box.screenshot({ path: path.join(OUT, '10-update-jiras-controls.png') });
  await admin.screenshot({ path: path.join(OUT, '10b-history-status-column.png'), fullPage: true });
  mock.controls.fail.set('PROJ-124', { status: 403, body: { errorMessages: ['You do not have permission to edit this issue.'] } });
  await admin.selectOption('#jiraMode', 'both');
  await admin.click('#jiraUpdateBtn');
  await admin.waitForSelector('#confirmModal:not(.hidden)');
  assert.equal(await admin.textContent('#confirmTitle'), 'Update 3 tickets: story points + time');
  assert.equal((await admin.$$('#confirmList li')).length, 3);
  await admin.screenshot({ path: path.join(OUT, '11-update-confirm-dialog.png') });
  await admin.click('#confirmOk');
  await admin.waitForFunction(() => [...document.querySelectorAll('#historyBody .st')].every((e) => !e.textContent.includes('Not sent')) && document.querySelector('#jiraUpdateBtn').textContent === 'UPDATE Jiras');
  const sts = await admin.$$eval('#historyBody td.st-cell', (o) => o.map((x) => [x.dataset.state, x.getAttribute('title'), x.textContent.trim()]));
  console.log('Statuses after update:', JSON.stringify(sts.map((x) => [x[0], x[1].slice(0, 70)])));
  assert.deepEqual(sts.map((x) => x[0]).sort(), ['failed', 'updated', 'updated']);
  const failedCell = sts.find((x) => x[0] === 'failed');
  assert.match(failedCell[1], /403.*permission/i, 'failed status tooltip carries Jira error');
  assert(await admin.isVisible('#jiraRetryBtn'), 'Retry failed visible when something failed');
  await admin.hover('#historyBody .st-failed');
  await admin.locator('#jiraUpdateBox').scrollIntoViewIfNeeded();
  await admin.screenshot({ path: path.join(OUT, '12-statuses-after-update.png'), fullPage: true });
  // voters: Status column read-only, no controls, live statuses
  await members[0].waitForFunction(() => document.querySelectorAll('#historyBody .st-updated').length === 2);
  assert(!(await members[0].isVisible('#jiraUpdateBox')), 'voters do not see UPDATE Jiras controls');
  assert.equal(await members[0].$$eval('#historyBody .st-failed', (o) => o[0].closest('td').getAttribute('title').includes('403')), true);
  await members[0].locator('#historyBody').scrollIntoViewIfNeeded();
  await members[0].screenshot({ path: path.join(OUT, '13-member-status-readonly-mobile.png'), fullPage: true });
  // retry failed
  mock.controls.fail.clear();
  await admin.click('#jiraRetryBtn');
  await admin.waitForFunction(() => document.querySelectorAll('#historyBody .st-updated').length === 3);
  assert(!(await admin.isVisible('#jiraRetryBtn')), 'Retry failed hidden again');
  console.log('Jira PUTs:', JSON.stringify(mock.requests.filter((r) => r.method === 'PUT').map((r) => [r.path, r.body])));
} finally {
  console.log(errors.length ? 'BROWSER ERRORS:\n' + errors.join('\n') : 'No browser console errors');
  await browser.close();
  app.kill('SIGTERM');
  mock.server.close();
}
