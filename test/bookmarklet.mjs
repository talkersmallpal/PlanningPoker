// Playwright check of the bookmarklet on a fake Jira-like page + history table columns.
// Usage: PLAYWRIGHT_PATH=<path to playwright> node test/bookmarklet.mjs
import { spawn } from 'child_process';
import http from 'http';
import net from 'net';
import path from 'path';
import assert from 'assert/strict';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'screenshots');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); });
const port = await freePort();
const app = spawn(process.execPath, ['build/server.js'], { cwd: ROOT, env: { PATH: process.env.PATH, PORT: String(port), HOST: '127.0.0.1' }, stdio: 'ignore' });
const base = `http://127.0.0.1:${port}`;
for (let i = 0; i < 50; i++) { try { if ((await fetch(base + '/healthz')).ok) break; } catch {} await sleep(100); }

// Fake Jira-like page (no real Jira). Links use https://url1/browse/... as on real pages.
const fake = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(`<!doctype html><title>Filter results</title><h1>Filter: sprint tickets</h1><ul>
  <li><a href="https://url1/browse/PROJ-100">PROJ-100</a></li>
  <li><a href="https://url1/browse/PROJ-123?focusedCommentId=5">PROJ-123 w/ query</a></li>
  <li><a href="https://url1/browse/PROJ-100">dup of 100</a></li>
  <li><a href="https://url1/browse/PROJ-124/">PROJ-124 trailing slash</a></li>
  <li><a href="https://url1/projects/PROJ">not a ticket</a></li></ul>`);
});
await new Promise((r) => fake.listen(0, '127.0.0.1', r));
const fakeUrl = `http://127.0.0.1:${fake.address().port}/issues`;
const browser = await chromium.launch();
let ok = false;
try {
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 800 } });
  // 1. bookmarklet page auto-sets base URL to the current origin
  const bm = await ctx.newPage();
  await bm.goto(base + '/bookmarklet.html');
  const href = await bm.getAttribute('#bmLink', 'href');
  const code = await bm.inputValue('#bmCode');
  assert.equal(href, code);
  assert.ok(code.startsWith('javascript:') && code.includes(`window.open('${base}/new?tickets='`), 'base URL is the current origin');
  await bm.screenshot({ path: path.join(OUT, '08-bookmarklet-page.png'), fullPage: true });
  // 2. the exact bookmarklet from the requirements (with localhost:8080 swapped to the test origin) on the fake page
  const original = "javascript:(()=>{const s=new Set();document.querySelectorAll('a[href*=\"/browse/\"]').forEach(a=>{const m=a.href.match(/^(https:\\/\\/[^/]+\\/browse\\/[A-Z][A-Z0-9]+-\\d+)/);if(m)s.add(m[1]);});if(!s.size){alert('No Jira tickets found on this page');window.open('http://localhost:8080/','_blank');return;}window.open('http://localhost:8080/new?tickets='+encodeURIComponent([...s].join(',')),'_blank');})();";
  const forTest = original.replaceAll('http://localhost:8080', base);
  assert.equal(code, forTest.replace(/^javascript:/, 'javascript:'), 'generated button code equals the specified bookmarklet');
  const jira = await ctx.newPage();
  await jira.goto(fakeUrl);
  const [popup] = await Promise.all([ctx.waitForEvent('page'), jira.evaluate(code.slice('javascript:'.length))]);
  await popup.waitForSelector('#landing:not(.hidden)');
  await popup.waitForFunction(() => document.querySelector('textarea[name=queueText]').value.length > 0);
  const lines = (await popup.inputValue('textarea[name=queueText]')).split('\n');
  assert.deepEqual(lines, ['https://url1/browse/PROJ-100', 'https://url1/browse/PROJ-123', 'https://url1/browse/PROJ-124']);
  assert.match(await popup.textContent('#prefillNotice'), /3 tickets loaded/);
  await popup.screenshot({ path: path.join(OUT, '09-new-prefilled.png'), fullPage: true });
  // 2b. no-tickets path: alert first, then window.open to the app home page (origin)
  const empty = await ctx.newPage();
  await empty.setContent('<h1>No tickets here</h1><a href="https://url1/projects/PROJ">project</a>');
  const dialogs = [];
  empty.on('dialog', async (d) => { dialogs.push(d.message()); await d.accept(); });
  const [home] = await Promise.all([ctx.waitForEvent('page'), empty.evaluate(code.slice('javascript:'.length))]);
  await home.waitForLoadState();
  assert.deepEqual(dialogs, ['No Jira tickets found on this page']);
  assert.equal(home.url(), base + '/');
  assert.equal(await home.inputValue('input[name=name]'), 'Estimation session');
  assert.equal((await home.getAttribute('textarea[name=queueText]', 'placeholder')).split('\n').length, 2);
  await home.close();
  // 3. XSS-ish input is shown as text/ignored
  const xss = await ctx.newPage();
  let dialog = false; xss.on('dialog', (d) => { dialog = true; d.dismiss(); });
  await xss.goto(base + '/new?tickets=' + encodeURIComponent('<img src=x onerror=alert(1)>,javascript:alert(1),PROJ-9'));
  await xss.waitForFunction(() => document.querySelector('textarea[name=queueText]').value.length > 0);
  assert.equal(await xss.inputValue('textarea[name=queueText]'), 'PROJ-9');
  assert.match(await xss.textContent('#prefillNotice'), /Ignored 2 invalid/);
  assert.equal(await xss.locator('#prefillNotice img').count(), 0);
  assert.equal(dialog, false);
  // 4. start a session from the prefilled form; history table has no Avg/Median/Time columns
  await popup.fill('input[name=adminName]', 'Alice');
  await popup.uncheck('input[name=adminVotes]');
  await popup.click('button[type=submit]');
  await popup.waitForSelector('#room:not(.hidden)');
  const heads = await popup.$$eval('table.history thead th', (els) => els.map((e) => e.textContent.trim()));
  assert.deepEqual(heads, ['Issue', 'Agreed SP', 'Hours', 'Rate', 'Status']);
  const queueLinks = await popup.$$eval('#queue a', (els) => els.map((a) => [a.textContent, a.getAttribute('target'), a.getAttribute('rel')]));
  assert.equal(queueLinks.length, 3);
  assert.deepEqual(queueLinks[1], ['https://url1/browse/PROJ-123', '_blank', 'noopener']);
  // 5. no Jira configured: UPDATE Jiras disabled with the hint (admin view of the session just started)
  assert.equal(await popup.isDisabled('#jiraUpdateBtn'), true);
  assert.equal(await popup.textContent('#jiraHint'), 'Jira not configured: set JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN');
  assert.equal(await popup.isDisabled('#jiraMode'), true);
  await popup.locator('#jiraUpdateBox').scrollIntoViewIfNeeded();
  await popup.screenshot({ path: path.join(OUT, '14-update-jiras-disabled-unconfigured.png') });
  ok = true;
  console.log('bookmarklet checks passed (button code, fake Jira page, prefill, XSS, session start, history columns)');
} finally {
  await browser.close(); app.kill('SIGTERM'); fake.close();
}
process.exit(ok ? 0 : 1);
