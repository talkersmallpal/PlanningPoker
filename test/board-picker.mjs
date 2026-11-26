// Playwright check of the board picker in "Load from Jira" (dropdown on focus, filter, keyboard, kanban message).
// Usage: npm run build && PLAYWRIGHT_PATH=<path to playwright> node test/board-picker.mjs
import { spawn } from 'child_process';
import net from 'net';
import path from 'path';
import assert from 'assert/strict';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { startMockJira } from './mock-jira.mjs';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const port = await new Promise((res) => { const s = net.createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); });
const mock = await startMockJira({ email: 'bot@example.com', token: 'tok' });
const app = spawn(process.execPath, ['build/server.js'], { cwd: ROOT, env: { PATH: process.env.PATH, PORT: String(port), HOST: '127.0.0.1', JIRA_BASE_URL: mock.url, JIRA_EMAIL: 'bot@example.com', JIRA_API_TOKEN: 'tok', JIRA_DEFAULT_BOARD_PROJECT: 'PROJ' }, stdio: 'ignore' });
const base = `http://127.0.0.1:${port}`;
for (let i = 0; i < 50; i++) { try { if ((await fetch(base + '/healthz')).ok) break; } catch {} await sleep(100); }
const browser = await chromium.launch();
const errors = [];
const options = (page) => page.$$eval('#boardMenu [role=option]', (o) => o.map((x) => x.textContent));
let ok = false;
try {
  const page = await browser.newPage({ viewport: { width: 1360, height: 1000 } });
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(base);
  await page.fill('input[name=adminName]', 'Alice');
  await page.fill('textarea[name=queueText]', 'PROJ-123');
  await page.click('button[type=submit]');
  await page.waitForSelector('#room:not(.hidden)');
  await page.click('#jqlBox summary');
  await page.waitForFunction(() => document.querySelector('#boardForm').project.value === 'PROJ - Project'); // prefilled from JIRA_DEFAULT_BOARD_PROJECT, shown as KEY - Name
  // dropdown opens on click with no typing: boards of the project, scrum first
  await page.click('#boardForm input[name=board]');
  await page.waitForSelector('#boardMenu:not(.hidden) [role=option]');
  assert.deepEqual(await options(page), ['Team board (PROJ, scrum)', 'Team board kanban (PROJ, kanban, no sprints)']);
  assert.equal(await page.getAttribute('#boardForm input[name=board]', 'aria-expanded'), 'true');
  const boardReqs = mock.requests.filter((q) => q.path === '/rest/agile/1.0/board');
  assert.ok(boardReqs.some((q) => !q.query.name && q.query.projectKeyOrId === 'PROJ'), 'list loaded with no name query');
  // keyboard: ArrowDown + Enter picks the first board and loads its sprints
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await page.waitForSelector('#sprintSelect:not(.hidden)');
  assert.equal(await page.inputValue('#boardForm input[name=board]'), 'Team board (PROJ, scrum)');
  assert.ok(await page.$eval('#boardMenu', (e) => e.classList.contains('hidden')), 'menu closes after choosing');
  assert.deepEqual(await page.$$eval('#sprintSelect option', (o) => o.map((x) => x.textContent)), ['Choose sprint…', 'Team Sprint 42 (active)', 'Team Sprint 43 (future)']);
  // choosing a sprint runs the sprint JQL
  await page.selectOption('#sprintSelect', '501');
  await page.waitForFunction(() => document.querySelector('#jqlForm').jql.value === 'sprint = 501 ORDER BY rank');
  // typing filters; Escape closes; mouse picks the kanban board -> friendly message
  await page.fill('#boardForm input[name=board]', 'kanban');
  await page.waitForFunction(() => document.querySelectorAll('#boardMenu [role=option]').length === 1);
  await page.keyboard.press('Escape');
  assert.ok(await page.$eval('#boardMenu', (e) => e.classList.contains('hidden')), 'Escape closes the menu');
  await page.keyboard.press('ArrowDown'); // reopens
  await page.waitForSelector('#boardMenu:not(.hidden) [role=option]');
  await page.click('#boardMenu [role=option]');
  await page.waitForFunction(() => /no sprints/.test(document.querySelector('#jqlMsg').textContent));
  // no "Open sprint" button any more
  assert.equal(await page.$$eval('#jqlForm button', (b) => b.map((x) => x.textContent)).then((t) => t.includes('Open sprint')), false);
  // Project field sits above the board field
  const [py, by] = await page.$$eval('#boardForm input[name=project], #boardForm input[name=board]', (els) => els.map((e) => e.getBoundingClientRect().top));
  assert.ok(py < by, 'project field above the board field');
  // project dropdown opens on click: All projects first, then every project as KEY - Name
  await page.click('#boardForm input[name=project]');
  await page.waitForSelector('#projectMenu:not(.hidden) [role=option]');
  const projOpts = await page.$$eval('#projectMenu [role=option]', (o) => o.map((x) => x.textContent));
  assert.equal(projOpts.length, 61, 'All projects + 60 projects (two pages)');
  assert.deepEqual(projOpts.slice(0, 3), ['All projects', 'FILL - Filler', 'MOB - Mobile']);
  // typing filters by key or name; Enter picks -> boards reload and a board of another project is cleared
  await page.fill('#boardForm input[name=project]', 'mobi');
  await page.waitForFunction(() => [...document.querySelectorAll('#projectMenu [role=option]')].map((o) => o.textContent).join('|') === 'All projects|MOB - Mobile');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('#boardForm').board.value === '');
  assert.equal(await page.inputValue('#boardForm input[name=project]'), 'MOB - Mobile');
  await page.click('#boardForm input[name=board]');
  await page.waitForFunction(() => [...document.querySelectorAll('#boardMenu [role=option]')].map((o) => o.textContent).join('|') === 'Mobile team (MOB, scrum)');
  // empty project = boards of all projects
  await page.keyboard.press('Escape');
  // typing a key and tabbing away works too
  await page.fill('#boardForm input[name=project]', 'ops');
  await page.press('#boardForm input[name=project]', 'Tab');
  await page.waitForFunction(() => document.querySelector('#boardForm').project.value === 'OPS - Ops');
  await page.keyboard.press('Escape');
  // "All projects" = boards of all projects
  await page.click('#boardForm input[name=project]');
  await page.waitForSelector('#projectMenu:not(.hidden) [role=option]');
  await page.fill('#boardForm input[name=project]', 'all');
  await page.click('#projectMenu [role=option]:has-text("All projects")');
  assert.equal(await page.inputValue('#boardForm input[name=project]'), '');
  await page.click('#boardForm input[name=board]');
  await page.waitForFunction(() => document.querySelectorAll('#boardMenu [role=option]').length === 64);
  assert.equal(errors.length, 0, 'page errors: ' + errors.join('; '));
  ok = true;
  console.log('board picker UI: all checks passed');
} finally {
  await browser.close(); app.kill(); mock.server.close();
  if (!ok) process.exitCode = 1;
}
