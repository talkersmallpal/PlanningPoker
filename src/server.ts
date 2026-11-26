import http from 'http';
import fs from 'fs';
import path from 'path';
import { createHash, timingSafeEqual } from 'crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { config, jiraEnabled } from './config';
import * as S from './sessions';
import { ISSUE_KEY_RE, JiraError, boardSprints, getIssues, jiraStatusInfo, listProjects, resolveBoard, saveEstimate, searchBoards, searchIssues, updateIssueFields } from './jira';
import { ceilHours, jiraDuration } from './stats';

const PUBLIC_DIR = path.resolve(__dirname, '..', 'public');
const APP_VERSION: string = (() => {
  try {
    return String(JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'package.json'), 'utf8')).version || 'dev');
  } catch {
    return 'dev';
  }
})();
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
};
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy':
    "default-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data:; style-src 'self'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'",
};

const JIRA_UPDATE_CONCURRENCY = 3;

function safeEq(a: string, b: string): boolean {
  const A = Buffer.from(a), B = Buffer.from(b);
  return A.length === B.length && timingSafeEqual(A, B);
}

function send(res: http.ServerResponse, status: number, body: unknown) {
  const json = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...SECURITY_HEADERS });
  res.end(json);
}

function readJson(req: http.IncomingMessage, limit = 64 * 1024): Promise<any> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('Body too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

// ---------- static assets with cache-busting ----------
// HTML pages reference assets as /app.js?v=<content hash>. Versioned requests are cached for a year
// (immutable); HTML and unversioned requests are revalidated on every load, so an upgrade never needs a hard refresh.
const HTML_PAGES = new Set(['/index.html', '/bookmarklet.html']);
const assetHashes = new Map<string, string>();
function assetHash(name: string): string {
  let h = assetHashes.get(name);
  if (h === undefined) {
    try {
      h = createHash('sha256').update(fs.readFileSync(path.join(PUBLIC_DIR, name))).digest('hex').slice(0, 12);
    } catch {
      h = APP_VERSION;
    }
    assetHashes.set(name, h);
  }
  return h;
}
function escapeAttr(v: string): string {
  return v.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
const htmlCache = new Map<string, Buffer>();
function renderHtml(rel: string, data: Buffer): Buffer {
  let out = htmlCache.get(rel);
  if (!out) {
    let html = data.toString('utf8').replace(/__ASSET_V_([A-Za-z0-9_.-]+)__/g, (_m, name: string) => assetHash(name));
    if (rel === '/index.html') {
      const n = escapeAttr(config.defaultSessionName);
      html = html.replace('value="Estimation session" placeholder="Estimation session"', `value="${n}" placeholder="${n}"`);
      // preselect the configured default of the "Update in Jira" selector
      html = html.replace('<option value="both" selected>Both</option>', '<option value="both">Both</option>')
        .replace(`<option value="${config.jira.updateDefaultMode}">`, `<option value="${config.jira.updateDefaultMode}" selected>`);
    }
    out = Buffer.from(html, 'utf8');
    htmlCache.set(rel, out);
  }
  return out;
}

function serveStatic(req: http.IncomingMessage, res: http.ServerResponse, pathname: string, search: URLSearchParams) {
  let rel = pathname === '/' || pathname === '/new' || pathname.startsWith('/s/') ? '/index.html' : pathname;
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 404, { error: 'Not found' });
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, { error: 'Not found' });
    const isHtml = HTML_PAGES.has(rel);
    const body = isHtml ? renderHtml(rel, data) : data;
    const v = search.get('v');
    const versioned = !isHtml && v !== null && v === assetHash(rel.slice(1));
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': versioned ? 'public, max-age=31536000, immutable' : 'no-cache',
      ...SECURITY_HEADERS,
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  });
}

function adminSession(req: http.IncomingMessage, id: string): S.Session {
  const s = S.sessions.get(id);
  if (!s) throw new HttpError(404, 'Session not found or expired');
  const token = String(req.headers['x-admin-token'] || '');
  if (!token || !safeEq(token, s.adminToken)) throw new HttpError(403, 'Admin token required');
  return s;
}

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/** Turn pasted text into queue items, loading key/summary/link/type/SP/estimate from Jira when configured.
 *  The original entered string (especially a URL) is kept verbatim and never rewritten. */
async function resolveQueue(text: unknown): Promise<Parameters<typeof S.addQueueItems>[1]> {
  const parsed = S.parseQueueText(text);
  const keys = parsed.filter((p) => p.key).map((p) => p.key!) ;
  const fetched = jiraEnabled() && keys.length ? await getIssues(keys) : [];
  const byKey = new Map<string, any>();
  keys.forEach((k, i) => byKey.set(k, fetched[i]));
  return parsed.map((p) => {
    const entered = p.entered;
    const enteredIsUrl = S.isHttpUrl(entered);
    const base = {
      key: p.key,
      title: p.title || p.key || entered || 'Untitled story',
      entered,
      url: enteredIsUrl ? entered : null as string | null,
      type: null as string | null, status: null as string | null, currentSP: null as number | null, currentEstimate: null as string | null,
      jiraError: null as string | null,
    };
    if (!p.key || !jiraEnabled()) return base;
    const r = byKey.get(p.key);
    if (r instanceof JiraError) {
      return { ...base, url: enteredIsUrl ? entered : `${config.jira.baseUrl}/browse/${p.key}`, jiraError: r.message };
    }
    if (!r) return { ...base, jiraError: 'Not found in Jira (or no permission)' };
    return {
      ...r,
      key: r.key,
      title: p.title || r.title,
      entered,
      // Keep the typed URL exactly; only fill a url from Jira when the user did not paste one.
      url: enteredIsUrl ? entered : r.url || null,
      jiraError: null,
    };
  });
}

// ---------------- HTTP ----------------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://localhost');
  const p = url.pathname;
  try {
    if (p === '/healthz') return send(res, 200, { ok: true, version: APP_VERSION, sessions: S.sessions.size });

    if (p === '/api/config' && req.method === 'GET') {
      return send(res, 200, {
        version: APP_VERSION,
        defaultSessionName: config.defaultSessionName,
        adminPasswordRequired: Boolean(config.adminPassword),
        defaultRate: config.defaultRate,
        hoursRoundingStep: config.hoursRoundingStep,
        jiraEnabled: jiraEnabled(),
        jiraWriteBack: jiraEnabled() && config.jira.writeBack,
        jiraUpdateDefaultMode: config.jira.updateDefaultMode,
        jiraRecalcRemaining: config.jira.recalcRemaining,
        jiraDefaultBoard: config.jira.defaultBoard,
        jiraDefaultBoardProject: config.jira.defaultBoardProject,
      });
    }

    if (p === '/api/prefill' && req.method === 'GET') {
      // Sanitize tickets passed in the /new link; optionally load more via JQL (needs the admin password when one is set).
      const { tickets, ignored, truncated } = S.sanitizeTickets(url.searchParams.getAll('tickets'));
      const out: any = { tickets, ignored, truncated, jql: null as string | null, jqlStatus: null as string | null, jqlError: null as string | null };
      const jql = (url.searchParams.get('jql') || '').trim().slice(0, 2000);
      if (jql) {
        out.jql = jql;
        const pw = String(req.headers['x-admin-password'] || '');
        if (!jiraEnabled()) out.jqlStatus = 'no_jira';
        else if (config.adminPassword && !safeEq(pw, config.adminPassword)) out.jqlStatus = 'needs_password';
        else {
          try {
            const issues = await searchIssues(jql, S.MAX_PREFILL_TICKETS);
            const merged = S.sanitizeTickets([...tickets, ...issues.map((i) => i.url)]);
            out.tickets = merged.tickets;
            out.truncated = out.truncated || merged.truncated;
            out.jqlStatus = 'loaded';
          } catch (e: any) {
            out.jqlStatus = 'error';
            out.jqlError = String(e?.message || e).slice(0, 200);
          }
        }
      }
      return send(res, 200, out);
    }

    if (p === '/api/sessions' && req.method === 'POST') {
      const body = await readJson(req);
      if (config.adminPassword && !safeEq(String(body.password || ''), config.adminPassword)) {
        throw new HttpError(401, 'Wrong admin password');
      }
      if (body.rate !== undefined && !S.isValidRate(body.rate)) {
        throw new HttpError(400, `Hours per story point must be a multiple of ${S.RATE_STEP} between ${S.RATE_MIN} and ${S.RATE_MAX}`);
      }
      const s = S.createSession(body);
      if (body.queueText) {
        try {
          S.addQueueItems(s, await resolveQueue(body.queueText));
        } catch (e: any) {
          console.error('[queue] initial load failed:', e?.message);
        }
      }
      console.log(`[session] created ${s.id} "${s.name}"`);
      return send(res, 201, { sessionId: s.id, adminToken: s.adminToken });
    }

    let m = p.match(/^\/api\/sessions\/([A-Za-z0-9_-]+)$/);
    if (m && req.method === 'GET') {
      const s = S.sessions.get(m[1]);
      if (!s) throw new HttpError(404, 'Session not found or expired');
      return send(res, 200, { id: s.id, name: s.name });
    }

    m = p.match(/^\/api\/sessions\/([A-Za-z0-9_-]+)\/jira\/search$/);
    if (m && req.method === 'POST') {
      const s = adminSession(req, m[1]);
      const body = await readJson(req);
      const jql = String(body.jql || '').trim().slice(0, 2000);
      if (!jql) throw new HttpError(400, 'JQL is required');
      const issues = await searchIssues(jql, 100);
      S.touch(s);
      return send(res, 200, { issues });
    }

    m = p.match(/^\/api\/sessions\/([A-Za-z0-9_-]+)\/queue$/);
    if (m && req.method === 'POST') {
      const s = adminSession(req, m[1]);
      const body = await readJson(req);
      const added = S.addQueueItems(s, await resolveQueue(body.text));
      if (body.startFirst && s.round.status !== 'voting') {
        const nx = S.nextPending(s);
        if (nx) S.selectQueueItem(s, nx.id, true);
      }
      S.touch(s);
      broadcast(s);
      return send(res, 200, { added: added.length, items: added });
    }

    // project picker: projects the Jira account can see (cached 5 min); admin only
    m = p.match(/^\/api\/sessions\/([A-Za-z0-9_-]+)\/jira\/projects$/);
    if (m && req.method === 'GET') {
      adminSession(req, m[1]);
      return send(res, 200, { projects: await listProjects() });
    }
    // board picker: boards by name (contains match), optional project filter; admin only
    m = p.match(/^\/api\/sessions\/([A-Za-z0-9_-]+)\/jira\/boards$/);
    if (m && req.method === 'GET') {
      adminSession(req, m[1]);
      const q = (url.searchParams.get('q') || '').trim();
      const project = (url.searchParams.has('project') ? url.searchParams.get('project') || '' : config.jira.defaultBoardProject).trim();
      return send(res, 200, { boards: await searchBoards(q, project) });
    }
    // configured default board (JIRA_DEFAULT_BOARD / JIRA_DEFAULT_BOARD_ID) resolved to {id, name, ...}; admin only
    m = p.match(/^\/api\/sessions\/([A-Za-z0-9_-]+)\/jira\/boards\/default$/);
    if (m && req.method === 'GET') {
      adminSession(req, m[1]);
      if (!config.jira.defaultBoard) return send(res, 200, { board: null, configured: false });
      const board = await resolveBoard(config.jira.defaultBoard, config.jira.defaultBoardProject);
      return send(res, 200, { board, configured: true });
    }

    m = p.match(/^\/api\/sessions\/([A-Za-z0-9_-]+)\/jira\/boards\/(\d+)\/sprints$/);
    if (m && req.method === 'GET') {
      adminSession(req, m[1]);
      return send(res, 200, { sprints: await boardSprints(m[2]) });
    }

    if (p === '/api/jira/status' && req.method === 'GET') return send(res, 200, await jiraStatusInfo());

    m = p.match(/^\/api\/sessions\/([A-Za-z0-9_-]+)\/jira\/update$/);
    if (m && req.method === 'POST') {
      const s = adminSession(req, m[1]); // admin token enforced server-side
      const body = await readJson(req).catch(() => ({}));
      if (!jiraEnabled()) throw new HttpError(503, 'Jira not configured: set JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN');
      const retryFailed = body?.retryFailed === true;
      const resend = body?.resend === true;
      const ids: string[] | null = Array.isArray(body?.ids) ? body.ids.filter((x: unknown) => typeof x === 'string').slice(0, 500) : null;
      const mode = body?.mode;
      if (!retryFailed && !['sp', 'time', 'both'].includes(mode)) throw new HttpError(400, 'mode must be sp, time or both');
      if (S.updatingSessions.has(s.id)) throw new HttpError(409, 'A Jira update is already running for this session');
      const fieldsFor = (m2: string): S.JiraFieldKey[] => (m2 === 'sp' ? ['sp'] : m2 === 'time' ? ['time'] : ['sp', 'time']);
      const todo: { e: S.HistoryEntry; fields: S.JiraFieldKey[] }[] = [];
      const skipped: { id: string; key: string | null; reason: string }[] = [];
      for (const e of s.history) {
        if (ids && !ids.includes(e.itemId)) continue;
        if (!e.key || !ISSUE_KEY_RE.test(e.key)) { skipped.push({ id: e.itemId, key: e.key, reason: 'not a Jira issue' }); continue; }
        if (e.finalSP === null || e.finalSP === undefined) { skipped.push({ id: e.itemId, key: e.key, reason: 'no agreed story points' }); continue; }
        const st = e.jira?.state ?? 'not_sent';
        if (retryFailed) {
          if (st !== 'failed') continue;
          todo.push({ e, fields: e.jira.fields.length ? e.jira.fields : fieldsFor('both') }); // same field choice as the failed attempt
        } else {
          if (st === 'updated' && !resend) { skipped.push({ id: e.itemId, key: e.key, reason: 'already updated' }); continue; }
          todo.push({ e, fields: fieldsFor(mode) });
        }
      }
      const results: { id: string; key: string | null; state: string; error: string | null }[] = [];
      S.updatingSessions.add(s.id);
      broadcast(s);
      try {
        let next = 0;
        const worker = async () => {
          while (next < todo.length) {
            const { e, fields } = todo[next++]!;
            const sp = e.finalSP as number;
            const hours = e.hours ?? ceilHours(sp, e.rate);
            try {
              await updateIssueFields(e.key!, { ...(fields.includes('sp') ? { sp } : {}), ...(fields.includes('time') ? { hours } : {}) });
              e.jira = { state: 'updated', at: Date.now(), fields, sp, hours, error: null };
              e.savedToJira = true;
              results.push({ id: e.itemId, key: e.key, state: 'updated', error: null });
              console.log(`[jira] updated ${e.key}: ${fields.join('+')}`);
            } catch (err: any) {
              const msg = String(err?.message || err).slice(0, 300);
              e.jira = { state: 'failed', at: Date.now(), fields, sp: null, hours: null, error: msg };
              results.push({ id: e.itemId, key: e.key, state: 'failed', error: msg });
              console.log(`[jira] update failed ${e.key}: ${msg}`);
            }
            S.touch(s);
            broadcast(s); // live status for every client
          }
        };
        await Promise.all(Array.from({ length: Math.min(JIRA_UPDATE_CONCURRENCY, todo.length) }, worker));
      } finally {
        S.updatingSessions.delete(s.id);
        S.touch(s);
        broadcast(s);
      }
      return send(res, 200, { ok: true, results, skipped, updated: results.filter((r) => r.state === 'updated').length, failed: results.filter((r) => r.state === 'failed').length });
    }

    m = p.match(/^\/api\/sessions\/([A-Za-z0-9_-]+)\/jira\/save$/);
    if (m && req.method === 'POST') {
      const s = adminSession(req, m[1]);
      const body = await readJson(req).catch(() => ({}));
      const itemId = typeof body?.itemId === 'string' && body.itemId ? String(body.itemId) : null;
      if (itemId) {
        const q = s.queue.find((x) => x.id === itemId);
        if (!q || q.state !== 'estimated') throw new HttpError(409, 'Ticket has no agreed result yet');
        if (!q.key || !ISSUE_KEY_RE.test(q.key)) throw new HttpError(400, 'This ticket is not a Jira issue');
        if (q.finalSP === null) throw new HttpError(400, 'Set the agreed story points first');
        const hours = q.hours ?? ceilHours(q.finalSP, q.rate ?? s.rate);
        const { fields } = await saveEstimate(q.key, q.finalSP, hours);
        q.savedToJira = true;
        q.currentSP = q.finalSP;
        if (config.jira.writeOriginalEstimate) q.currentEstimate = `${hours}h`;
        const match = [...s.history].reverse().find((e) => e.itemId === q.id) ?? [...s.history].reverse().find((e) => e.key === q.key);
        if (match) {
          match.savedToJira = true;
          match.jira = { state: 'updated', at: Date.now(), fields: config.jira.writeOriginalEstimate ? ['sp', 'time'] : ['sp'], sp: q.finalSP, hours, error: null };
        }
        console.log(`[jira] saved ${q.key}: ${q.finalSP} SP / ${hours}h`);
        S.touch(s);
        broadcast(s);
        return send(res, 200, { ok: true, key: q.key, storyPoints: q.finalSP, hours, fields });
      }
      const r = s.round;
      if (r.status !== 'revealed') throw new HttpError(409, 'Reveal the votes first');
      if (!r.story?.key || !ISSUE_KEY_RE.test(r.story.key)) throw new HttpError(400, 'Current story is not a Jira issue');
      if (r.finalSP === null) throw new HttpError(400, 'Set the agreed story points first');
      const hours = ceilHours(r.finalSP, s.rate);
      const roundId = r.id;
      const { fields } = await saveEstimate(r.story.key, r.finalSP, hours);
      if (s.round.id === roundId && s.round.story) {
        s.round.savedToJira = true;
        s.round.story.currentSP = r.finalSP;
        if (config.jira.writeOriginalEstimate) s.round.story.currentEstimate = jiraDuration(hours);
        const q = s.queue.find((x) => x.id === s.round.queueItemId);
        if (q) {
          q.savedToJira = true;
          q.currentSP = s.round.story.currentSP;
          q.currentEstimate = s.round.story.currentEstimate;
        }
      }
      console.log(`[jira] saved ${r.story.key}: ${r.finalSP} SP / ${hours}h`);
      S.touch(s);
      broadcast(s);
      return send(res, 200, { ok: true, key: r.story.key, storyPoints: r.finalSP, hours, fields });
    }

    if (p.startsWith('/api/')) throw new HttpError(404, 'Not found');
    if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res, p, url.searchParams);
    throw new HttpError(405, 'Method not allowed');
  } catch (e: any) {
    const status = e instanceof HttpError || e instanceof JiraError ? e.status : 400;
    if (!(e instanceof HttpError)) console.error('[http]', p, e?.message);
    return send(res, status >= 400 && status < 600 ? status : 500, { error: e?.message || 'Error' });
  }
});

// ---------------- WebSocket ----------------

interface Conn extends WebSocket {
  sessionId?: string;
  memberId?: string;
  alive?: boolean;
}

const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url || '/', 'http://localhost');
  if (url.pathname !== '/ws') return socket.destroy();
  const s = S.sessions.get(url.searchParams.get('session') || '');
  if (!s) {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    return socket.destroy();
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    (ws as Conn).sessionId = s.id;
    wss.emit('connection', ws, req);
  });
});

function sendWs(ws: WebSocket, msg: unknown) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function broadcast(s: S.Session) {
  const state = S.publicState(s);
  for (const m of s.members.values()) {
    const you: Record<string, unknown> = { id: m.id, name: m.name, isAdmin: m.isAdmin, voter: m.voter, voted: s.round.votes.has(m.id) };
    if (s.round.status === 'revealed') you.vote = s.round.votes.get(m.id) ?? null;
    const payload = JSON.stringify({ type: 'state', ...state, you });
    for (const ws of m.sockets) if (ws.readyState === WebSocket.OPEN) ws.send(payload);
  }
}

function scheduleGraceCheck(s: S.Session) {
  if (s.graceTimer) clearTimeout(s.graceTimer);
  s.graceTimer = setTimeout(() => {
    s.graceTimer = undefined;
    S.checkAutoReveal(s);
    broadcast(s);
  }, config.offlineGraceMs + 100);
}

function attach(ws: Conn, s: S.Session, m: S.Member) {
  if (ws.memberId && ws.memberId !== m.id) s.members.get(ws.memberId)?.sockets.delete(ws);
  ws.memberId = m.id;
  m.sockets.add(ws);
  m.offlineSince = null;
  S.touch(s);
  sendWs(ws, { type: 'welcome', you: { id: m.id, name: m.name, isAdmin: m.isAdmin, token: m.token } });
  broadcast(s);
}

const ADMIN_ACTIONS = new Set(['setStory', 'startVoting', 'reveal', 'revote', 'setFinal', 'finishTicket', 'next', 'setRate', 'setDeck', 'setVoter', 'kick', 'rename', 'queueSelect', 'queueMove', 'queueRemove', 'queueSkip', 'queueRestore', 'queueEdit', 'setQueueAgreed']);

wss.on('connection', (ws: Conn) => {
  ws.alive = true;
  ws.on('pong', () => (ws.alive = true));

  ws.on('message', (raw) => {
    const s = S.sessions.get(ws.sessionId || '');
    if (!s) return sendWs(ws, { type: 'error', code: 'no_session', message: 'Session not found or expired' });
    let msg: any;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (!msg || typeof msg.type !== 'string') return;

    if (msg.type === 'hello') {
      const m = S.findMemberByToken(s, String(msg.token || ''));
      if (!m) return sendWs(ws, { type: 'error', code: 'unknown_token', message: 'Please register again' });
      return attach(ws, s, m);
    }
    if (msg.type === 'register') {
      try {
        return attach(ws, s, S.registerMember(s, msg.name));
      } catch (e: any) {
        return sendWs(ws, { type: 'error', code: 'bad_name', message: e.message });
      }
    }

    const me = s.members.get(ws.memberId || '');
    if (!me) return sendWs(ws, { type: 'error', code: 'not_registered', message: 'Register first' });
    if (ADMIN_ACTIONS.has(msg.type) && !me.isAdmin) return sendWs(ws, { type: 'error', code: 'forbidden', message: 'Admin only' });

    switch (msg.type) {
      case 'vote':
        if (!S.castVote(s, me, msg.value)) return sendWs(ws, { type: 'error', code: 'vote_rejected', message: 'Voting is not open' });
        S.checkAutoReveal(s);
        break;
      case 'setStory':
        S.setStory(s, toStory(msg.story));
        break;
      case 'startVoting':
        S.startVoting(s, msg.story === undefined ? undefined : toStory(msg.story));
        break;
      case 'reveal':
        S.reveal(s, false);
        break;
      case 'revote':
        S.revote(s);
        break;
      case 'setFinal':
        S.setFinal(s, msg.sp);
        break;
      case 'finishTicket':
        if (msg.sp !== undefined) S.setFinal(s, msg.sp);
        S.nextStory(s);
        break;
      case 'setQueueAgreed':
        S.setQueueAgreed(s, String(msg.itemId || ''), msg.sp);
        break;
      case 'next':
        S.nextStory(s);
        break;
      case 'setRate':
        if (!S.isValidRate(msg.rate)) return sendWs(ws, { type: 'error', code: 'invalid_rate', message: `Hours per story point must be a multiple of ${S.RATE_STEP} between ${S.RATE_MIN} and ${S.RATE_MAX}` });
        s.rate = S.sanitizeRate(msg.rate, s.rate);
        break;
      case 'setDeck':
        if (s.round.status === 'voting') return sendWs(ws, { type: 'error', code: 'busy', message: 'Change the deck between rounds' });
        s.deck = S.sanitizeDeck(msg.deck);
        break;
      case 'setVoter': {
        const target = s.members.get(String(msg.memberId || me.id));
        if (target) target.voter = Boolean(msg.voter);
        if (target && !target.voter) s.round.votes.delete(target.id);
        S.checkAutoReveal(s);
        break;
      }
      case 'kick': {
        const target = s.members.get(String(msg.memberId || ''));
        if (target && !target.isAdmin) {
          s.round.votes.delete(target.id);
          s.members.delete(target.id);
          for (const sock of target.sockets) {
            sendWs(sock, { type: 'error', code: 'kicked', message: 'You were removed from the session' });
            sock.close();
          }
          S.checkAutoReveal(s);
        }
        break;
      }
      case 'queueSelect':
        S.selectQueueItem(s, String(msg.itemId || ''), msg.start !== false);
        break;
      case 'queueMove':
        S.moveQueueItem(s, String(msg.itemId || ''), Number(msg.toIndex));
        break;
      case 'queueRemove':
        S.removeQueueItem(s, String(msg.itemId || ''));
        break;
      case 'queueSkip':
        S.skipQueueItem(s, String(msg.itemId || ''));
        break;
      case 'queueRestore':
        S.unskipQueueItem(s, String(msg.itemId || ''));
        break;
      case 'queueEdit': {
        const q = s.queue.find((x) => x.id === String(msg.itemId || ''));
        const title = String(msg.title || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 300);
        if (q && title) {
          q.title = title;
          if (s.round.queueItemId === q.id && s.round.story) s.round.story.title = title;
        }
        break;
      }
      case 'rename':
        s.name = String(msg.name || '').trim().slice(0, 80) || s.name;
        break;
      default:
        return;
    }
    S.touch(s);
    broadcast(s);
  });

  ws.on('close', () => {
    const s = S.sessions.get(ws.sessionId || '');
    const m = s?.members.get(ws.memberId || '');
    if (!s || !m) return;
    m.sockets.delete(ws);
    if (m.sockets.size === 0) {
      m.offlineSince = Date.now();
      scheduleGraceCheck(s);
    }
    broadcast(s);
  });
});

function toStory(raw: any): S.Story | null {
  if (!raw || typeof raw !== 'object') return null;
  const key = typeof raw.key === 'string' && ISSUE_KEY_RE.test(raw.key.trim().toUpperCase()) ? raw.key.trim().toUpperCase() : null;
  const title = String(raw.title || '').trim().slice(0, 300) || key || 'Untitled story';
  const numOrNull = (v: any) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const strOrNull = (v: any, n = 60) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : null);
  const enteredRaw = typeof raw.entered === 'string' && raw.entered.trim() ? raw.entered.trim().slice(0, 2000) : null;
  const urlRaw = typeof raw.url === 'string' && raw.url.trim() ? raw.url.trim().slice(0, 2000) : null;
  const entered = enteredRaw || urlRaw || key;
  const enteredIsUrl = S.isHttpUrl(entered);
  return {
    key,
    title,
    entered,
    url: enteredIsUrl ? entered : urlRaw || (key && jiraEnabled() ? `${config.jira.baseUrl}/browse/${key}` : null),
    type: strOrNull(raw.type),
    status: strOrNull(raw.status),
    currentSP: numOrNull(raw.currentSP),
    currentEstimate: strOrNull(raw.currentEstimate, 30),
  };
}

// heartbeat + expiry
const heartbeat = setInterval(() => {
  for (const c of wss.clients as Set<Conn>) {
    if (!c.alive) {
      c.terminate();
      continue;
    }
    c.alive = false;
    c.ping();
  }
}, 30_000);

const sweeper = setInterval(() => {
  S.expireSessions((s) => {
    console.log(`[session] expired ${s.id}`);
    for (const m of s.members.values()) for (const ws of m.sockets) ws.close(4000, 'Session expired');
  });
}, 10 * 60_000);

S.loadSessions();
server.listen(config.port, config.host, () => {
  console.log(`Planning poker listening on http://${config.host}:${config.port}`);
  console.log(`  Jira: ${jiraEnabled() ? `${config.jira.baseUrl} (write-back ${config.jira.writeBack ? 'ON' : 'off'})` : 'not configured (manual titles only)'}`);
  if (jiraEnabled() && !config.adminPassword) console.warn('  WARNING: Jira is configured but ADMIN_PASSWORD is not set - anyone who can reach this server can start a session and query Jira.');
  console.log(`  UPDATE Jiras default mode: ${config.jira.updateDefaultMode}; recalc remaining estimate: ${config.jira.recalcRemaining ? 'on' : 'off'}`);
  if (config.jira.updateDefaultModeWarning) console.warn(`  WARNING: ${config.jira.updateDefaultModeWarning}`);
  if (config.dataFile) console.log(`  Persisting sessions to ${config.dataFile}`);
});

function shutdown() {
  clearInterval(heartbeat);
  clearInterval(sweeper);
  S.saveNow();
  server.close();
  for (const c of wss.clients) c.terminate();
  setTimeout(() => process.exit(0), 200).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
