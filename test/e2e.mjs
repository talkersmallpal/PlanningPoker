// End-to-end test: real server process + WebSocket clients + Jira mock.
import assert from 'assert/strict';
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import net from 'net';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import WebSocket from 'ws';
import { startMockJira, SP_FIELD } from './mock-jira.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EMAIL = 'poker-bot@example.com';
const TOKEN = 'mock-api-token-' + Math.random().toString(36).slice(2);
const ADMIN_PASSWORD = 'test-admin-pass';
const PKG_VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function check(name, fn) {
  return Promise.resolve().then(fn).then(
    () => { results.push(['PASS', name]); console.log('  ✓', name); },
    (e) => { results.push(['FAIL', name]); console.log('  ✗', name, '\n    ', e.message); throw e; },
  );
}
const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); });

async function startApp(env) {
  const port = await freePort();
  const proc = spawn(process.execPath, ['build/server.js'], { cwd: ROOT, env: { PATH: process.env.PATH, PORT: String(port), HOST: '127.0.0.1', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  proc.stdout.on('data', (d) => (log += d));
  proc.stderr.on('data', (d) => (log += d));
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) break; } catch {}
    await sleep(100);
  }
  return { proc, base: `http://127.0.0.1:${port}`, wsBase: `ws://127.0.0.1:${port}`, log: () => log };
}
const stopApp = (app) => new Promise((r) => { app.proc.once('exit', r); app.proc.kill('SIGTERM'); });

async function http(base, p, { method = 'GET', body, admin } = {}) {
  const res = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...(admin ? { 'X-Admin-Token': admin } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json().catch(() => null) };
}

const ALL = []; // every WS message received by any client: { client, raw, msg }
class Client {
  constructor(app, sid, label) { this.app = app; this.sid = sid; this.label = label; this.msgs = []; this.waiters = []; }
  open() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(`${this.app.wsBase}/ws?session=${this.sid}`);
      this.ws.on('open', resolve);
      this.ws.on('error', reject);
      this.ws.on('message', (raw) => {
        const msg = JSON.parse(String(raw));
        const rec = { client: this.label, raw: String(raw), msg };
        ALL.push(rec);
        this.msgs.push(msg);
        if (msg.type === 'state') this.state = msg;
        if (msg.type === 'welcome') this.you = msg.you;
        this.waiters = this.waiters.filter((w) => (w.pred(msg) ? (w.resolve(msg), false) : true));
      });
    });
  }
  send(m) { this.ws.send(JSON.stringify(m)); }
  waitFor(pred, ms = 3000, what = 'message') {
    const hit = [...this.msgs].reverse().find(pred);
    if (hit && !this._fresh) return Promise.resolve(hit);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`${this.label}: timeout waiting for ${what}`)), ms);
      this.waiters.push({ pred, resolve: (m) => { clearTimeout(t); resolve(m); } });
    });
  }
  /** wait for a NEW state message satisfying pred */
  next(pred = () => true, ms = 3000, what) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`${this.label}: timeout waiting for ${what || 'state'}`)), ms);
      this.waiters.push({ pred: (m) => m.type === 'state' && pred(m), resolve: (m) => { clearTimeout(t); resolve(m); } });
    });
  }
  close() { return new Promise((r) => { this.ws.once('close', r); this.ws.close(); }); }
}

// ---------- vote-hiding (before reveal) vs named attribution (after reveal) ----------
const IDENTITY_KEYS = new Set(['id', 'memberId', 'name', 'token', 'participant', 'member']);
const VOTE_KEYS = new Set(['vote', 'votes', 'value', 'values', 'card', 'myVote']);
function walk(o, fn, p = '$') {
  if (Array.isArray(o)) o.forEach((x, i) => walk(x, fn, `${p}[${i}]`));
  else if (o && typeof o === 'object') { fn(o, p); for (const [k, v] of Object.entries(o)) walk(v, fn, `${p}.${k}`); }
}
function assertNoPairing(msg) {
  walk(msg, (obj, p) => {
    const keys = Object.keys(obj);
    const idk = keys.filter((k) => IDENTITY_KEYS.has(k));
    const vk = keys.filter((k) => VOTE_KEYS.has(k));
    if (idk.length && vk.length) throw new Error(`object at ${p} pairs identity ${idk} with vote ${vk}`);
  });
}
function assertHiddenBeforeReveal(msg) {
  if (msg.type !== 'state' || msg.round.status === 'revealed') return;
  assertNoPairing(msg);
  assert.equal(msg.round.results, null, 'results must be null before reveal');
  assert.deepEqual(Object.keys(msg.round).sort(), ['autoRevealed', 'eligibleCount', 'finalHours', 'finalSP', 'id', 'queueItemId', 'results', 'savedToJira', 'status', 'story', 'votedCount']);
  for (const pp of msg.participants) {
    assert.ok(!('vote' in pp), 'participant.vote must be absent before reveal');
    assert.deepEqual(Object.keys(pp).sort(), ['counted', 'id', 'isAdmin', 'name', 'online', 'voted', 'voter']);
  }
  assert.ok(!('vote' in msg.you), 'you.vote must be absent before reveal');
  assert.deepEqual(Object.keys(msg.you).sort(), ['id', 'isAdmin', 'name', 'voted', 'voter']);
  assert.equal(typeof msg.you.voted, 'boolean');
  const { session, queue, history, totals, ...rest } = msg;
  const s = JSON.stringify({ ...rest, round: { ...rest.round, story: null } });
  assert.ok(!/"(vote|votes|value|values|card)"/.test(s), 'pre-reveal message contains vote-ish key');
}
function assertNamedAfterReveal(msg) {
  if (msg.type !== 'state' || msg.round.status !== 'revealed') return;
  for (const pp of msg.participants) {
    assert.ok('vote' in pp, 'after reveal each participant must have a vote field');
    if (pp.voted) {
      assert.equal(typeof pp.vote, 'string');
      assert.ok(msg.session.deck.includes(pp.vote), `unexpected card ${pp.vote}`);
    } else {
      assert.equal(pp.vote, null);
    }
    assert.deepEqual(Object.keys(pp).sort(), ['counted', 'id', 'isAdmin', 'name', 'online', 'vote', 'voted', 'voter']);
  }
  assert.ok('vote' in msg.you);
  assert.deepEqual(Object.keys(msg.you).sort(), ['id', 'isAdmin', 'name', 'vote', 'voted', 'voter']);
}
function votesByName(msg) {
  return Object.fromEntries(msg.participants.map((p) => [p.name, p.vote]));
}

// =======================================================================
const mock = await startMockJira({ email: EMAIL, token: TOKEN });
const dataFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pp-')), 'sessions.json');
const env = {
  JIRA_BASE_URL: mock.url, JIRA_EMAIL: EMAIL, JIRA_API_TOKEN: TOKEN, JIRA_WRITE_BACK: 'true',
  ADMIN_PASSWORD, OFFLINE_GRACE_SECONDS: '1', DATA_FILE: dataFile,
};
let app = await startApp(env);
const clients = [];
let failed = false;
try {
  console.log('Jira-enabled server', app.base);
  let sid, adminToken;
  await check('config endpoint reports Jira + write-back + password, no secrets', async () => {
    const r = await http(app.base, '/api/config');
    assert.deepEqual(r.data, { version: PKG_VERSION, defaultSessionName: 'Estimation session', adminPasswordRequired: true, defaultRate: 4, hoursRoundingStep: 0.5, jiraEnabled: true, jiraWriteBack: true, jiraUpdateDefaultMode: 'both', jiraRecalcRemaining: true, jiraDefaultBoard: '', jiraDefaultBoardProject: '' });
  });
  await check('session creation rejects wrong admin password', async () => {
    const r = await http(app.base, '/api/sessions', { method: 'POST', body: { name: 'x', password: 'nope' } });
    assert.equal(r.status, 401);
  });
  const U123 = 'https://url1/browse/PROJ-123';
  const U124 = 'https://url1/browse/PROJ-124/?foo=1';
  const U125 = 'https://url1/browse/PROJ-125?focusedCommentId=9';
  const U9999 = 'https://url1/browse/PROJ-9999/';
  await check('admin creates session (rate 4) with pasted Jira URLs -> keys extracted, URLs kept verbatim', async () => {
    const r = await http(app.base, '/api/sessions', { method: 'POST', body: {
      name: 'Team refinement', adminName: 'Alice', adminVotes: false, rate: 4, password: ADMIN_PASSWORD,
      queueText: [
        'https://url1/browse/PROJ-123',
        'https://url1/browse/PROJ-124/?foo=1',
        'https://url1/browse/PROJ-125?focusedCommentId=9',
        'https://url1/browse/PROJ-9999/',
      ].join('\n'),
    } });
    assert.equal(r.status, 201);
    sid = r.data.sessionId; adminToken = r.data.adminToken;
    assert.ok(sid.length >= 16 && adminToken.length >= 32);
    const gets = mock.requests.filter((q) => q.method === 'GET' && q.path.startsWith('/rest/api/3/issue/'));
    assert.deepEqual(gets.map((g) => g.path).sort(), ['/rest/api/3/issue/PROJ-123', '/rest/api/3/issue/PROJ-124', '/rest/api/3/issue/PROJ-125', '/rest/api/3/issue/PROJ-9999']);
    for (const g of gets) assert.deepEqual(g.query.fields.split(',').sort(), [SP_FIELD, 'issuetype', 'status', 'summary', 'timetracking'].sort());
    assert.ok(mock.requests.some((q) => q.path === '/rest/api/3/field'), 'story points field auto-discovered');
  });

  const admin = new Client(app, sid, 'admin'); clients.push(admin);
  await admin.open();
  admin.send({ type: 'hello', token: adminToken });
  await admin.waitFor((m) => m.type === 'welcome');
  let st = await admin.waitFor((m) => m.type === 'state');

  await check('queue keeps entered URLs verbatim (query, trailing slash) and shows Jira title alongside', async () => {
    assert.equal(st.queue.length, 4);
    const [a, b, c, d] = st.queue;
    assert.deepEqual([a.key, b.key, c.key, d.key], ['PROJ-123', 'PROJ-124', 'PROJ-125', 'PROJ-9999']);
    assert.equal(a.title, 'Backend: new service support');
    assert.equal(a.entered, U123); assert.equal(a.url, U123);
    assert.equal(b.entered, U124); assert.equal(b.url, U124);
    assert.equal(c.entered, U125); assert.equal(c.url, U125);
    assert.equal(d.entered, U9999); assert.equal(d.url, U9999);
    assert.ok(!a.url.includes(mock.url.replace('http://', '')), 'entered URL must not be rewritten to the mock/base Jira URL');
    assert.equal(a.type, 'Story'); assert.equal(a.currentSP, 3); assert.equal(a.currentEstimate, '1d');
    assert.equal(d.jiraError, 'Not found in Jira (or no permission)');
    assert.ok(st.queue.every((q) => q.state === 'pending'));
    assert.ok(!JSON.stringify(st).includes(TOKEN), 'Jira token never sent to browser');
  });

  const members = [];
  await check('3 members register via link and show up live for everyone', async () => {
    for (const name of ['Bob', 'Carol', 'Dave']) {
      const c = new Client(app, sid, name); clients.push(c);
      await c.open();
      c.send({ type: 'register', name });
      await c.waitFor((m) => m.type === 'welcome');
      members.push(c);
    }
    st = await admin.next((m) => m.participants.length === 4 && m.participants.filter((p) => p.online).length === 4, 3000, '4 participants');
    assert.deepEqual(st.participants.map((p) => p.name), ['Alice', 'Bob', 'Carol', 'Dave']);
    const memberView = await members[0].waitFor((m) => m.type === 'state' && m.participants.length === 4);
    assert.equal(memberView.participants.length, 4);
    assert.equal(memberView.you.isAdmin, false);
  });

  await check('duplicate names are disambiguated', async () => {
    const c = new Client(app, sid, 'dup'); await c.open();
    c.send({ type: 'register', name: 'Bob' });
    const w = await c.waitFor((m) => m.type === 'welcome');
    assert.equal(w.you.name, 'Bob (2)');
    admin.send({ type: 'kick', memberId: w.you.id });
    await admin.next((m) => m.participants.length === 4);
    await sleep(50);
  });

  await check('non-admin cannot run admin actions or Jira endpoints', async () => {
    members[0].send({ type: 'reveal' });
    const e = await members[0].waitFor((m) => m.type === 'error' && m.code === 'forbidden');
    assert.ok(e);
    const r = await http(app.base, `/api/sessions/${sid}/jira/search`, { method: 'POST', body: { jql: 'x' }, admin: members[0].you.token });
    assert.equal(r.status, 403);
    const r2 = await http(app.base, `/api/sessions/${sid}/jira/save`, { method: 'POST', body: {} });
    assert.equal(r2.status, 403);
  });

  const [bob, carol, dave] = members;
  await check('admin starts voting on first queued ticket (current highlighted)', async () => {
    admin.send({ type: 'queueSelect', itemId: st.queue[0].id });
    st = await admin.next((m) => m.round.status === 'voting');
    assert.equal(st.round.story.key, 'PROJ-123');
    assert.equal(st.round.queueItemId, st.queue[0].id);
    assert.equal(st.queue[0].state, 'current');
    assert.equal(st.round.eligibleCount, 3);
  });

  const preRevealStart = ALL.length;
  await check('votes 5, 8 -> everyone sees who voted, but no values', async () => {
    bob.send({ type: 'vote', value: '5' });
    await admin.next((m) => m.round.votedCount === 1);
    carol.send({ type: 'vote', value: '8' });
    st = await admin.next((m) => m.round.votedCount === 2);
    assert.equal(st.round.status, 'voting');
    assert.deepEqual(st.participants.map((p) => [p.name, p.voted, 'vote' in p]), [
      ['Alice', false, false], ['Bob', true, false], ['Carol', true, false], ['Dave', false, false],
    ]);
    for (const c of [admin, bob, carol, dave]) {
      const ev = await c.waitFor((m) => m.type === 'state' && m.round.votedCount === 2 && m.round.status === 'voting');
      assert.equal(ev.round.results, null);
      assert.deepEqual(ev.participants.map((p) => p.voted), [false, true, true, false]);
      for (const p of ev.participants) assert.ok(!('vote' in p));
      assertHiddenBeforeReveal(ev);
    }
  });

  await check('invalid card rejected', async () => {
    dave.send({ type: 'vote', value: '4' });
    await dave.waitFor((m) => m.type === 'error' && m.code === 'vote_rejected');
  });

  let revealed;
  await check('3rd vote (3) -> auto-reveal to everyone; avg 5.33 -> 22h, median 5 -> 20h', async () => {
    const waits = [admin, bob, carol, dave].map((c) => c.next((m) => m.round.status === 'revealed', 3000, 'reveal'));
    dave.send({ type: 'vote', value: '3' });
    const all = await Promise.all(waits);
    revealed = all[0];
    for (const m of all) assert.deepEqual(m.round.results, revealed.round.results);
    const r = revealed.round.results;
    assert.equal(revealed.round.autoRevealed, true);
    assert.deepEqual(r.values, ['3', '5', '8']);
    assert.equal(r.avg, 5.33); assert.equal(r.avgHours, 21.5);
    assert.equal(r.median, 5); assert.equal(r.medianHours, 20);
    assert.equal(r.min, 3); assert.equal(r.max, 8);
    assert.equal(r.consensus, 'spread');
    assert.deepEqual(r.histogram, [{ card: '3', count: 1 }, { card: '5', count: 1 }, { card: '8', count: 1 }]);
    assert.equal(revealed.round.finalSP, 5); // agreed pre-filled: deck card nearest median
    assert.equal(revealed.round.finalHours, 20);
    // named reveal: every client sees each member's vote next to their name
    const expectedVotes = { 'Alice': null, 'Bob': '5', 'Carol': '8', 'Dave': '3' };
    for (const m of all) {
      assertNamedAfterReveal(m);
      assert.deepEqual(votesByName(m), expectedVotes);
    }
  });

  await check('vote values hidden before reveal, attributed after reveal', () => {
    const slice = ALL.slice(preRevealStart);
    const pre = slice.filter((x) => x.msg.type === 'state' && x.msg.round.status !== 'revealed');
    const post = slice.filter((x) => x.msg.type === 'state' && x.msg.round.status === 'revealed');
    assert.ok(pre.length >= 8, `expected many pre-reveal messages, got ${pre.length}`);
    assert.ok(post.length >= 4, `expected reveal messages for all clients, got ${post.length}`);
    for (const x of pre) assertHiddenBeforeReveal(x.msg);
    for (const x of post) assertNamedAfterReveal(x.msg);
  });

  await check('rate 6 -> avg 32h, median 30h (recomputed live)', async () => {
    admin.send({ type: 'setRate', rate: 6 });
    st = await admin.next((m) => m.session.rate === 6);
    assert.equal(st.round.results.avgHours, 32);
    assert.equal(st.round.results.medianHours, 30);
    assert.equal(st.round.finalHours, 30);
    admin.send({ type: 'setRate', rate: 4 });
    st = await admin.next((m) => m.session.rate === 4);
  });

  await check('admin overrides agreed SP to 8 -> 32h (not the average/sum); Jira write-back uses agreed SP', async () => {
    admin.send({ type: 'setFinal', sp: 8 });
    st = await admin.next((m) => m.round.finalSP === 8);
    assert.equal(st.round.finalHours, 32); // ceil(8 * 4)
    assert.equal(st.round.results.avg, 5.33); // average stays for context only
    const before = mock.requests.length;
    const pSaved = admin.next((m) => m.round.savedToJira === true);
    const r = await http(app.base, `/api/sessions/${sid}/jira/save`, { method: 'POST', admin: adminToken, body: { storyPoints: 999 } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.deepEqual({ storyPoints: r.data.storyPoints, hours: r.data.hours, key: r.data.key }, { storyPoints: 8, hours: 32, key: 'PROJ-123' });
    const puts = mock.requests.slice(before).filter((q) => q.method === 'PUT');
    assert.equal(puts.length, 1);
    assert.equal(puts[0].path, '/rest/api/3/issue/PROJ-123');
    assert.equal(puts[0].contentType, 'application/json');
    assert.equal(puts[0].auth, 'Basic ' + Buffer.from(`${EMAIL}:${TOKEN}`).toString('base64'));
    assert.deepEqual(puts[0].body, { fields: { [SP_FIELD]: 8, timetracking: { originalEstimate: '32h', remainingEstimate: '32h' } } });
    st = await pSaved;
    assert.equal(st.round.story.currentSP, 8); assert.equal(st.round.story.currentEstimate, '32h');
  });

  await check('Next story -> ticket marked estimated (agreed 8 SP = 32h), queue advances, session totals', async () => {
    admin.send({ type: 'finishTicket', sp: 8 });
    st = await admin.next((m) => m.history.length === 1);
    assert.equal(st.queue[0].state, 'estimated'); assert.equal(st.queue[0].finalSP, 8); assert.equal(st.queue[0].hours, 32); assert.equal(st.queue[0].savedToJira, true);
    assert.equal(st.queue[0].entered, U123); assert.equal(st.queue[0].url, U123);
    assert.equal(st.history[0].entered, U123); assert.equal(st.history[0].url, U123); assert.equal(st.history[0].hours, 32);
    assert.equal(st.round.status, 'voting'); assert.equal(st.round.story.key, 'PROJ-124'); assert.equal(st.queue[1].state, 'current');
    const h = st.history[0];
    assert.deepEqual({ key: h.key, avg: h.avg, median: h.median, finalSP: h.finalSP, hours: h.hours, rate: h.rate }, { key: 'PROJ-123', avg: 5.33, median: 5, finalSP: 8, hours: 32, rate: 4 });
    assert.deepEqual(st.totals, { tickets: 1, agreedSP: 8, hours: 32 });
  });

  await check('admin can edit agreed SP on a finished ticket; totals and hours update', async () => {
    const itemId = st.queue[0].id;
    admin.send({ type: 'setQueueAgreed', itemId, sp: 13 });
    st = await admin.next((m) => m.queue[0].finalSP === 13);
    assert.equal(st.queue[0].hours, 52); // ceil(13 * 4)
    assert.equal(st.queue[0].savedToJira, false);
    assert.equal(st.history[0].finalSP, 13);
    assert.equal(st.history[0].hours, 52);
    assert.deepEqual(st.totals, { tickets: 1, agreedSP: 13, hours: 52 });
  });

  await check('queue admin: skip current, reorder, remove, add more keys', async () => {
    admin.send({ type: 'queueSkip', itemId: st.queue[1].id });
    st = await admin.next((m) => m.round.story?.key === 'PROJ-125');
    assert.equal(st.queue[1].state, 'skipped');
    const bogus = st.queue.find((q) => q.key === 'PROJ-9999');
    admin.send({ type: 'queueRemove', itemId: bogus.id });
    st = await admin.next((m) => m.queue.length === 3);
    const p4 = admin.next((m) => m.queue.length === 4);
    const r = await http(app.base, `/api/sessions/${sid}/queue`, { method: 'POST', admin: adminToken, body: { text: 'PROJ-126 PROJ-123' } });
    assert.equal(r.data.added, 1); // 123 already queued -> deduplicated
    st = await p4;
    assert.equal(st.queue[3].title, 'Docs for the new service');
    admin.send({ type: 'queueMove', itemId: st.queue[3].id, toIndex: 0 });
    st = await admin.next((m) => m.queue[0].key === 'PROJ-126');
    admin.send({ type: 'queueRestore', itemId: st.queue.find((q) => q.key === 'PROJ-124').id });
    st = await admin.next((m) => m.queue.find((q) => q.key === 'PROJ-124').state === 'pending');
    assert.deepEqual(st.queue.map((q) => `${q.key}:${q.state}`), ['PROJ-126:pending', 'PROJ-123:estimated', 'PROJ-124:pending', 'PROJ-125:current']);
    assert.equal(st.queue.find((q) => q.key === 'PROJ-123').finalSP, 13);
  });

  await check('reconnect with stored token -> same member, no duplicate', async () => {
    const oldId = bob.you.id; const tok = bob.you.token;
    await bob.close();
    const again = new Client(app, sid, 'Bob#2'); clients.push(again);
    await again.open();
    again.send({ type: 'hello', token: tok });
    const w = await again.waitFor((m) => m.type === 'welcome');
    assert.equal(w.you.id, oldId);
    st = await admin.next((m) => m.participants.find((p) => p.id === oldId).online);
    assert.equal(st.participants.length, 4);
    members[0] = again;
  });

  await check('offline member excluded from "everybody voted" after grace period', async () => {
    const [e2] = members;
    await dave.close();
    e2.send({ type: 'vote', value: '2' });
    carol.send({ type: 'vote', value: '3' });
    st = await admin.next((m) => m.round.votedCount === 2);
    assert.equal(st.round.status, 'voting', 'still within grace -> waits');
    st = await admin.next((m) => m.round.status === 'revealed', 4000, 'grace auto-reveal');
    assert.equal(st.round.autoRevealed, true);
    assert.deepEqual(st.round.results.values, ['2', '3']);
    assert.equal(st.round.results.avgHours, 10); // 2.5*4
    assert.equal(st.round.results.suggestedSP, 3); // median 2.5, tie goes up
    assert.equal(st.round.finalSP, 3);
    assertNamedAfterReveal(st);
    assert.deepEqual(votesByName(st)['Bob'], '2');
    assert.deepEqual(votesByName(st)['Carol'], '3');
  });

  await check('re-vote + facilitator early reveal; ? and ☕ excluded from stats', async () => {
    admin.send({ type: 'revote' });
    st = await admin.next((m) => m.round.status === 'voting' && m.round.votedCount === 0);
    members[0].send({ type: 'vote', value: '?' });
    await admin.next((m) => m.round.votedCount === 1);
    admin.send({ type: 'reveal' });
    st = await admin.next((m) => m.round.status === 'revealed');
    assert.equal(st.round.autoRevealed, false);
    assert.equal(st.round.results.unknownCount, 1); assert.equal(st.round.results.avg, null);
  });

  await check('JQL search (paginated) and board sprints: request shapes', async () => {
    const before = mock.requests.length;
    const r = await http(app.base, `/api/sessions/${sid}/jira/search`, { method: 'POST', admin: adminToken, body: { jql: 'parent = PROJ-100' } });
    assert.equal(r.status, 200);
    assert.deepEqual(r.data.issues.map((i) => i.key), ['PROJ-123', 'PROJ-124', 'PROJ-125']);
    const posts = mock.requests.slice(before).filter((q) => q.path === '/rest/api/3/search/jql');
    assert.equal(posts.length, 2);
    assert.equal(posts[0].method, 'POST');
    assert.equal(posts[0].body.jql, 'parent = PROJ-100');
    assert.deepEqual(posts[0].body.fields, ['summary', 'status', 'issuetype', 'timetracking', SP_FIELD]);
    assert.equal(posts[0].body.nextPageToken, undefined);
    assert.equal(posts[1].body.nextPageToken, 'page2');
    const s = await http(app.base, `/api/sessions/${sid}/jira/boards/77/sprints`, { admin: adminToken });
    assert.deepEqual(s.data.sprints.map((x) => x.id), [501, 502]);
    assert.ok(mock.requests.some((q) => q.path === '/rest/agile/1.0/board/77/sprint'));
  });

  await check('board picker: search by name (contains), project filter, paging, scrum first; admin only', async () => {
    const boards = (q, project) => http(app.base, `/api/sessions/${sid}/jira/boards?` + new URLSearchParams({ q, ...(project !== undefined ? { project } : {}) }), { admin: adminToken });
    let r = await boards('team');
    assert.equal(r.status, 200);
    assert.deepEqual(r.data.boards.map((b) => [b.name, b.type, b.projectKey, b.hasSprints]),
      [['Mobile team', 'scrum', 'MOB', true], ['team', 'scrum', 'OPS', true], ['Team board', 'scrum', 'PROJ', true], ['Team board kanban', 'kanban', 'PROJ', false]]);
    const req = mock.requests.filter((q) => q.path === '/rest/agile/1.0/board').at(-1);
    assert.equal(req.query.name, 'team');
    r = await boards('team', 'PROJ');
    assert.deepEqual(r.data.boards.map((b) => b.id), [77, 78]);
    assert.equal(mock.requests.filter((q) => q.path === '/rest/agile/1.0/board').at(-1).query.projectKeyOrId, 'PROJ');
    const before = mock.requests.length;
    r = await boards('filler');
    assert.equal(r.data.boards.length, 60, 'two pages joined');
    const pages = mock.requests.slice(before).filter((q) => q.path === '/rest/agile/1.0/board');
    assert.deepEqual(pages.map((q) => q.query.startAt), ['0', '50']);
    r = await boards('');
    assert.equal(r.data.boards.length, 64, 'empty query lists all boards (capped at 100)');
    r = await boards('', 'PROJ');
    assert.deepEqual(r.data.boards.map((b) => b.id), [77, 78], 'empty query + project: all boards of the project, scrum first');
    assert.equal(mock.requests.filter((q) => q.path === '/rest/agile/1.0/board').at(-1).query.name, undefined, 'no name filter sent for an empty query');
    assert.equal((await boards('x', 'bad key!')).status, 400);
    assert.equal((await http(app.base, `/api/sessions/${sid}/jira/boards?q=team`)).status, 403, 'no admin token');
    assert.equal((await http(app.base, `/api/sessions/${sid}/jira/boards/default`)).status, 403, 'no admin token');
    const d = await http(app.base, `/api/sessions/${sid}/jira/boards/default`, { admin: adminToken });
    assert.deepEqual(d.data, { board: null, configured: false });
  });

  await check('project picker: all visible projects (paged), cached, admin only', async () => {
    const before = mock.requests.length;
    const r = await http(app.base, `/api/sessions/${sid}/jira/projects`, { admin: adminToken });
    assert.equal(r.status, 200);
    assert.equal(r.data.projects.length, 60, 'two pages joined');
    assert.deepEqual(r.data.projects.find((x) => x.key === 'PROJ'), { id: '10000', key: 'PROJ', name: 'Project' });
    const pages = mock.requests.slice(before).filter((q) => q.path === '/rest/api/3/project/search');
    assert.deepEqual(pages.map((q) => q.query.startAt), ['0', '50']);
    const again = mock.requests.length;
    assert.equal((await http(app.base, `/api/sessions/${sid}/jira/projects`, { admin: adminToken })).data.projects.length, 60);
    assert.equal(mock.requests.slice(again).filter((q) => q.path === '/rest/api/3/project/search').length, 0, 'served from the 5-minute cache');
    assert.equal((await http(app.base, `/api/sessions/${sid}/jira/projects`)).status, 403, 'no admin token');
  });

  await check('non-scrum board: sprints request answers 400 with a friendly message', async () => {
    const s = await http(app.base, `/api/sessions/${sid}/jira/boards/78/sprints`, { admin: adminToken });
    assert.equal(s.status, 400);
    assert.match(s.data.error, /no sprints/);
  });

  await check('JIRA_DEFAULT_BOARD: exact name match preferred, else first contains match; numeric id; JIRA_DEFAULT_BOARD_ID alias; project filter', async () => {
    const cases = [
      [{ JIRA_DEFAULT_BOARD: 'TEAM' }, 80],                      // exact, case-insensitive (not "Mobile team")
      [{ JIRA_DEFAULT_BOARD: 'board kan' }, 78],                 // contains match
      [{ JIRA_DEFAULT_BOARD: 'Team', JIRA_DEFAULT_BOARD_PROJECT: 'PROJ' }, 77], // project filter, then first match
      [{ JIRA_DEFAULT_BOARD: '79' }, 79],                        // numeric id
      [{ JIRA_DEFAULT_BOARD_ID: '77' }, 77],                     // legacy alias
      [{ JIRA_DEFAULT_BOARD: 'no such board' }, null],
    ];
    for (const [extra, want] of cases) {
      const dapp = await startApp({ ...env, ...extra, DATA_FILE: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pp-d-')), 'sessions.json') });
      try {
        const cfg = (await http(dapp.base, '/api/config')).data;
        assert.equal(cfg.jiraDefaultBoard, extra.JIRA_DEFAULT_BOARD || extra.JIRA_DEFAULT_BOARD_ID);
        assert.equal(cfg.jiraDefaultBoardProject, extra.JIRA_DEFAULT_BOARD_PROJECT || '');
        const c = await http(dapp.base, '/api/sessions', { method: 'POST', body: { name: 'b', adminName: 'A', rate: 4, password: ADMIN_PASSWORD, queueText: '' } });
        const d = await http(dapp.base, `/api/sessions/${c.data.sessionId}/jira/boards/default`, { admin: c.data.adminToken });
        assert.equal(d.status, 200);
        assert.equal(d.data.configured, true);
        assert.equal(d.data.board ? d.data.board.id : null, want, JSON.stringify(extra));
        if (extra.JIRA_DEFAULT_BOARD_PROJECT) {
          const r = await http(dapp.base, `/api/sessions/${c.data.sessionId}/jira/boards?q=team`, { admin: c.data.adminToken });
          assert.deepEqual(r.data.boards.map((b) => b.id), [77, 78], 'picker defaults to the configured project');
        }
      } finally { await stopApp(dapp); }
    }
  });

  await check('only GET/POST-search reads + exactly one PUT were sent to Jira', () => {
    const writes = mock.requests.filter((q) => !['GET'].includes(q.method) && q.path !== '/rest/api/3/search/jql');
    assert.equal(writes.length, 1);
    assert.ok(mock.requests.every((q) => q.auth === 'Basic ' + Buffer.from(`${EMAIL}:${TOKEN}`).toString('base64')));
  });

  await check('values hidden before reveal; named votes only after reveal; no secret leaks', () => {
    assert.ok(ALL.length > 50);
    for (const x of ALL) {
      if (x.msg.type === 'state' && x.msg.round.status === 'revealed') assertNamedAfterReveal(x.msg);
      else if (x.msg.type === 'state') assertHiddenBeforeReveal(x.msg);
      else assertNoPairing(x.msg);
    }
    for (const x of ALL) assert.ok(!x.raw.includes(TOKEN), 'Jira token leaked');
    for (const x of ALL.filter((x) => x.client !== 'admin')) assert.ok(!x.raw.includes(adminToken), 'admin token leaked to member');
    console.log(`     (checked ${ALL.length} WebSocket messages)`);
  });

  await check('blank session name falls back to Estimation session; start form default + 2-line placeholder', async () => {
    const html = await (await fetch(app.base + '/')).text();
    assert.ok(html.includes('name="name" maxlength="80" value="Estimation session"'));
    assert.ok(html.includes('<input name="rate" type="number" min="0.5" max="100" step="0.5"'), 'start form rate is a 0.5-step spin button');
    assert.ok(html.includes('<input id="rateInput" type="number" min="0.5" max="100" step="0.5"'), 'settings rate is a 0.5-step spin button');
    const ph = html.match(/<textarea name="queueText"[^>]*placeholder="([^"]*)"/)[1].split('&#10;');
    assert.equal(ph.length, 2); assert.ok(ph.every((x) => x.startsWith('https://')));
    const r = await http(app.base, '/api/sessions', { method: 'POST', body: { name: '  ', adminName: 'A', rate: 4, password: ADMIN_PASSWORD, queueText: '' } });
    assert.equal(r.status, 201);
    assert.equal((await http(app.base, '/api/sessions/' + r.data.sessionId)).data.name, 'Estimation session');
  });

  // ---------------- cache-busting + configurable default session name ----------------
  await check('static assets are cache-busted: HTML no-cache, ?v=<content hash> immutable, unversioned no-cache', async () => {
    const res = await fetch(app.base + '/');
    assert.equal(res.headers.get('cache-control'), 'no-cache');
    const html = await res.text();
    assert.ok(!html.includes('__ASSET_V_'), 'placeholders replaced');
    for (const name of ['app.js', 'styles.css', 'favicon.svg']) {
      const m = html.match(new RegExp('/' + name.replace('.', '\\.') + '\\?v=([0-9a-f]{12})"'));
      assert.ok(m, 'versioned reference to ' + name);
      const want = crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, 'public', name))).digest('hex').slice(0, 12);
      assert.equal(m[1], want, 'hash of ' + name);
      const v = await fetch(app.base + '/' + name + '?v=' + m[1]);
      assert.equal(v.status, 200);
      assert.equal(v.headers.get('cache-control'), 'public, max-age=31536000, immutable');
      assert.equal((await fetch(app.base + '/' + name)).headers.get('cache-control'), 'no-cache');
      assert.equal((await fetch(app.base + '/' + name + '?v=stale')).headers.get('cache-control'), 'no-cache');
    }
    const bm = await (await fetch(app.base + '/bookmarklet.html')).text();
    assert.ok(/\/bookmarklet\.js\?v=[0-9a-f]{12}"/.test(bm));
    const hz = await (await fetch(app.base + '/healthz')).json();
    assert.equal(hz.version, PKG_VERSION);
  });

  await check('JIRA_UPDATE_DEFAULT_MODE: default both; sp/time preselected in HTML + /api/config; invalid falls back to both with a warning', async () => {
    const sel = (html) => [...html.matchAll(/<option value="(sp|time|both)"( selected)?>/g)].filter((m) => m[2]).map((m) => m[1]);
    assert.deepEqual(sel(await (await fetch(app.base + '/')).text()), ['both']);
    for (const [val, want] of [['time', 'time'], ['SP', 'sp'], ['both', 'both'], ['nonsense', 'both']]) {
      const mapp = await startApp({ ...env, JIRA_UPDATE_DEFAULT_MODE: val, DATA_FILE: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pp-m-')), 'sessions.json') });
      try {
        assert.equal((await http(mapp.base, '/api/config')).data.jiraUpdateDefaultMode, want, val);
        assert.deepEqual(sel(await (await fetch(mapp.base + '/s/abc')).text()), [want], 'session page preselects ' + want);
        const warned = /WARNING: JIRA_UPDATE_DEFAULT_MODE/.test(mapp.log());
        assert.equal(warned, val === 'nonsense', 'warning only for invalid value');
      } finally { await stopApp(mapp); }
    }
  });

  await check('DEFAULT_SESSION_NAME sets the start form default and the blank-name fallback (HTML-escaped)', async () => {
    const napp = await startApp({ ...env, DEFAULT_SESSION_NAME: 'Team <A> & "B" refinement', DATA_FILE: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pp-n-')), 'sessions.json') });
    try {
      const html = await (await fetch(napp.base + '/')).text();
      assert.ok(html.includes('value="Team &lt;A&gt; &amp; &quot;B&quot; refinement"'));
      assert.equal((await http(napp.base, '/api/config')).data.defaultSessionName, 'Team <A> & "B" refinement');
      const r = await http(napp.base, '/api/sessions', { method: 'POST', body: { name: '', adminName: 'A', rate: 4, password: ADMIN_PASSWORD, queueText: '' } });
      assert.equal(r.status, 201);
      assert.equal((await http(napp.base, '/api/sessions/' + r.data.sessionId)).data.name, 'Team <A> & "B" refinement');
    } finally { await stopApp(napp); }
  });

  // ---------------- UPDATE Jiras (manual batch) ----------------
  // Separate server WITHOUT JIRA_WRITE_BACK: the batch must not depend on the legacy flag.
  const batchEnv = { ...env, DATA_FILE: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pp-b-')), 'sessions.json') };
  delete batchEnv.JIRA_WRITE_BACK;
  const bapp = await startApp(batchEnv);
  try {
    let bsid, btoken, badmin, bm1;
    const bputs = (since) => mock.requests.slice(since).filter((q) => q.method === 'PUT');
    const hist = (m, key) => m.history.find((e) => e.key === key);
    const upd = (body, token = btoken) => http(bapp.base, `/api/sessions/${bsid}/jira/update`, { method: 'POST', admin: token, body });
    const EVERYONE = ['PROJ-123', 'PROJ-124', 'PROJ-125', 'PROJ-126'];

    await check('/api/jira/status: non-secret, configured + auto-detected SP field, write permission unknown', async () => {
      const r = await http(bapp.base, '/api/jira/status');
      assert.equal(r.status, 200);
      assert.deepEqual(r.data, { configured: true, baseUrl: mock.url, storyPointsField: SP_FIELD, storyPointsFieldSource: 'auto', storyPointsFieldError: null, writePermission: 'unknown', legacyAutoWriteBack: false });
      assert.ok(!JSON.stringify(r.data).includes(TOKEN));
    });

    await check('four tickets finished; statuses start as Not sent (no automatic write-back)', async () => {
      const r = await http(bapp.base, '/api/sessions', { method: 'POST', body: { name: 'batch', adminName: 'Alice', adminVotes: true, rate: 4, password: ADMIN_PASSWORD, queueText: EVERYONE.join('\n') } });
      assert.equal(r.status, 201); bsid = r.data.sessionId; btoken = r.data.adminToken;
      badmin = new Client(bapp, bsid, 'batch-admin'); clients.push(badmin); await badmin.open();
      badmin.send({ type: 'hello', token: btoken });
      await badmin.waitFor((m) => m.type === 'welcome');
      await badmin.waitFor((m) => m.type === 'state');
      bm1 = new Client(bapp, bsid, 'batch-member'); clients.push(bm1); await bm1.open();
      bm1.send({ type: 'register', name: 'Voter' });
      await bm1.waitFor((m) => m.type === 'welcome');
      const before = mock.requests.length;
      badmin.send({ type: 'setVoter', voter: false });
      await badmin.next((m) => m.participants.find((p) => p.isAdmin).voter === false);
      badmin.send({ type: 'queueSelect', itemId: badmin.state.queue[0].id });
      const sps = ['3', '5', '8', '2'];
      let last;
      for (let i = 0; i < 4; i++) {
        await badmin.next((m) => m.round.status === 'voting' && m.round.story?.key === EVERYONE[i], 3000, `voting ${EVERYONE[i]}`).catch(() => {});
        bm1.send({ type: 'vote', value: sps[i] });
        await badmin.next((m) => m.round.status === 'revealed');
        const p = badmin.next((m) => m.history.length === i + 1);
        badmin.send({ type: 'finishTicket', sp: Number(sps[i]) });
        last = await p;
      }
      assert.deepEqual(last.history.map((e) => [e.key, e.finalSP, e.hours, e.jira.state]), [['PROJ-123', 3, 12, 'not_sent'], ['PROJ-124', 5, 20, 'not_sent'], ['PROJ-125', 8, 32, 'not_sent'], ['PROJ-126', 2, 8, 'not_sent']]);
      assert.equal(bputs(before).length, 0, 'finishing tickets must not write to Jira');
    });

    await check('admin-only: missing/wrong/voter tokens are rejected (403) and nothing reaches Jira; bad mode 400', async () => {
      const before = mock.requests.length;
      for (const tok of ['', 'nope', bm1.you.token]) {
        const r = await upd({ mode: 'both' }, tok);
        assert.equal(r.status, 403);
      }
      assert.equal((await upd({ mode: 'bogus' })).status, 400);
      assert.equal(bputs(before).length, 0);
    });

    let afterFirst;
    await check('UPDATE Jiras (both): per-ticket results, 403 + field-not-on-screen failures keep Jira error text, concurrency <= 3, live broadcast', async () => {
      mock.controls.fail.set('PROJ-124', { status: 403, body: { errorMessages: ['You do not have permission to edit this issue.'] } });
      mock.controls.fail.set('PROJ-125', { status: 400, body: { errors: { [SP_FIELD]: "Field '" + SP_FIELD + "' cannot be set. It is not on the appropriate screen, or unknown." } } });
      mock.controls.delay = 60; mock.controls.maxInflight = 0;
      const before = mock.requests.length;
      const memberMsgsBefore = bm1.msgs.length;
      const r = await upd({ mode: 'both', ids: st2ids() });
      function st2ids() { return badmin.state.history.map((e) => e.itemId); }
      assert.equal(r.status, 200);
      assert.equal(r.data.updated, 2); assert.equal(r.data.failed, 2);
      const byKey = Object.fromEntries(r.data.results.map((x) => [x.key, x]));
      assert.equal(byKey['PROJ-123'].state, 'updated'); assert.equal(byKey['PROJ-126'].state, 'updated');
      assert.match(byKey['PROJ-124'].error, /403.*permission/i);
      assert.match(byKey['PROJ-125'].error, /not on the appropriate screen/);
      assert.ok(mock.controls.maxInflight >= 2 && mock.controls.maxInflight <= 3, `max in flight ${mock.controls.maxInflight}`);
      const put123 = bputs(before).find((q) => q.path.endsWith('PROJ-123'));
      assert.deepEqual(put123.body, { fields: { [SP_FIELD]: 3, timetracking: { originalEstimate: '12h', remainingEstimate: '12h' } } });
      // voters get the statuses live, read-only
      await sleep(100);
      const mem = bm1.msgs.slice(memberMsgsBefore).filter((m) => m.type === 'state');
      assert.ok(mem.some((m) => m.jiraBusy === true), 'busy flag broadcast');
      afterFirst = bm1.state;
      assert.equal(afterFirst.jiraBusy, false);
      assert.deepEqual(afterFirst.history.map((e) => e.jira.state), ['updated', 'failed', 'failed', 'updated']);
      assert.deepEqual(hist(afterFirst, 'PROJ-123').jira.fields, ['sp', 'time']);
      assert.ok(hist(afterFirst, 'PROJ-123').jira.at > 0);
      assert.match(hist(afterFirst, 'PROJ-124').jira.error, /permission/);
      mock.controls.delay = 0;
    });

    await check('skip already updated (no re-send); failed ones are retried with the chosen field (SP only)', async () => {
      const before = mock.requests.length;
      const r = await upd({ mode: 'sp' });
      assert.deepEqual(r.data.skipped.map((x) => [x.key, x.reason]).sort(), [['PROJ-123', 'already updated'], ['PROJ-126', 'already updated']]);
      assert.deepEqual(bputs(before).map((q) => q.path.split('/').pop()).sort(), ['PROJ-124', 'PROJ-125']);
      for (const q of bputs(before)) assert.deepEqual(Object.keys(q.body.fields), [SP_FIELD]);
      const m = await badmin.next((x) => x.history.every((e) => e.jira.state !== 'x'), 500).catch(() => badmin.state);
      assert.deepEqual(hist(badmin.state, 'PROJ-124').jira.fields, ['sp']);
    });

    await check('Retry failed resends only failed tickets with the same fields as the failed attempt', async () => {
      mock.controls.fail.delete('PROJ-124'); // permission fixed; 125 still broken
      const before = mock.requests.length;
      const r = await upd({ retryFailed: true });
      assert.equal(r.status, 200);
      const puts = bputs(before);
      assert.deepEqual(puts.map((q) => q.path.split('/').pop()).sort(), ['PROJ-124', 'PROJ-125']);
      for (const q of puts) assert.deepEqual(q.body, { fields: { [SP_FIELD]: q.path.endsWith('124') ? 5 : 8 } }, 'same field choice (story points only)');
      assert.equal(r.data.updated, 1); assert.equal(r.data.failed, 1);
      const s = badmin.state;
      assert.equal(hist(s, 'PROJ-124').jira.state, 'updated'); assert.equal(hist(s, 'PROJ-124').jira.error, null);
      assert.equal(hist(s, 'PROJ-125').jira.state, 'failed');
      // nothing failed -> retry is a no-op
      mock.controls.fail.delete('PROJ-125');
      await upd({ retryFailed: true });
      assert.equal(hist(badmin.state, 'PROJ-125').jira.state, 'updated');
      const b2 = mock.requests.length;
      const none = await upd({ retryFailed: true });
      assert.equal(none.data.results.length, 0); assert.equal(bputs(b2).length, 0);
    });

    await check('Re-send already updated: only when requested; time-only writes just the Original estimate', async () => {
      const id = hist(badmin.state, 'PROJ-123').itemId;
      let before = mock.requests.length;
      const noResend = await upd({ mode: 'time', ids: [id] });
      assert.equal(noResend.data.results.length, 0); assert.equal(bputs(before).length, 0);
      before = mock.requests.length;
      const r = await upd({ mode: 'time', ids: [id], resend: true });
      assert.equal(r.data.updated, 1);
      assert.deepEqual(bputs(before)[0].body, { fields: { timetracking: { originalEstimate: '12h', remainingEstimate: '12h' } } });
      assert.deepEqual(hist(badmin.state, 'PROJ-123').jira.fields, ['time']);
    });

    await check('Changed since update: editing agreed SP flags it, restoring clears it, and it is sent again without re-send', async () => {
      // make 123 a clean "updated" (both) first
      const id = hist(badmin.state, 'PROJ-123').itemId;
      await upd({ mode: 'both', ids: [id], resend: true });
      assert.equal(hist(badmin.state, 'PROJ-123').jira.state, 'updated');
      badmin.send({ type: 'setQueueAgreed', itemId: id, sp: 5 });
      let m = await badmin.next((x) => hist(x, 'PROJ-123').finalSP === 5);
      assert.equal(hist(m, 'PROJ-123').jira.state, 'changed');
      await sleep(150);
      assert.equal(hist(bm1.state, 'PROJ-123').jira.state, 'changed', 'voters see it too');
      badmin.send({ type: 'setQueueAgreed', itemId: id, sp: 3 });
      m = await badmin.next((x) => hist(x, 'PROJ-123').finalSP === 3);
      assert.equal(hist(m, 'PROJ-123').jira.state, 'updated');
      badmin.send({ type: 'setQueueAgreed', itemId: id, sp: 13 });
      await badmin.next((x) => hist(x, 'PROJ-123').jira.state === 'changed');
      const before = mock.requests.length;
      const r = await upd({ mode: 'both' }); // no resend: only the changed one goes out
      assert.deepEqual(r.data.results.map((x) => x.key), ['PROJ-123']);
      assert.deepEqual(bputs(before)[0].body, { fields: { [SP_FIELD]: 13, timetracking: { originalEstimate: '52h', remainingEstimate: '52h' } } });
      assert.equal(hist(badmin.state, 'PROJ-123').jira.state, 'updated');
    });

    await check('429 from Jira: honours Retry-After and succeeds after retries', async () => {
      const id = hist(badmin.state, 'PROJ-126').itemId;
      mock.controls.throttle = 2;
      const before = mock.requests.length;
      const r = await upd({ mode: 'sp', ids: [id], resend: true });
      assert.equal(r.data.updated, 1); assert.equal(r.data.failed, 0);
      assert.equal(bputs(before).length, 3, '2 throttled attempts + 1 success');
    });

    await check('statuses persist in sessions.json; token never logged or sent to clients', async () => {
      await sleep(1300);
      const saved = JSON.parse(fs.readFileSync(batchEnv.DATA_FILE, 'utf8'));
      const s = saved.sessions.find((x) => x.id === bsid);
      assert.equal(s.history.find((e) => e.key === 'PROJ-123').jira.state, 'updated');
      assert.equal(s.history.find((e) => e.key === 'PROJ-124').jira.state, 'updated');
      assert.ok(!bapp.log().includes(TOKEN), 'token not in server log');
      assert.ok(!JSON.stringify(badmin.msgs).includes(TOKEN));
    });

    await check('half-hour rate + rounding: rate 2.5 accepted; 3 SP x 2.5 = 7.5h stored; Jira Original estimate sent as "7h 30m"', async () => {
      const bad = await http(bapp.base, '/api/sessions', { method: 'POST', body: { name: 'half', adminName: 'Alice', rate: 2.3, password: ADMIN_PASSWORD, queueText: '' } });
      assert.equal(bad.status, 400, 'rate 2.3 is not a multiple of 0.5');
      for (const r of [0, 0.25, 101, 'abc']) assert.equal((await http(bapp.base, '/api/sessions', { method: 'POST', body: { name: 'x', adminName: 'A', rate: r, password: ADMIN_PASSWORD, queueText: '' } })).status, 400, 'rate ' + r);
      const r = await http(bapp.base, '/api/sessions', { method: 'POST', body: { name: 'half', adminName: 'Alice', adminVotes: true, rate: 2.5, password: ADMIN_PASSWORD, queueText: 'PROJ-125' } });
      assert.equal(r.status, 201);
      const hsid = r.data.sessionId, htok = r.data.adminToken;
      const ha = new Client(bapp, hsid, 'half-admin'); clients.push(ha); await ha.open();
      ha.send({ type: 'hello', token: htok });
      await ha.waitFor((m) => m.type === 'welcome');
      let st = await ha.waitFor((m) => m.type === 'state');
      assert.equal(st.session.rate, 2.5);
      ha.send({ type: 'setRate', rate: 3.3 });
      const err = await ha.waitFor((m) => m.type === 'error' && m.code === 'invalid_rate');
      assert.match(err.message, /multiple of 0.5/);
      ha.send({ type: 'queueSelect', itemId: st.queue[0].id });
      await ha.next((m) => m.round.status === 'voting', 3000, 'voting').catch(() => {});
      if (ha.state.round.status !== 'voting') { ha.send({ type: 'startVoting' }); await ha.next((m) => m.round.status === 'voting'); }
      ha.send({ type: 'vote', value: '3' });
      st = await ha.next((m) => m.round.status === 'revealed');
      assert.equal(st.session.rate, 2.5, 'invalid setRate left the rate unchanged');
      assert.equal(st.round.finalHours, 7.5);
      assert.equal(st.round.results.medianHours, 7.5);
      const p = ha.next((m) => m.history.length === 1);
      ha.send({ type: 'finishTicket', sp: 3 });
      st = await p;
      assert.equal(st.history[0].hours, 7.5);
      assert.equal(st.totals.hours, 7.5);
      const before = mock.requests.length;
      const u = await http(bapp.base, `/api/sessions/${hsid}/jira/update`, { method: 'POST', admin: htok, body: { mode: 'both' } });
      assert.equal(u.status, 200);
      const put = mock.requests.slice(before).find((q) => q.method === 'PUT');
      assert.deepEqual(put.body, { fields: { [SP_FIELD]: 3, timetracking: { originalEstimate: '7h 30m', remainingEstimate: '7h 30m' } } });
    });

    // estimate PROJ-126 at 1 SP x 4 = 4h in a fresh session on `appX`, then UPDATE Jiras (time); returns the Jira requests made
    async function estimateAndUpdate(appX, label) {
      const r = await http(appX.base, '/api/sessions', { method: 'POST', body: { name: label, adminName: 'Alice', adminVotes: true, rate: 4, password: ADMIN_PASSWORD, queueText: 'PROJ-126' } });
      assert.equal(r.status, 201);
      const c = new Client(appX, r.data.sessionId, label); clients.push(c); await c.open();
      c.send({ type: 'hello', token: r.data.adminToken });
      await c.waitFor((m) => m.type === 'welcome');
      const st = await c.waitFor((m) => m.type === 'state');
      c.send({ type: 'queueSelect', itemId: st.queue[0].id });
      await c.next((m) => m.round.status === 'voting', 3000, 'voting').catch(() => {});
      if (c.state.round.status !== 'voting') { c.send({ type: 'startVoting' }); await c.next((m) => m.round.status === 'voting'); }
      c.send({ type: 'vote', value: '1' });
      await c.next((m) => m.round.status === 'revealed');
      const p = c.next((m) => m.history.length === 1);
      c.send({ type: 'finishTicket', sp: 1 });
      await p;
      const before = mock.requests.length;
      const u = await http(appX.base, `/api/sessions/${r.data.sessionId}/jira/update`, { method: 'POST', admin: r.data.adminToken, body: { mode: 'time' } });
      assert.equal(u.status, 200);
      return mock.requests.slice(before).filter((q) => q.path === '/rest/api/3/issue/PROJ-126');
    }

    await check('remaining estimate recalculated: max(0, new original - time spent), read first, sent in the same PUT', async () => {
      try {
        for (const [spent, want] of [[0, '4h'], [5400, '2h 30m'], [17 * 60, '3h 43m'], [5 * 3600, '0m'], [4 * 3600, '0m']]) {
          mock.controls.spent.set('PROJ-126', spent);
          const reqs = await estimateAndUpdate(bapp, 'recalc-' + spent);
          const get = reqs.find((q) => q.method === 'GET');
          assert.ok(get && get.query.fields === 'timetracking', 'time spent read before the write (' + spent + ')');
          const puts = reqs.filter((q) => q.method === 'PUT');
          assert.equal(puts.length, 1, 'one edit call');
          assert.ok(reqs.indexOf(get) < reqs.indexOf(puts[0]), 'GET before PUT');
          assert.deepEqual(puts[0].body, { fields: { timetracking: { originalEstimate: '4h', remainingEstimate: want } } }, 'spent ' + spent);
        }
      } finally { mock.controls.spent.delete('PROJ-126'); }
    });

    await check('JIRA_RECALC_REMAINING=false keeps original-only writes (no time-spent read) and /api/config reports it', async () => {
      const oapp = await startApp({ ...batchEnv, JIRA_RECALC_REMAINING: 'false', DATA_FILE: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pp-r-')), 'sessions.json') });
      try {
        assert.equal((await http(oapp.base, '/api/config')).data.jiraRecalcRemaining, false);
        mock.controls.spent.set('PROJ-126', 5400);
        const reqs = await estimateAndUpdate(oapp, 'recalc-off');
        assert.ok(!reqs.some((q) => q.method === 'GET' && q.query.fields === 'timetracking'), 'no time-spent read');
        const puts = reqs.filter((q) => q.method === 'PUT');
        assert.equal(puts.length, 1);
        assert.deepEqual(puts[0].body, { fields: { timetracking: { originalEstimate: '4h' } } });
      } finally { mock.controls.spent.delete('PROJ-126'); await stopApp(oapp); }
    });
  } catch (e) {
    failed = true; throw e;
  } finally {
    await stopApp(bapp);
  }

  await check('/new?tickets= serves the start page; /api/prefill sanitizes, dedupes, keeps order and URLs verbatim', async () => {
    const page = await fetch(app.base + '/new?tickets=' + encodeURIComponent('PROJ-1'));
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.ok(html.includes('id="createForm"') && html.includes('name="queueText"'));
    assert.ok(!html.includes('PROJ-1,'), 'tickets are never injected server-side into the HTML');
    assert.equal((await fetch(app.base + '/bookmarklet.html')).status, 200);
    const q = new URLSearchParams();
    q.append('tickets', U123 + ',' + U124);
    q.append('tickets', U123 + ',PROJ-126,<img src=x onerror=alert(1)>,javascript:alert(1)');
    const r = await http(app.base, '/api/prefill?' + q.toString());
    assert.equal(r.status, 200);
    assert.deepEqual(r.data.tickets, [U123, U124, 'PROJ-126']);
    assert.equal(r.data.ignored.length, 2);
    assert.ok(r.data.ignored.every((x) => !/[<>"']/.test(x)));
    assert.equal(r.data.truncated, false);
    const big = new URLSearchParams({ tickets: Array.from({ length: 230 }, (_, i) => `PROJ-${i + 1}`).join(',') });
    const rb = await http(app.base, '/api/prefill?' + big.toString());
    assert.equal(rb.data.tickets.length, 200); assert.equal(rb.data.truncated, true);
  });

  await check('/api/prefill jql: needs admin password, then loads tickets via Jira search', async () => {
    const jql = 'parent = PROJ-100';
    const before = mock.requests.length;
    const noPw = await http(app.base, '/api/prefill?jql=' + encodeURIComponent(jql) + '&tickets=PROJ-126');
    assert.equal(noPw.data.jqlStatus, 'needs_password');
    assert.deepEqual(noPw.data.tickets, ['PROJ-126']);
    assert.equal(mock.requests.slice(before).filter((x) => x.path === '/rest/api/3/search/jql').length, 0, 'no Jira data without the password');
    const res = await fetch(app.base + '/api/prefill?jql=' + encodeURIComponent(jql) + '&tickets=PROJ-126', { headers: { 'X-Admin-Password': ADMIN_PASSWORD } });
    const ok = await res.json();
    assert.equal(ok.jqlStatus, 'loaded');
    assert.deepEqual(ok.tickets, ['PROJ-126', ...['123', '124', '125'].map((n) => `${mock.url}/browse/PROJ-${n}`)]);
  });

  await check('history carries no avg/median/time needs in the UI contract; totals are sum of agreed SP/hours', () => {
    assert.deepEqual(st.totals, { tickets: 1, agreedSP: 13, hours: 52 });
  });

  await check('sessions persist to DATA_FILE and survive restart (agreed SP, hours, entered URL)', async () => {
    for (const c of clients) try { c.ws.close(); } catch {}
    await stopApp(app);
    assert.ok(fs.existsSync(dataFile));
    const disk = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
    const saved = disk.sessions[0];
    const hist = saved.history[0];
    assert.equal(hist.finalSP, 13);
    assert.equal(hist.hours, 52); // stored explicitly, not recomputed away
    assert.equal(hist.entered, U123);
    const done = saved.queue.find((q) => q.key === 'PROJ-123');
    assert.equal(done.finalSP, 13); assert.equal(done.hours, 52); assert.equal(done.entered, U123);
    app = await startApp(env);
    const r = await http(app.base, `/api/sessions/${sid}`);
    assert.equal(r.status, 200);
    const c = new Client(app, sid, 'admin-after-restart'); await c.open();
    c.send({ type: 'hello', token: adminToken });
    const s2 = await c.waitFor((m) => m.type === 'state');
    assert.equal(s2.history.length, 1); assert.equal(s2.queue.length, 4);
    assert.equal(s2.history[0].finalSP, 13); assert.equal(s2.history[0].hours, 52);
    assert.equal(s2.history[0].entered, U123); assert.equal(s2.history[0].url, U123);
    assert.equal(s2.history[0].jira.state, 'changed'); // legacy save, then agreed SP edited
    const q2 = s2.queue.find((q) => q.key === 'PROJ-123');
    assert.equal(q2.hours, 52); assert.equal(q2.entered, U123); assert.equal(q2.url, U123);
    c.ws.close();
  });
} catch (e) {
  failed = true;
} finally {
  for (const c of clients) try { c.ws.close(); } catch {}
  await stopApp(app);
}

// ---------- server WITHOUT Jira ----------
if (!failed) {
  const plain = await startApp({});
  console.log('No-Jira server', plain.base);
  try {
    await check('no Jira: keys accepted with manual titles, Jira endpoints 503, no write-back', async () => {
      const cfg = await http(plain.base, '/api/config');
      assert.equal(cfg.data.jiraEnabled, false); assert.equal(cfg.data.adminPasswordRequired, false);
      const url123 = 'https://url1/browse/PROJ-123/?x=1';
      const r = await http(plain.base, '/api/sessions', { method: 'POST', body: { name: 'Offline', rate: 4, queueText: url123 + '\nPROJ-124, PROJ-125\nSome manual story' } });
      assert.equal(r.status, 201);
      const c = new Client(plain, r.data.sessionId, 'plain-admin'); await c.open();
      c.send({ type: 'hello', token: r.data.adminToken });
      const s = await c.waitFor((m) => m.type === 'state');
      assert.deepEqual(s.queue.map((q) => [q.key, q.title, q.url, q.entered, q.jiraError]), [
        ['PROJ-123', 'PROJ-123', url123, url123, null],
        ['PROJ-124', 'PROJ-124', null, 'PROJ-124', null],
        ['PROJ-125', 'PROJ-125', null, 'PROJ-125', null],
        [null, 'Some manual story', null, 'Some manual story', null],
      ]);
      c.send({ type: 'queueEdit', itemId: s.queue[1].id, title: 'Mobile part' });
      const s2 = await c.next((m) => m.queue[1].title === 'Mobile part');
      assert.equal(s2.jira.enabled, false); assert.equal(s2.jira.writeBack, false);
      const j = await http(plain.base, `/api/sessions/${r.data.sessionId}/jira/search`, { method: 'POST', admin: r.data.adminToken, body: { jql: 'x' } });
      assert.equal(j.status, 503);
      const js = await http(plain.base, '/api/jira/status');
      assert.deepEqual(js.data, { configured: false, baseUrl: null, storyPointsField: null, storyPointsFieldSource: 'unknown', storyPointsFieldError: null, writePermission: 'unknown', legacyAutoWriteBack: false });
      const up = await http(plain.base, `/api/sessions/${r.data.sessionId}/jira/update`, { method: 'POST', admin: r.data.adminToken, body: { mode: 'both' } });
      assert.equal(up.status, 503); assert.match(up.data.error, /Jira not configured: set JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN/);
      c.ws.close();
    });
  } catch { failed = true; } finally { await stopApp(plain); }
}
mock.server.close();
const pass = results.filter((r) => r[0] === 'PASS').length;
console.log(`\ne2e: ${pass}/${results.length} checks passed${failed ? ' — FAILED' : ''}`);
process.exit(failed ? 1 : 0);
