import { randomBytes } from 'crypto';
import fs from 'fs';
import path from 'path';
import type { WebSocket } from 'ws';
import { config, DEFAULT_DECK, jiraEnabled } from './config';
import { ceilHours, computeResults, isNumericCard, Results, shuffle } from './stats';

export const newId = (bytes = 16) => randomBytes(bytes).toString('base64url');

export interface Story {
  key: string | null;
  title: string;
  url: string | null;
  /** Original ticket string as typed (URL, key, or title). Never rewritten for display. */
  entered: string | null;
  type: string | null;
  status: string | null;
  currentSP: number | null;
  currentEstimate: string | null;
}

export interface QueueItem extends Story {
  id: string;
  state: 'pending' | 'current' | 'estimated' | 'skipped';
  finalSP: number | null;
  hours: number | null;
  rate: number | null;
  savedToJira: boolean;
  /** set when Jira was configured but the key could not be loaded */
  jiraError: string | null;
}

export interface Member {
  id: string;
  token: string;
  name: string;
  isAdmin: boolean;
  voter: boolean;
  joinedAt: number;
  offlineSince: number | null;
  sockets: Set<WebSocket>;
}

export interface Round {
  id: string;
  status: 'idle' | 'voting' | 'revealed';
  story: Story | null;
  /** memberId -> card. Sent to clients only AFTER reveal, attributed by name. */
  votes: Map<string, string>;
  /** frozen values at reveal time (used for stats). Identities go out only after reveal. */
  revealedValues: string[] | null;
  autoRevealed: boolean;
  finalSP: number | null;
  savedToJira: boolean;
  startedAt: number | null;
  queueItemId: string | null;
}

export type JiraFieldKey = 'sp' | 'time';
export interface JiraStatus {
  state: 'not_sent' | 'updated' | 'failed' | 'changed';
  /** epoch ms of the last attempt */
  at: number | null;
  /** fields written (updated) or attempted (failed) */
  fields: JiraFieldKey[];
  /** values that were pushed on success */
  sp: number | null;
  hours: number | null;
  error: string | null;
}
export const notSent = (): JiraStatus => ({ state: 'not_sent', at: null, fields: [], sp: null, hours: null, error: null });

export interface HistoryEntry {
  /** equals the queue item id when the story came from the queue */
  itemId: string;
  jira: JiraStatus;
  key: string | null;
  title: string;
  url: string | null;
  entered: string | null;
  votes: number;
  avg: number | null;
  median: number | null;
  finalSP: number | null;
  hours: number | null;
  rate: number;
  savedToJira: boolean;
  time: number;
}

export interface Session {
  id: string;
  name: string;
  adminToken: string;
  rate: number;
  deck: string[];
  createdAt: number;
  lastActivity: number;
  members: Map<string, Member>;
  round: Round;
  history: HistoryEntry[];
  queue: QueueItem[];
  graceTimer?: NodeJS.Timeout;
}

export const sessions = new Map<string, Session>();

const clampStr = (s: unknown, max: number) => String(s ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max);

export function sanitizeDeck(deck: unknown): string[] {
  if (!Array.isArray(deck)) return DEFAULT_DECK.slice();
  const out: string[] = [];
  for (const c of deck) {
    const v = clampStr(c, 6);
    if (v && !out.includes(v)) out.push(v);
  }
  return out.length >= 2 && out.length <= 20 ? out : DEFAULT_DECK.slice();
}

/** Hours per story point: a multiple of RATE_STEP between RATE_MIN and RATE_MAX (e.g. 0.5, 2.5, 4). */
export const RATE_STEP = 0.5;
export const RATE_MIN = 0.5;
export const RATE_MAX = 100;
export function isValidRate(rate: unknown): boolean {
  if (rate === null || rate === '' || typeof rate === 'boolean') return false;
  const r = Number(rate);
  if (!Number.isFinite(r) || r < RATE_MIN || r > RATE_MAX) return false;
  const units = r / RATE_STEP;
  return Math.abs(units - Math.round(units)) < 1e-9;
}
export function sanitizeRate(rate: unknown, fallback: number): number {
  return isValidRate(rate) ? Math.round(Number(rate) / RATE_STEP) * RATE_STEP : fallback;
}

function newRound(story: Story | null = null, status: Round['status'] = 'idle', queueItemId: string | null = null): Round {
  return {
    queueItemId,
    id: newId(8),
    status,
    story,
    votes: new Map(),
    revealedValues: null,
    autoRevealed: false,
    finalSP: null,
    savedToJira: false,
    startedAt: status === 'voting' ? Date.now() : null,
  };
}

export function createSession(opts: { name?: unknown; rate?: unknown; deck?: unknown; adminName?: unknown; adminVotes?: unknown }): Session {
  const now = Date.now();
  const s: Session = {
    id: newId(12),
    name: clampStr(opts.name, 80) || config.defaultSessionName,
    adminToken: newId(24),
    rate: sanitizeRate(opts.rate, config.defaultRate),
    deck: sanitizeDeck(opts.deck),
    createdAt: now,
    lastActivity: now,
    members: new Map(),
    round: newRound(),
    history: [],
    queue: [],
  };
  const admin: Member = {
    id: newId(9),
    token: s.adminToken,
    name: clampStr(opts.adminName, 40) || 'Facilitator',
    isAdmin: true,
    voter: Boolean(opts.adminVotes),
    joinedAt: now,
    offlineSince: now,
    sockets: new Set(),
  };
  s.members.set(admin.id, admin);
  sessions.set(s.id, s);
  scheduleSave();
  return s;
}

export function findMemberByToken(s: Session, token: string): Member | undefined {
  if (!token) return undefined;
  for (const m of s.members.values()) if (m.token === token) return m;
  return undefined;
}

export function registerMember(s: Session, rawName: unknown): Member {
  let base = clampStr(rawName, 40);
  if (!base) throw new Error('Name is required');
  const taken = new Set([...s.members.values()].map((m) => m.name.toLowerCase()));
  let name = base;
  for (let i = 2; taken.has(name.toLowerCase()); i++) name = `${base} (${i})`;
  const m: Member = {
    id: newId(9),
    token: newId(24),
    name,
    isAdmin: false,
    voter: true,
    joinedAt: Date.now(),
    offlineSince: null,
    sockets: new Set(),
  };
  s.members.set(m.id, m);
  touch(s);
  return m;
}

export const isOnline = (m: Member) => m.sockets.size > 0;

/** Voters that count for the "everybody voted" check: online, or offline within grace period. */
export function eligibleVoters(s: Session, now = Date.now()): Member[] {
  return [...s.members.values()].filter(
    (m) => m.voter && (isOnline(m) || (m.offlineSince !== null && now - m.offlineSince < config.offlineGraceMs)),
  );
}

export function touch(s: Session) {
  s.lastActivity = Date.now();
  scheduleSave();
}

// ---------- round actions ----------

function releaseCurrent(s: Session) {
  const cur = s.queue.find((q) => q.id === s.round.queueItemId);
  if (cur && cur.state === 'current') cur.state = 'pending';
}

export function setStory(s: Session, story: Story | null) {
  releaseCurrent(s);
  s.round = newRound(story, s.round.status === 'voting' ? 'voting' : 'idle');
}

export function startVoting(s: Session, story?: Story | null) {
  if (story !== undefined) {
    releaseCurrent(s);
    s.round = newRound(story, 'voting');
  } else s.round = newRound(s.round.story, 'voting', s.round.queueItemId);
}

// ---------- estimation queue ----------

const KEY_RE_G = /\b[A-Za-z][A-Za-z0-9_]+-\d+\b/g;

export interface ParsedQueueEntry {
  key: string | null;
  title: string | null;
  /** Exact token as it appeared in the pasted text (URL kept verbatim, including query and trailing slash). */
  entered: string;
}

export const isHttpUrl = (s: unknown): s is string => typeof s === 'string' && /^https?:\/\//i.test(s.trim());

/** Extract a Jira issue key from a URL or free text, or null. */
export function keyFromText(s: string): string | null {
  const m = s.match(/\b[A-Za-z][A-Za-z0-9_]+-\d+\b/);
  return m && m[0] ? m[0].toUpperCase() : null;
}

/**
 * Parse pasted text. Each line may be one or more ticket URLs, a list of keys
 * separated by comma/space/semicolon, "KEY some manual title", "URL some title",
 * or a plain title. URL tokens are stored exactly as written.
 */
export function parseQueueText(text: unknown): ParsedQueueEntry[] {
  const out: ParsedQueueEntry[] = [];
  const seen = new Set<string>();
  const add = (e: ParsedQueueEntry) => {
    const id = e.key || e.entered.toLowerCase();
    if (seen.has(id)) return;
    seen.add(id);
    out.push(e);
  };
  for (const line of String(text ?? '').slice(0, 20000).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const urlRe = /https?:\/\/[^\s,;|<>"')\]]+/gi;
    const urls = trimmed.match(urlRe) ?? [];
    if (urls.length) {
      const rest = trimmed.replace(urlRe, '').replace(/[,;|\s]+/g, ' ').trim();
      if (urls.length === 1 && rest) {
        add({ key: keyFromText(urls[0]), title: rest.slice(0, 300), entered: urls[0] });
      } else {
        for (const u of urls) add({ key: keyFromText(u), title: null, entered: u });
      }
      continue;
    }
    const keys: string[] = Array.from(trimmed.match(KEY_RE_G) ?? []);
    const rest = trimmed.replace(KEY_RE_G, '').replace(/[,;|\s]+/g, ' ').trim();
    if (keys.length && !rest) {
      for (const k of keys) add({ key: k.toUpperCase(), title: null, entered: k });
    } else if (keys.length) {
      const title = trimmed.replace(keys[0]!, '').replace(/^[\s:\-–—,;|]+/, '').trim();
      add({ key: keys[0]!.toUpperCase(), title: title.slice(0, 300) || null, entered: keys[0]! });
    } else add({ key: null, title: trimmed.slice(0, 300), entered: trimmed.slice(0, 300) });
  }
  return out.slice(0, 200);
}

export const MAX_PREFILL_TICKETS = 200;

/**
 * Sanitize ticket tokens coming from a link (/new?tickets=...). Accepts only http(s) URLs
 * (no whitespace or markup characters) or KEY-123 patterns. Order kept, deduped, capped.
 * Returned strings are treated as plain text everywhere; accepted URLs are kept verbatim.
 */
export function sanitizeTickets(inputs: string[]): { tickets: string[]; ignored: string[]; truncated: boolean } {
  const tickets: string[] = [];
  const ignored: string[] = [];
  const seen = new Set<string>();
  let truncated = false;
  for (const input of inputs) {
    for (const raw of String(input ?? '').split(/[,\r\n]+/)) {
      const tok = raw.trim();
      if (!tok) continue;
      const okUrl = /^https?:\/\/[^\s<>"'`\\]{1,2000}$/i.test(tok);
      const okKey = /^[A-Za-z][A-Za-z0-9_]+-\d+$/.test(tok);
      if (!okUrl && !okKey) {
        ignored.push(tok.replace(/[\u0000-\u001f<>"'`]/g, '').slice(0, 60));
        continue;
      }
      if (seen.has(tok)) continue;
      if (tickets.length >= MAX_PREFILL_TICKETS) { truncated = true; continue; }
      seen.add(tok);
      tickets.push(tok);
    }
  }
  return { tickets, ignored, truncated };
}

export function addQueueItems(s: Session, items: Omit<QueueItem, 'id' | 'state' | 'finalSP' | 'hours' | 'rate' | 'savedToJira'>[]): QueueItem[] {
  const existing = new Set(s.queue.filter((q) => q.key).map((q) => q.key));
  const added: QueueItem[] = [];
  for (const it of items) {
    if (it.key && existing.has(it.key)) continue;
    if (it.key) existing.add(it.key);
    const q: QueueItem = { ...it, id: newId(6), state: 'pending', finalSP: null, hours: null, rate: null, savedToJira: false };
    s.queue.push(q);
    added.push(q);
  }
  if (s.queue.length > 300) s.queue.splice(0, s.queue.length - 300);
  return added;
}

const storyOf = (q: QueueItem): Story => ({
  key: q.key, title: q.title, url: q.url, entered: q.entered ?? q.url ?? q.key,
  type: q.type, status: q.status, currentSP: q.currentSP, currentEstimate: q.currentEstimate,
});

/** Make a queue item current and open voting on it. */
export function selectQueueItem(s: Session, itemId: string, startVote = true): boolean {
  const q = s.queue.find((x) => x.id === itemId);
  if (!q) return false;
  releaseCurrent(s);
  q.state = 'current';
  s.round = newRound(storyOf(q), startVote ? 'voting' : 'idle', q.id);
  return true;
}

export function nextPending(s: Session): QueueItem | undefined {
  return s.queue.find((q) => q.state === 'pending');
}

export function moveQueueItem(s: Session, itemId: string, toIndex: number) {
  const i = s.queue.findIndex((q) => q.id === itemId);
  if (i < 0 || !Number.isInteger(toIndex)) return;
  const [it] = s.queue.splice(i, 1);
  s.queue.splice(Math.max(0, Math.min(s.queue.length, toIndex)), 0, it);
}

export function removeQueueItem(s: Session, itemId: string) {
  const i = s.queue.findIndex((q) => q.id === itemId);
  if (i < 0) return;
  if (s.round.queueItemId === itemId) s.round = newRound();
  s.queue.splice(i, 1);
}

export function skipQueueItem(s: Session, itemId: string) {
  const q = s.queue.find((x) => x.id === itemId);
  if (!q) return;
  const wasCurrent = s.round.queueItemId === itemId;
  q.state = 'skipped';
  if (wasCurrent) {
    const nx = nextPending(s);
    if (nx) selectQueueItem(s, nx.id, true);
    else s.round = newRound();
  }
}

export function unskipQueueItem(s: Session, itemId: string) {
  const q = s.queue.find((x) => x.id === itemId);
  if (q && (q.state === 'skipped' || q.state === 'estimated')) q.state = 'pending';
}

export function castVote(s: Session, m: Member, value: unknown): boolean {
  if (s.round.status !== 'voting' || !m.voter) return false;
  if (value === null) {
    s.round.votes.delete(m.id);
    return true;
  }
  const v = String(value);
  if (!s.deck.includes(v)) return false;
  s.round.votes.set(m.id, v);
  return true;
}

export function reveal(s: Session, auto = false) {
  if (s.round.status !== 'voting') return;
  s.round.status = 'revealed';
  s.round.autoRevealed = auto;
  s.round.revealedValues = shuffle([...s.round.votes.values()]);
  const r = computeResults(s.round.revealedValues, s.rate, s.deck);
  s.round.finalSP = r.suggestedSP;
}

/** Auto-reveal when every eligible voter has voted. Returns true if it revealed. */
export function checkAutoReveal(s: Session): boolean {
  if (s.round.status !== 'voting') return false;
  const eligible = eligibleVoters(s);
  if (!eligible.length) return false;
  if (eligible.every((m) => s.round.votes.has(m.id))) {
    reveal(s, true);
    return true;
  }
  return false;
}

export function revote(s: Session) {
  startVoting(s, s.round.story);
}

export function parseSP(sp: unknown): number | null | undefined {
  if (sp === null || sp === '') return null;
  const n = Number(sp);
  if (!Number.isFinite(n) || n < 0 || n > 10000) return undefined;
  return Math.round(n * 1000) / 1000;
}

export function setFinal(s: Session, sp: unknown) {
  if (s.round.status !== 'revealed') return;
  const n = parseSP(sp);
  if (n !== undefined) s.round.finalSP = n;
}

/** Edit the official agreed SP on a ticket that has already been finished. */
export function setQueueAgreed(s: Session, itemId: string, sp: unknown): boolean {
  const q = s.queue.find((x) => x.id === itemId);
  if (!q || q.state !== 'estimated') return false;
  const n = parseSP(sp);
  if (n === undefined) return false;
  q.finalSP = n;
  q.hours = n === null ? null : ceilHours(n, q.rate ?? s.rate);
  q.savedToJira = false;
  const match = [...s.history].reverse().find((e) => e.itemId === q.id) ?? [...s.history].reverse().find((e) => (q.key ? e.key === q.key : e.title === q.title));
  if (match) {
    const j = match.jira;
    if (j && (j.state === 'updated' || j.state === 'changed')) {
      // agreed SP edited after a successful update -> "changed since update" (back to updated if restored)
      j.state = n !== null && n === j.sp ? 'updated' : 'changed';
    }
    match.finalSP = q.finalSP;
    match.hours = q.hours;
    match.savedToJira = false;
    match.rate = q.rate ?? s.rate;
  }
  return true;
}

/** sessions with a Jira batch update currently running (not persisted) */
export const updatingSessions = new Set<string>();

export function sessionTotals(s: Session): { tickets: number; agreedSP: number; hours: number } {
  const items = s.history.filter((e) => e.finalSP !== null && e.finalSP !== undefined);
  const agreedSP = items.reduce((a, e) => a + (e.finalSP as number), 0);
  const hours = items.reduce((a, e) => a + (e.hours ?? 0), 0);
  return { tickets: items.length, agreedSP: Math.round(agreedSP * 1000) / 1000, hours: Math.round(hours * 1e6) / 1e6 };
}

export function nextStory(s: Session) {
  if (s.round.status === 'revealed') {
    const r = results(s)!;
    s.history.push({
      itemId: s.round.queueItemId || newId(6),
      jira: s.round.savedToJira ? { state: 'updated', at: Date.now(), fields: config.jira.writeOriginalEstimate ? ['sp', 'time'] : ['sp'], sp: s.round.finalSP, hours: s.round.finalSP === null ? null : ceilHours(s.round.finalSP, s.rate), error: null } : notSent(),
      key: s.round.story?.key ?? null,
      title: s.round.story?.title || 'Untitled story',
      url: s.round.story?.url ?? null,
      entered: s.round.story?.entered ?? s.round.story?.url ?? s.round.story?.key ?? null,
      votes: r.totalVotes,
      avg: r.avg,
      median: r.median,
      finalSP: s.round.finalSP,
      hours: s.round.finalSP === null ? null : ceilHours(s.round.finalSP, s.rate),
      rate: s.rate,
      savedToJira: s.round.savedToJira,
      time: Date.now(),
    });
    if (s.history.length > 500) s.history.shift();
    const q = s.queue.find((x) => x.id === s.round.queueItemId);
    if (q) {
      q.state = 'estimated';
      q.finalSP = s.round.finalSP;
      q.hours = s.round.finalSP === null ? null : ceilHours(s.round.finalSP, s.rate);
      q.rate = s.rate;
      q.savedToJira = s.round.savedToJira;
      if (s.round.story) {
        q.currentSP = s.round.story.currentSP;
        q.currentEstimate = s.round.story.currentEstimate;
      }
    }
  } else releaseCurrent(s);
  const nx = nextPending(s);
  if (nx) selectQueueItem(s, nx.id, true);
  else s.round = newRound();
}

export function results(s: Session): Results | null {
  if (s.round.status !== 'revealed' || !s.round.revealedValues) return null;
  return computeResults(s.round.revealedValues, s.rate, s.deck);
}

// ---------- client view (the ONLY thing sent to browsers) ----------

export function publicState(s: Session) {
  const now = Date.now();
  const eligible = new Set(eligibleVoters(s, now).map((m) => m.id));
  const voting = s.round.status === 'voting';
  const participants = [...s.members.values()]
    .sort((a, b) => Number(b.isAdmin) - Number(a.isAdmin) || a.joinedAt - b.joinedAt)
    .map((m) => ({
      id: m.id,
      name: m.name,
      isAdmin: m.isAdmin,
      voter: m.voter,
      online: isOnline(m),
      counted: eligible.has(m.id),
      // Before reveal: boolean only. After reveal: also the attributed vote value.
      voted: s.round.status !== 'idle' && s.round.votes.has(m.id),
      ...(s.round.status === 'revealed' ? { vote: s.round.votes.get(m.id) ?? null } : {}),
    }));
  const r = results(s);
  return {
    session: { id: s.id, name: s.name, rate: s.rate, deck: s.deck, createdAt: s.createdAt },
    totals: sessionTotals(s),
    jiraBusy: updatingSessions.has(s.id),
    jira: {
      enabled: jiraEnabled(),
      writeBack: jiraEnabled() && config.jira.writeBack,
      baseUrl: jiraEnabled() ? config.jira.baseUrl : null,
      defaultJql: config.jira.defaultJql,
      defaultBoard: config.jira.defaultBoard,
      defaultBoardProject: config.jira.defaultBoardProject,
    },
    participants,
    round: {
      id: s.round.id,
      status: s.round.status,
      story: s.round.story,
      votedCount: voting || s.round.status === 'revealed' ? s.round.votes.size : 0,
      eligibleCount: eligible.size,
      autoRevealed: s.round.autoRevealed,
      results: r,
      finalSP: s.round.status === 'revealed' ? s.round.finalSP : null,
      finalHours: s.round.status === 'revealed' && s.round.finalSP !== null ? ceilHours(s.round.finalSP, s.rate) : null,
      savedToJira: s.round.savedToJira,
      queueItemId: s.round.queueItemId,
    },
    queue: s.queue,
    history: s.history,
  };
}

// ---------- persistence ----------

let saveTimer: NodeJS.Timeout | null = null;
export function scheduleSave() {
  if (!config.dataFile || saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveNow();
  }, 1000);
}

export function saveNow() {
  if (!config.dataFile) return;
  const data = [...sessions.values()].map((s) => ({
    ...s,
    graceTimer: undefined,
    members: [...s.members.values()].map((m) => ({ ...m, sockets: undefined })),
    round: { ...s.round, votes: [...s.round.votes.entries()] },
  }));
  try {
    fs.mkdirSync(path.dirname(config.dataFile), { recursive: true });
    const tmp = config.dataFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, sessions: data }), { mode: 0o600 });
    fs.renameSync(tmp, config.dataFile);
  } catch (e) {
    console.error('[persist] save failed:', (e as Error).message);
  }
}

export function loadSessions() {
  if (!config.dataFile || !fs.existsSync(config.dataFile)) return;
  try {
    const raw = JSON.parse(fs.readFileSync(config.dataFile, 'utf8'));
    const now = Date.now();
    for (const d of raw.sessions || []) {
      if (now - d.lastActivity > config.sessionTtlMs) continue;
      const s: Session = {
        ...d,
        queue: d.queue || [],
        members: new Map(d.members.map((m: any) => [m.id, { ...m, sockets: new Set(), offlineSince: now }])),
        round: { ...d.round, votes: new Map(d.round.votes) },
      };
      // migrate sessions saved by older versions: history ids + Jira status
      for (const e of s.history as any[]) {
        if (!e.itemId) e.itemId = newId(6);
        if (!e.jira) e.jira = e.savedToJira ? { state: 'updated', at: e.time ?? null, fields: ['sp'], sp: e.finalSP ?? null, hours: e.hours ?? null, error: null } : notSent();
      }
      sessions.set(s.id, s);
    }
    console.log(`[persist] restored ${sessions.size} session(s) from ${config.dataFile}`);
  } catch (e) {
    console.error('[persist] load failed:', (e as Error).message);
  }
}

export function expireSessions(onExpire: (s: Session) => void) {
  const now = Date.now();
  for (const s of sessions.values()) {
    if (now - s.lastActivity > config.sessionTtlMs) {
      onExpire(s);
      sessions.delete(s.id);
    }
  }
  scheduleSave();
}

export { isNumericCard };
