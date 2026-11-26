import assert from 'assert/strict';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { ceilHours, jiraDuration, computeResults, nearestCard } = require('../build/stats.js');
const { parseQueueText, isHttpUrl, keyFromText, sanitizeTickets, MAX_PREFILL_TICKETS, createSession, setQueueAgreed, notSent } = require('../build/sessions.js');

const deck = ['0', '0.5', '1', '2', '3', '5', '8', '13', '21', '?', '☕'];
// rounding up, with float guard
// default step 0.5h: always round UP to the next half hour
assert.equal(ceilHours(16 / 3, 4), 21.5); // 21.333 -> 21.5
assert.equal(ceilHours(5, 4), 20);
assert.equal(ceilHours(16 / 3, 6), 32); // 31.9999... -> 32, not 32.5
assert.equal(ceilHours(5, 6), 30);
assert.equal(ceilHours(0.1 * 3, 10), 3); // 3.0000000000000004 must stay 3
assert.equal(ceilHours(0.5, 3), 1.5);
assert.equal(ceilHours(0.5, 5), 2.5);
assert.equal(ceilHours(0.55, 4), 2.5); // 2.2 -> 2.5
assert.equal(ceilHours(0.575, 4), 2.5); // 2.3 -> 2.5
assert.equal(ceilHours(0.65, 4), 3); // 2.6 -> 3
assert.equal(ceilHours(0, 4), 0);
// explicit steps
assert.equal(ceilHours(16 / 3, 4, 1), 22); // old whole-hour behaviour
assert.equal(ceilHours(0.5, 3, 1), 2);
assert.equal(ceilHours(16 / 3, 4, 0.25), 21.5); // 21.333 -> 21.5 (quarter)
assert.equal(ceilHours(0.53, 4, 0.25), 2.25); // 2.12 -> 2.25
// Jira duration strings
assert.equal(jiraDuration(32), '32h');
assert.equal(jiraDuration(21.5), '21h 30m');
assert.equal(jiraDuration(0.5), '30m');
assert.equal(jiraDuration(2.25), '2h 15m');
assert.equal(jiraDuration(0), '0h');

// hours per story point: multiples of 0.5 between 0.5 and 100
{
  const { isValidRate, sanitizeRate } = require('../build/sessions.js');
  for (const ok of [0.5, 1, 2.5, 4, '4.5', 100]) assert.equal(isValidRate(ok), true, 'valid ' + ok);
  for (const bad of [0, 0.25, 2.3, 3.3, 100.5, -1, 'abc', '', null, undefined, true, NaN]) assert.equal(isValidRate(bad), false, 'invalid ' + bad);
  assert.equal(sanitizeRate('2.5', 4), 2.5);
  assert.equal(sanitizeRate(2.3, 4), 4);
}

const r = computeResults(['8', '3', '?', '5', '☕'], 4, deck);
assert.deepEqual(r.values, ['3', '5', '8', '?', '☕']);
assert.equal(r.avg, 5.33); assert.equal(r.avgHours, 21.5);
assert.equal(r.median, 5); assert.equal(r.medianHours, 20);
assert.equal(r.unknownCount, 1); assert.equal(r.coffeeCount, 1); assert.equal(r.numericCount, 3);
assert.equal(r.consensus, 'spread'); assert.equal(r.suggestedSP, 5);
assert.equal(computeResults(['5', '5'], 4, deck).consensus, 'consensus');
assert.equal(computeResults(['5', '8'], 4, deck).consensus, 'close');
assert.equal(computeResults(['5', '8'], 4, deck).median, 6.5);
assert.equal(computeResults(['5', '8'], 4, deck).suggestedSP, 8); // 6.5, tie 5 vs 8 goes up
assert.equal(computeResults(['3', '5'], 4, deck).suggestedSP, 5); // median 4, tie goes up
assert.equal(computeResults(['3', '5', '8'], 4, deck).suggestedSP, 5);
assert.equal(computeResults(['?'], 4, deck).avgHours, null);
assert.equal(computeResults(['?'], 4, deck).suggestedSP, null);
assert.equal(nearestCard(6.5, deck), 8);
assert.equal(nearestCard(5, deck), 5);
assert.equal(nearestCard(4, deck), 5);
assert.equal(nearestCard(0.25, deck), 0.5);
assert.equal(nearestCard(0.25, ['0', '1']), 0); // closer to 0, no tie

assert.deepEqual(parseQueueText('PROJ-123, PROJ-124\nproj-125 PROJ-123\n\nPROJ-126 Docs for X\nJust a title'), [
  { key: 'PROJ-123', title: null, entered: 'PROJ-123' },
  { key: 'PROJ-124', title: null, entered: 'PROJ-124' },
  { key: 'PROJ-125', title: null, entered: 'proj-125' },
  { key: 'PROJ-126', title: 'Docs for X', entered: 'PROJ-126' },
  { key: null, title: 'Just a title', entered: 'Just a title' },
]);

const u1 = 'https://url1/browse/PROJ-100';
const u2 = 'https://url1/browse/PROJ-123/?foo=1';
const u3 = 'https://url1/browse/PROJ-124?focusedCommentId=9';
const u4 = 'https://url1/browse/PROJ-125/';
assert.deepEqual(parseQueueText(`${u1}\n${u2}\n${u3}\n${u4}`), [
  { key: 'PROJ-100', title: null, entered: u1 },
  { key: 'PROJ-123', title: null, entered: u2 },
  { key: 'PROJ-124', title: null, entered: u3 },
  { key: 'PROJ-125', title: null, entered: u4 },
]);
assert.deepEqual(parseQueueText(`${u1}, ${u2}`).map((e) => e.entered), [u1, u2]);
assert.deepEqual(parseQueueText(`${u1} Docs for X`), [
  { key: 'PROJ-100', title: 'Docs for X', entered: u1 },
]);
assert.equal(isHttpUrl(u2), true);
assert.equal(isHttpUrl('PROJ-123'), false);
assert.equal(keyFromText(u2), 'PROJ-123');
assert.equal(keyFromText(u4), 'PROJ-125');

// ---- /new?tickets= sanitizer
const a1 = 'https://url1/browse/PROJ-100';
const a2 = 'https://url1/browse/PROJ-123/?foo=1&bar=2';
let sn = sanitizeTickets([`${a1},${a2},PROJ-124,${a1}`]);
assert.deepEqual(sn.tickets, [a1, a2, 'PROJ-124']); // verbatim, deduped, order kept
assert.deepEqual(sn.ignored, []);
sn = sanitizeTickets([a1, `${a2},PROJ-124`]); // repeated params
assert.deepEqual(sn.tickets, [a1, a2, 'PROJ-124']);
sn = sanitizeTickets(['<script>alert(1)</script>,javascript:alert(1),ftp://x/y,PROJ-1,https://a/b"onmouseover=1,not a ticket,https://ok.example/browse/A-1']);
assert.deepEqual(sn.tickets, ['PROJ-1', 'https://ok.example/browse/A-1']);
assert.equal(sn.ignored.length, 5);
assert.ok(sn.ignored.every((x) => !/[<>"']/.test(x)), 'ignored entries are stripped of markup characters');
const many = Array.from({ length: 250 }, (_, i) => `PROJ-${i + 1}`).join(',');
sn = sanitizeTickets([many]);
assert.equal(MAX_PREFILL_TICKETS, 200); assert.equal(sn.tickets.length, 200); assert.equal(sn.truncated, true);
assert.equal(sanitizeTickets(['']).tickets.length, 0);

// ---- Jira status transitions (changed since update)
{
  const s = createSession({ name: 't', rate: 4 });
  s.queue.push({ id: 'q1', key: 'PROJ-1', title: 'x', url: null, entered: 'PROJ-1', state: 'estimated', finalSP: 3, hours: 12, rate: 4, savedToJira: false, jiraError: null });
  s.history.push({ itemId: 'q1', jira: notSent(), key: 'PROJ-1', title: 'x', url: null, entered: 'PROJ-1', votes: 1, avg: 3, median: 3, finalSP: 3, hours: 12, rate: 4, savedToJira: false, time: 1 });
  const h = s.history[0];
  assert.equal(h.jira.state, 'not_sent');
  setQueueAgreed(s, 'q1', 5);
  assert.equal(h.jira.state, 'not_sent'); // never sent -> stays not sent
  h.jira = { state: 'updated', at: 1, fields: ['sp', 'time'], sp: 5, hours: 20, error: null };
  setQueueAgreed(s, 'q1', 8);
  assert.equal(h.jira.state, 'changed'); assert.equal(h.hours, 32);
  setQueueAgreed(s, 'q1', 5);
  assert.equal(h.jira.state, 'updated'); // restored to the pushed value
  h.jira = { state: 'failed', at: 1, fields: ['sp'], sp: null, hours: null, error: 'Jira 403: nope' };
  setQueueAgreed(s, 'q1', 13);
  assert.equal(h.jira.state, 'failed'); // failures stay failed until retried
}
{
  const { parseJiraUpdateMode } = require('../build/config.js');
  assert.deepEqual(parseJiraUpdateMode(undefined), { mode: 'both', warning: null });
  assert.deepEqual(parseJiraUpdateMode(''), { mode: 'both', warning: null });
  assert.deepEqual(parseJiraUpdateMode(' Time '), { mode: 'time', warning: null });
  assert.deepEqual(parseJiraUpdateMode('sp'), { mode: 'sp', warning: null });
  const bad = parseJiraUpdateMode('points');
  assert.equal(bad.mode, 'both');
  assert.ok(bad.warning && bad.warning.includes('JIRA_UPDATE_DEFAULT_MODE'));
}
{
  const { jiraDurationSeconds, remainingAfter } = require('../build/stats.js');
  assert.equal(jiraDurationSeconds(0), '0m');
  assert.equal(jiraDurationSeconds(1800), '30m');
  assert.equal(jiraDurationSeconds(9000), '2h 30m');
  assert.equal(jiraDurationSeconds(4 * 3600), '4h');
  assert.equal(jiraDurationSeconds(-5), '0m');
  assert.equal(remainingAfter(4, 0), '4h');            // nothing logged
  assert.equal(remainingAfter(4, 5400), '2h 30m');     // 1h 30m logged
  assert.equal(remainingAfter(7.5, 3600), '6h 30m');
  assert.equal(remainingAfter(4, 5 * 3600), '0m');     // logged over the estimate -> 0
  assert.equal(remainingAfter(4, 4 * 3600), '0m');
}
console.log('unit: all assertions passed');
