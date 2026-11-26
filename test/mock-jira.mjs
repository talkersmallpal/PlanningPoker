// Tiny Jira Cloud mock: records every request so tests can assert request shapes.
import http from 'http';

export const SP_FIELD = 'customfield_10016';
const ISSUES = {
  'PROJ-100': { summary: 'MAP / new service feature', type: 'Epic', status: 'To Do', sp: null, est: null },
  'PROJ-123': { summary: 'Backend: new service support', type: 'Story', status: 'To Do', sp: 3, est: '1d' },
  'PROJ-124': { summary: 'Mobile app: new service support', type: 'Story', status: 'To Do', sp: null, est: null },
  'PROJ-125': { summary: 'Service release', type: 'Story', status: 'To Do', sp: null, est: null },
  'PROJ-126': { summary: 'Docs for the new service', type: 'Task', status: 'In Progress', sp: 1, est: '4h' },
};
// Agile boards: a few named ones plus 60 fillers so paging (50 per page) is exercised
export const BOARDS = [
  { id: 77, name: 'Team board', type: 'scrum', location: { projectKey: 'PROJ', projectName: 'Project' } },
  { id: 78, name: 'Team board kanban', type: 'kanban', location: { projectKey: 'PROJ', projectName: 'Project' } },
  { id: 79, name: 'Mobile team', type: 'scrum', location: { projectKey: 'MOB', projectName: 'Mobile' } },
  { id: 80, name: 'team', type: 'scrum', location: { projectKey: 'OPS', projectName: 'Ops' } },
  ...Array.from({ length: 60 }, (_, i) => ({ id: 1000 + i, name: `Filler board ${i}`, type: 'scrum', location: { projectKey: 'FILL', projectName: 'Filler' } })),
];
export const PROJECTS = [
  { id: '10000', key: 'PROJ', name: 'Project' },
  { id: '10001', key: 'MOB', name: 'Mobile' },
  { id: '10002', key: 'OPS', name: 'Ops' },
  { id: '10003', key: 'FILL', name: 'Filler' },
  ...Array.from({ length: 56 }, (_, i) => ({ id: String(11000 + i), key: `P${String(i).padStart(2, '0')}`, name: `Extra project ${i}` })),
];
const SPENT = new Map(); // key -> timeSpentSeconds (test control)
const raw = (key) => {
  const i = ISSUES[key];
  const tt = i.est ? { originalEstimate: i.est } : {};
  if (SPENT.get(key)) tt.timeSpentSeconds = SPENT.get(key);
  return {
    id: String(10000 + Number(key.split('-')[1])),
    key,
    fields: { summary: i.summary, issuetype: { name: i.type }, status: { name: i.status }, timetracking: tt, [SP_FIELD]: i.sp },
  };
};

export function startMockJira({ email, token }) {
  const requests = [];
  // test controls: fail = Map(key -> {status, body}); throttle = number of upcoming PUTs answered with 429; delay = ms per PUT
  const controls = { fail: new Map(), throttle: 0, delay: 0, inflight: 0, maxInflight: 0, spent: SPENT };
  const expectedAuth = 'Basic ' + Buffer.from(`${email}:${token}`).toString('base64');
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const url = new URL(req.url, 'http://x');
      const rec = { method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), auth: req.headers.authorization, contentType: req.headers['content-type'], body: body ? JSON.parse(body) : null };
      requests.push(rec);
      const json = (status, obj, extra = {}) => {
        res.writeHead(status, { 'Content-Type': 'application/json', ...extra });
        res.end(obj === undefined ? '' : JSON.stringify(obj));
      };
      if (rec.auth !== expectedAuth) return json(401, { errorMessages: ['Unauthorized'] });
      let m;
      if (req.method === 'GET' && url.pathname === '/rest/api/3/field') {
        return json(200, [
          { id: 'summary', name: 'Summary' },
          { id: 'customfield_10020', name: 'Sprint' },
          { id: SP_FIELD, name: 'Story Points' },
          { id: 'customfield_10026', name: 'Story point estimate' },
        ]);
      }
      if (req.method === 'POST' && url.pathname === '/rest/api/3/search/jql') {
        const keys = ['PROJ-123', 'PROJ-124', 'PROJ-125'];
        if (!rec.body.nextPageToken) return json(200, { issues: keys.slice(0, 2).map(raw), nextPageToken: 'page2', isLast: false });
        return json(200, { issues: keys.slice(2).map(raw), isLast: true });
      }
      if ((m = url.pathname.match(/^\/rest\/api\/3\/issue\/([A-Z0-9_]+-\d+)$/))) {
        if (!ISSUES[m[1]]) return json(404, { errorMessages: ['Issue does not exist or you do not have permission to see it.'] });
        if (req.method === 'GET') return json(200, raw(m[1]));
        if (req.method === 'PUT') {
          if (controls.throttle > 0) { controls.throttle--; return json(429, { errorMessages: ['Rate limited'] }, { 'Retry-After': '0' }); }
          const f = controls.fail.get(m[1]);
          if (f) return json(f.status, f.body);
          controls.inflight++; controls.maxInflight = Math.max(controls.maxInflight, controls.inflight);
          return setTimeout(() => { controls.inflight--; json(204); }, controls.delay);
        }
      }
      if (req.method === 'GET' && url.pathname === '/rest/api/3/project/search') {
        const startAt = Number(url.searchParams.get('startAt') || 0);
        const max = Math.min(50, Number(url.searchParams.get('maxResults') || 50));
        const all = [...PROJECTS].sort((a, b) => a.key.localeCompare(b.key));
        const values = all.slice(startAt, startAt + max);
        return json(200, { startAt, maxResults: max, total: all.length, isLast: startAt + values.length >= all.length, values });
      }
      if (req.method === 'GET' && url.pathname === '/rest/agile/1.0/board') {
        const name = (url.searchParams.get('name') || '').toLowerCase();
        const proj = url.searchParams.get('projectKeyOrId') || '';
        const startAt = Number(url.searchParams.get('startAt') || 0);
        const max = Math.min(50, Number(url.searchParams.get('maxResults') || 50));
        const all = BOARDS.filter((b) => (!name || b.name.toLowerCase().includes(name)) && (!proj || b.location.projectKey === proj));
        const values = all.slice(startAt, startAt + max);
        return json(200, { maxResults: max, startAt, total: all.length, isLast: startAt + values.length >= all.length, values });
      }
      if ((m = url.pathname.match(/^\/rest\/agile\/1\.0\/board\/(\d+)$/)) && req.method === 'GET') {
        const b = BOARDS.find((x) => x.id === Number(m[1]));
        return b ? json(200, b) : json(404, { errorMessages: ['Board does not exist or you do not have permission to see it.'] });
      }
      if ((m = url.pathname.match(/^\/rest\/agile\/1\.0\/board\/(\d+)\/sprint$/)) && req.method === 'GET') {
        const b = BOARDS.find((x) => x.id === Number(m[1]));
        if (b && b.type !== 'scrum') return json(400, { errorMessages: ['The board does not support sprints'] });
        return json(200, { values: [{ id: 501, name: 'Team Sprint 42', state: 'active' }, { id: 502, name: 'Team Sprint 43', state: 'future' }] });
      }
      json(404, { errorMessages: ['mock: no route'] });
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, requests, controls, url: `http://127.0.0.1:${server.address().port}` })));
}
