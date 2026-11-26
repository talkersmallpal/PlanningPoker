import { config, jiraEnabled } from './config';
import { jiraDuration, remainingAfter } from './stats';

export class JiraError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export interface JiraIssue {
  key: string;
  title: string;
  url: string;
  type: string | null;
  status: string | null;
  currentSP: number | null;
  currentEstimate: string | null;
}

export const ISSUE_KEY_RE = /^[A-Z][A-Z0-9_]+-\d+$/;

const MAX_429_RETRIES = 3;

function authHeader(): string {
  return 'Basic ' + Buffer.from(`${config.jira.email}:${config.jira.apiToken}`).toString('base64');
}

async function jiraFetch(path: string, init: { method?: string; body?: unknown } = {}): Promise<any> {
  if (!jiraEnabled()) throw new JiraError(503, 'Jira is not configured on this server');
  let res: Response;
  let text = '';
  for (let attempt = 0; ; attempt++) {
    try {
      res = await fetch(config.jira.baseUrl + path, {
        method: init.method || 'GET',
        headers: {
          Authorization: authHeader(),
          Accept: 'application/json',
          ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
        signal: AbortSignal.timeout(config.jira.timeoutMs),
      });
    } catch (e: any) {
      throw new JiraError(502, `Could not reach Jira: ${e?.name === 'TimeoutError' ? 'timeout' : e?.message || e}`);
    }
    text = await res.text();
    // Rate limited: honour Retry-After (seconds, clamped to 0-30s), at most 3 retries.
    if (res.status === 429 && attempt < MAX_429_RETRIES) {
      const ra = Number(res.headers.get('retry-after'));
      const waitMs = Math.min(30, Math.max(0, Number.isFinite(ra) ? ra : 2 ** attempt)) * 1000;
      await new Promise((r) => setTimeout(r, waitMs));
      continue;
    }
    break;
  }
  if (!res.ok) {
    let msg = text.slice(0, 300);
    try {
      const j = JSON.parse(text);
      const parts = [...(j.errorMessages || []), ...Object.entries(j.errors || {}).map(([k, v]) => `${k}: ${v}`)];
      if (parts.length) msg = parts.join('; ');
    } catch {
      /* not JSON */
    }
    throw new JiraError(res.status, `Jira ${res.status}: ${msg || res.statusText}`);
  }
  return text ? JSON.parse(text) : null;
}

let spFieldCache: string | null = null;
const SP_NAMES = ['story points', 'story point estimate'];

export async function storyPointsField(): Promise<string> {
  if (config.jira.storyPointsField) return config.jira.storyPointsField;
  if (spFieldCache) return spFieldCache;
  const fields: { id: string; name: string }[] = await jiraFetch('/rest/api/3/field');
  for (const wanted of SP_NAMES) {
    const f = fields.find((x) => (x.name || '').trim().toLowerCase() === wanted);
    if (f) {
      spFieldCache = f.id;
      return f.id;
    }
  }
  throw new JiraError(500, 'Could not find a "Story Points" / "Story point estimate" field. Set JIRA_STORY_POINTS_FIELD.');
}

function toIssue(raw: any, spField: string): JiraIssue {
  const f = raw.fields || {};
  const sp = f[spField];
  return {
    key: raw.key,
    title: f.summary || raw.key,
    url: `${config.jira.baseUrl}/browse/${raw.key}`,
    type: f.issuetype?.name ?? null,
    status: f.status?.name ?? null,
    currentSP: typeof sp === 'number' ? sp : null,
    currentEstimate: f.timetracking?.originalEstimate ?? null,
  };
}

export async function searchIssues(jql: string, max = 100): Promise<JiraIssue[]> {
  const spField = await storyPointsField();
  const out: JiraIssue[] = [];
  let nextPageToken: string | undefined;
  do {
    const body: any = {
      jql,
      maxResults: Math.min(50, max - out.length),
      fields: ['summary', 'status', 'issuetype', 'timetracking', spField],
    };
    if (nextPageToken) body.nextPageToken = nextPageToken;
    const res = await jiraFetch('/rest/api/3/search/jql', { method: 'POST', body });
    for (const i of res?.issues || []) out.push(toIssue(i, spField));
    nextPageToken = res?.nextPageToken || undefined;
  } while (nextPageToken && out.length < max);
  return out;
}

export async function boardSprints(boardId: string): Promise<{ id: number; name: string; state: string }[]> {
  if (!/^\d+$/.test(boardId)) throw new JiraError(400, 'Board id must be numeric');
  let res: any;
  try {
    res = await jiraFetch(`/rest/agile/1.0/board/${boardId}/sprint?state=active,future&maxResults=50`);
  } catch (e) {
    // Kanban / simple boards have no sprints: Jira answers 400 ("The board does not support sprints")
    if (e instanceof JiraError && e.status === 400) throw new JiraError(400, 'This board has no sprints (only scrum boards have sprints). Pick a scrum board or use a JQL search.');
    throw e;
  }
  return (res?.values || []).map((s: any) => ({ id: s.id, name: s.name, state: s.state }));
}

export type JiraBoard = { id: number; name: string; type: string; projectKey: string | null; projectName: string | null; hasSprints: boolean };
export const MAX_BOARDS = 100;
export const PROJECT_RE = /^(?:[A-Za-z][A-Za-z0-9_]{0,49}|\d{1,12})$/;

function toBoard(b: any): JiraBoard {
  const type = String(b?.type || 'unknown').toLowerCase();
  return {
    id: Number(b.id),
    name: String(b.name || `Board ${b.id}`),
    type,
    projectKey: b?.location?.projectKey ?? null,
    projectName: b?.location?.projectName ?? b?.location?.displayName ?? null,
    hasSprints: type === 'scrum',
  };
}

/**
 * Boards whose name contains `q` (Jira's `name` filter, case-insensitive), optionally limited to one project.
 * Pages with startAt/isLast up to MAX_BOARDS. Scrum boards (the ones with sprints) come first, then by name.
 */
export async function searchBoards(q: string, project = '', max = MAX_BOARDS): Promise<JiraBoard[]> {
  const name = String(q || '').trim().slice(0, 100);
  const proj = String(project || '').trim();
  if (proj && !PROJECT_RE.test(proj)) throw new JiraError(400, 'Invalid project key');
  const out: JiraBoard[] = [];
  let startAt = 0;
  for (let page = 0; page < 10 && out.length < max; page++) {
    const qs = new URLSearchParams({ startAt: String(startAt), maxResults: '50' });
    if (name) qs.set('name', name);
    if (proj) qs.set('projectKeyOrId', proj);
    const res = await jiraFetch(`/rest/agile/1.0/board?${qs}`);
    const values: any[] = res?.values || [];
    for (const b of values) if (out.length < max) out.push(toBoard(b));
    if (res?.isLast !== false || !values.length) break;
    startAt += values.length;
  }
  return out.sort((a, b) => Number(b.hasSprints) - Number(a.hasSprints) || a.name.localeCompare(b.name));
}

export type JiraProject = { id: string; key: string; name: string };
export const MAX_PROJECTS = 500;
const PROJECT_CACHE_MS = 5 * 60_000;
let projectCache: { at: number; projects: JiraProject[] } | null = null;
/** Projects the Jira account can see (GET /rest/api/3/project/search, paged, max 500), ordered by key, cached for 5 minutes. */
export async function listProjects(): Promise<JiraProject[]> {
  if (projectCache && Date.now() - projectCache.at < PROJECT_CACHE_MS) return projectCache.projects;
  const out: JiraProject[] = [];
  let startAt = 0;
  for (let page = 0; page < 10 && out.length < MAX_PROJECTS; page++) {
    const qs = new URLSearchParams({ startAt: String(startAt), maxResults: '50', orderBy: 'key' });
    const res = await jiraFetch(`/rest/api/3/project/search?${qs}`);
    const values: any[] = res?.values || [];
    for (const p of values) if (out.length < MAX_PROJECTS && p?.key) out.push({ id: String(p.id), key: String(p.key), name: String(p.name || p.key) });
    if (res?.isLast !== false || !values.length) break;
    startAt += values.length;
  }
  projectCache = { at: Date.now(), projects: out };
  return out;
}
export function clearProjectCache(): void { projectCache = null; }

/**
 * Resolve a configured default board: a number is a board id; otherwise a name, preferring an exact
 * (case-insensitive) match, else the first board whose name contains it (scrum first). null if nothing matches.
 */
export async function resolveBoard(value: string, project = ''): Promise<JiraBoard | null> {
  const v = String(value || '').trim();
  if (!v) return null;
  if (/^\d+$/.test(v)) {
    try {
      return toBoard(await jiraFetch(`/rest/agile/1.0/board/${v}`));
    } catch (e) {
      if (e instanceof JiraError && (e.status === 404 || e.status === 400)) return null;
      throw e;
    }
  }
  const boards = await searchBoards(v, project);
  const lc = v.toLowerCase();
  return boards.find((b) => b.name.toLowerCase() === lc) || boards[0] || null;
}

/**
 * timetracking payload for a new estimate of `hours`. With JIRA_RECALC_REMAINING (default on) the issue's
 * timeSpentSeconds is read first and remainingEstimate = max(0, new original - time spent) is sent in the same edit,
 * because Jira does not recalculate the remaining estimate when the original estimate changes.
 */
export async function timetrackingFor(key: string, hours: number): Promise<{ originalEstimate: string; remainingEstimate?: string }> {
  const tt: { originalEstimate: string; remainingEstimate?: string } = { originalEstimate: jiraDuration(hours) };
  if (!config.jira.recalcRemaining) return tt;
  const raw = await jiraFetch(`/rest/api/3/issue/${encodeURIComponent(key)}?fields=timetracking`);
  tt.remainingEstimate = remainingAfter(hours, Number(raw?.fields?.timetracking?.timeSpentSeconds) || 0);
  return tt;
}

/** Write-back: story points + original estimate. Only callable when JIRA_WRITE_BACK=true. */
export async function saveEstimate(key: string, storyPoints: number, hours: number): Promise<{ fields: Record<string, unknown> }> {
  if (!config.jira.writeBack) throw new JiraError(403, 'Jira write-back is disabled (set JIRA_WRITE_BACK=true)');
  if (!ISSUE_KEY_RE.test(key)) throw new JiraError(400, 'Invalid issue key');
  const spField = await storyPointsField();
  const fields: Record<string, unknown> = { [spField]: storyPoints };
  if (config.jira.writeOriginalEstimate) fields.timetracking = await timetrackingFor(key, hours);
  await jiraFetch(`/rest/api/3/issue/${encodeURIComponent(key)}`, { method: 'PUT', body: { fields } });
  return { fields };
}

/** Fetch one issue by key. Returns null if it does not exist / is not visible. */
export async function getIssue(key: string): Promise<JiraIssue | null> {
  if (!ISSUE_KEY_RE.test(key)) return null;
  const spField = await storyPointsField();
  try {
    const raw = await jiraFetch(
      `/rest/api/3/issue/${encodeURIComponent(key)}?fields=${encodeURIComponent(['summary', 'status', 'issuetype', 'timetracking', spField].join(','))}`,
    );
    return toIssue(raw, spField);
  } catch (e) {
    if (e instanceof JiraError && e.status === 404) return null;
    throw e;
  }
}

/** Fetch many issues with limited concurrency, preserving order. */
export async function getIssues(keys: string[], concurrency = 5): Promise<(JiraIssue | null | JiraError)[]> {
  const out: (JiraIssue | null | JiraError)[] = new Array(keys.length);
  let next = 0;
  const worker = async () => {
    while (next < keys.length) {
      const i = next++;
      try {
        out[i] = await getIssue(keys[i]);
      } catch (e) {
        out[i] = e instanceof JiraError ? e : new JiraError(500, String(e));
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, keys.length) }, worker));
  return out;
}

/**
 * Manual batch update ("UPDATE Jiras"): writes the chosen fields for one issue.
 * Independent of JIRA_WRITE_BACK (that flag only controls the legacy per-ticket save buttons).
 */
export type JiraField = 'sp' | 'time';
export async function updateIssueFields(key: string, f: { sp?: number; hours?: number }): Promise<void> {
  if (!ISSUE_KEY_RE.test(key)) throw new JiraError(400, 'Invalid issue key');
  const fields: Record<string, unknown> = {};
  if (f.sp !== undefined) fields[await storyPointsField()] = f.sp;
  if (f.hours !== undefined) fields.timetracking = await timetrackingFor(key, f.hours);
  if (!Object.keys(fields).length) throw new JiraError(400, 'Nothing to update');
  await jiraFetch(`/rest/api/3/issue/${encodeURIComponent(key)}`, { method: 'PUT', body: { fields } });
}

/** Non-secret status for the UI. Never returns credentials. */
let spStatusCache: { at: number; value: { id: string | null; source: 'env' | 'auto' | 'unknown'; error?: string } } | null = null;
export async function jiraStatusInfo() {
  const configured = jiraEnabled();
  let sp: { id: string | null; source: 'env' | 'auto' | 'unknown'; error?: string } = { id: null, source: 'unknown' };
  if (configured) {
    if (config.jira.storyPointsField) sp = { id: config.jira.storyPointsField, source: 'env' };
    else if (spStatusCache && Date.now() - spStatusCache.at < (spStatusCache.value.id ? 3600_000 : 60_000)) sp = spStatusCache.value;
    else {
      try {
        sp = { id: await storyPointsField(), source: 'auto' };
      } catch (e: any) {
        sp = { id: null, source: 'unknown', error: String(e?.message || e).slice(0, 200) };
      }
      spStatusCache = { at: Date.now(), value: sp };
    }
  }
  return {
    configured,
    baseUrl: configured ? config.jira.baseUrl : null,
    storyPointsField: sp.id,
    storyPointsFieldSource: sp.source,
    storyPointsFieldError: sp.error ?? null,
    writePermission: 'unknown',
    legacyAutoWriteBack: configured && config.jira.writeBack,
  };
}
