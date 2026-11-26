'use strict';
(() => {
  const $ = (s, el = document) => el.querySelector(s);
  const show = (el, on = true) => el.classList.toggle('hidden', !on);
  // board picker state (Load from Jira): label "Name (PROJ, scrum)" -> board
  const boardByLabel = new Map();
  let setDefaultProject = null; // set by bindRoom (project picker); used to prefill JIRA_DEFAULT_BOARD_PROJECT
  const boardLabel = (b) => `${b.name} (${b.projectKey || 'no project'}, ${b.type}${b.hasSprints ? '' : ', no sprints'})`;
  function h(tag, attrs = {}, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'text') el.textContent = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    return el;
  }
  const fmt = (n) => (n === null || n === undefined ? '–' : String(Math.round(n * 100) / 100));
  const fmtH = (n) => (n === null || n === undefined ? '–' : `${n}h`);
  // Same rule as the server (src/stats.ts): round UP to the next multiple of the configured step (default 0.5h).
  const hoursStep = () => (appConfig && appConfig.hoursRoundingStep > 0 ? appConfig.hoursRoundingStep : 0.5);
  const ceilHours = (sp, rate) => {
    const step = hoursStep();
    const units = Math.ceil(Math.round(((sp * rate) / step) * 1e6) / 1e6);
    return Math.round(units * step * 1e6) / 1e6;
  };
  const isHttpUrl = (s) => typeof s === 'string' && /^https?:\/\//i.test(s);
  /** Visible ticket label: show the entered URL verbatim as the link text; Jira title alongside, not instead. */
  function ticketLabel(item) {
    const entered = (item && (item.entered || (isHttpUrl(item.url) ? item.url : '') || item.key)) || '';
    const title = item && item.title;
    const key = item && item.key;
    const kids = [];
    if (isHttpUrl(entered)) {
      kids.push(h('a', { href: entered, target: '_blank', rel: 'noopener', class: 'ticket-url' }, entered));
      if (title && title !== key && title !== entered) kids.push(' ', title);
    } else if (entered || key) {
      const text = entered || key;
      const href = item.url && isHttpUrl(item.url) ? item.url : null;
      kids.push(href ? h('a', { href, target: '_blank', rel: 'noopener', class: 'ticket-url' }, text) : h('span', { class: 'qkey' }, text));
      if (title && title !== key && title !== text) kids.push(' ', title);
    } else if (title) kids.push(title);
    return kids;
  }
  function ticketText(item) {
    return (item && (item.entered || item.url || item.key || item.title)) || '';
  }
  const FIELD_LABEL = { sp: 'story points', time: 'time' };
  const fieldsText = (j) => (j && j.fields && j.fields.length ? j.fields.map((f) => FIELD_LABEL[f] || f).join(' + ') : '');
  const hasKey = (e) => Boolean(e && e.key && /^[A-Z][A-Z0-9_]+-\d+$/.test(e.key));
  function statusText(e) {
    if (!hasKey(e)) return 'Not a Jira issue';
    const j = e.jira || { state: 'not_sent' };
    const when = j.at ? new Date(j.at).toLocaleString() : '';
    if (j.state === 'updated') return `Updated ${when} (${fieldsText(j)})`;
    if (j.state === 'failed') return `Failed: ${j.error || 'unknown error'}`;
    if (j.state === 'changed') return `Changed since update (${when}, ${fieldsText(j)})`;
    return 'Not sent';
  }
  function statusCell(e) {
    if (!hasKey(e)) return h('td', { class: 'st-cell', title: 'Not a Jira issue' }, '–');
    const j = e.jira || { state: 'not_sent' };
    const cls = `st st-${j.state}`;
    const label = { not_sent: 'Not sent', updated: 'Updated', failed: 'Failed', changed: 'Changed since update' }[j.state] || j.state;
    const kids = [h('span', { class: cls }, label)];
    if (j.state === 'updated' || j.state === 'changed') kids.push(h('div', { class: 'muted small' }, `${new Date(j.at).toLocaleString()} · ${fieldsText(j)}`));
    return h('td', { class: 'st-cell', title: j.state === 'failed' ? j.error || 'Update failed' : statusText(e), 'data-state': j.state }, ...kids);
  }
  let toastTimer;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    show(t);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => show(t, false), 2800);
  }
  async function api(path, opts = {}) {
    const res = await fetch(path, {
      method: opts.method || 'GET',
      headers: { 'Content-Type': 'application/json', ...(opts.admin ? { 'X-Admin-Token': opts.admin } : {}) },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }
  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = h('textarea', {}, text);
      document.body.append(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
  }
  function showView(id) {
    for (const v of document.querySelectorAll('.view')) show(v, v.id === id);
  }
  function message(title, text) {
    $('#messageTitle').textContent = title;
    $('#messageText').textContent = text;
    showView('message');
  }

  let appConfig = {};
  const sessionMatch = location.pathname.match(/^\/s\/([A-Za-z0-9_-]+)/);

  // ---------------- Landing ----------------
  function initLanding() {
    showView('landing');
    const f = $('#createForm');
    f.rate.value = appConfig.defaultRate || 4;
    show($('#pwWrap'), appConfig.adminPasswordRequired);
    if (!appConfig.jiraEnabled) $('#queueHint').textContent = 'Jira is not connected on this server: paste ticket URLs or keys. URLs are shown exactly as entered. Use "KEY Title" per line to give a bare key a title.';
    $('#deckPreset').addEventListener('change', (e) => show($('#customDeckWrap'), e.target.value === 'custom'));
    initPrefill(f);
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = f.querySelector('button[type=submit]');
      btn.disabled = true;
      btn.textContent = f.queueText.value.trim() && appConfig.jiraEnabled ? 'Loading tickets from Jira…' : 'Starting…';
      show($('#createError'), false);
      const deckStr = f.deckPreset.value === 'custom' ? f.customDeck.value : f.deckPreset.value;
      try {
        const r = await api('/api/sessions', {
          method: 'POST',
          body: {
            name: f.name.value,
            adminName: f.adminName.value,
            adminVotes: f.adminVotes.checked,
            rate: Number(f.rate.value),
            deck: deckStr.split(',').map((x) => x.trim()).filter(Boolean),
            queueText: f.queueText.value,
            password: f.password.value,
          },
        });
        localStorage.setItem(`pp:${r.sessionId}`, JSON.stringify({ token: r.adminToken, admin: true }));
        location.href = `/s/${r.sessionId}`;
      } catch (err) {
        $('#createError').textContent = err.message;
        show($('#createError'));
        btn.disabled = false;
        btn.textContent = 'Start session';
      }
    });
  }

  // /new?tickets=a,b&jql=... -> prefill the ticket textarea (server sanitizes; everything is set as text)
  async function initPrefill(f) {
    if (location.pathname !== '/new') return;
    const qs = new URLSearchParams(location.search);
    if (!qs.has('tickets') && !qs.has('jql')) return;
    const notice = $('#prefillNotice');
    const say = (msg) => { notice.textContent = msg; show(notice, Boolean(msg)); };
    const load = async () => {
      const headers = f.password.value ? { 'X-Admin-Password': f.password.value } : {};
      const res = await fetch(`/api/prefill?${qs.toString()}`, { headers });
      const r = await res.json();
      f.queueText.value = r.tickets.join('\n');
      const parts = [`${r.tickets.length} ticket${r.tickets.length === 1 ? '' : 's'} loaded from the link.`];
      if (r.ignored.length) parts.push(`Ignored ${r.ignored.length} invalid entr${r.ignored.length === 1 ? 'y' : 'ies'}: ${r.ignored.slice(0, 5).join(', ')}${r.ignored.length > 5 ? ', …' : ''}.`);
      if (r.truncated) parts.push('Only the first 200 tickets were kept.');
      if (r.jqlStatus === 'needs_password') parts.push('Enter the admin password to also load the tickets from the Jira search (JQL).');
      if (r.jqlStatus === 'no_jira') parts.push('The link has a Jira search (JQL) but Jira is not connected on this server, so it was ignored.');
      if (r.jqlStatus === 'loaded') parts.push('Tickets from the Jira search (JQL) were added.');
      if (r.jqlStatus === 'error') parts.push(`Jira search failed: ${r.jqlError}`);
      say(parts.join(' '));
      return r;
    };
    try {
      const r = await load();
      if (r.jqlStatus === 'needs_password') f.password.addEventListener('change', () => load().catch(() => {}), { once: true });
    } catch { say('Could not read the tickets from the link.'); }
  }

  // ---------------- Session ----------------
  const sid = sessionMatch && sessionMatch[1];
  const storeKey = `pp:${sid}`;
  let stored = null;
  let ws = null;
  let state = null;
  let you = null;
  let retry = 0;
  let registered = false;
  let lastRoundId = null;
  let lastStatus = null;
  let jqlIssues = [];

  const loadStored = () => {
    try { return JSON.parse(localStorage.getItem(storeKey) || 'null'); } catch { return null; }
  };
  const myVoteKey = () => `pp:vote:${sid}:${state && state.round.id}`;
  const wsSend = (msg) => ws && ws.readyState === 1 && ws.send(JSON.stringify(msg));
  const adminToken = () => (stored && stored.admin ? stored.token : null);

  async function initSession() {
    try {
      const info = await api(`/api/sessions/${sid}`);
      $('#joinName').textContent = info.name;
      $('#sessionName').textContent = info.name;
    } catch {
      return message('Session not found', 'This session does not exist or has expired (sessions expire after 24 hours of inactivity).');
    }
    stored = loadStored();
    connect();
    $('#registerForm').addEventListener('submit', (e) => {
      e.preventDefault();
      const name = e.target.name.value.trim();
      if (!name) return;
      wsSend({ type: 'register', name });
    });
    bindRoom();
  }

  function connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/ws?session=${encodeURIComponent(sid)}`);
    ws.onopen = () => {
      retry = 0;
      $('#conn').classList.remove('off');
      if (stored && stored.token) wsSend({ type: 'hello', token: stored.token });
      else showView('register');
    };
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.type === 'welcome') {
        registered = true;
        stored = { token: msg.you.token, admin: msg.you.isAdmin };
        localStorage.setItem(storeKey, JSON.stringify(stored));
        showView('room');
      } else if (msg.type === 'state') {
        state = msg;
        you = msg.you;
        render();
      } else if (msg.type === 'error') {
        if (msg.code === 'unknown_token') {
          localStorage.removeItem(storeKey);
          stored = null;
          showView('register');
        } else if (msg.code === 'kicked') {
          localStorage.removeItem(storeKey);
          stored = null;
          message('Removed', 'The facilitator removed you from this session.');
          ws.onclose = null;
        } else if (msg.code === 'no_session') {
          message('Session expired', msg.message);
        } else if (msg.code === 'bad_name') {
          $('#registerError').textContent = msg.message;
          show($('#registerError'));
        } else toast(msg.message);
      }
    };
    ws.onclose = (ev) => {
      $('#conn').classList.add('off');
      if (ev.code === 4000) return message('Session expired', 'This session has expired.');
      retry = Math.min(retry + 1, 6);
      setTimeout(connect, 500 * 2 ** retry);
    };
  }

  function previewAgreed(raw) {
    const empty = raw === '' || raw === null || raw === undefined;
    const sp = empty ? null : Number(raw);
    const valid = !empty && Number.isFinite(sp) && sp >= 0;
    const hours = valid ? ceilHours(sp, state.session.rate) : null;
    $('#agreedHoursPreview').textContent = hours === null ? '' : `= ${hours}h`;
    $('#stFinal').textContent = valid ? fmt(sp) : '–';
    $('#stFinalH').textContent = fmtH(hours);
    return { sp: valid ? sp : (empty ? null : undefined), hours };
  }

  function bindRoom() {
    bindJiraUpdate();
    $('#shareBtn').addEventListener('click', async () => {
      await copyText(`${location.origin}/s/${sid}`);
      toast('Invite link copied');
    });
    $('#startBtn').addEventListener('click', () => {
      const nx = state.queue.find((q) => q.state === 'pending');
      if (!state.round.story && nx) wsSend({ type: 'queueSelect', itemId: nx.id });
      else wsSend({ type: 'startVoting' });
    });
    $('#revealBtn').addEventListener('click', () => wsSend({ type: 'reveal' }));
    $('#revoteBtn').addEventListener('click', () => wsSend({ type: 'revote' }));
    const agreedFromInput = () => {
      const raw = $('#finalInput').value;
      return raw === '' ? undefined : Number(raw);
    };
    const finishTicket = () => {
      const sp = agreedFromInput();
      wsSend({ type: 'finishTicket', ...(sp !== undefined && Number.isFinite(sp) ? { sp } : {}) });
    };
    $('#nextBtn').addEventListener('click', finishTicket);
    $('#confirmNextBtn').addEventListener('click', finishTicket);
    $('#skipBtn').addEventListener('click', () => state.round.queueItemId && wsSend({ type: 'queueSkip', itemId: state.round.queueItemId }));
    const onAgreedInput = (e) => {
      const raw = e.target.value;
      const { sp } = previewAgreed(raw);
      if (sp !== undefined) wsSend({ type: 'setFinal', sp });
    };
    $('#finalInput').addEventListener('input', onAgreedInput);
    $('#finalInput').addEventListener('change', onAgreedInput);
    $('#finalInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); finishTicket(); } });
    $('#saveJiraBtn').addEventListener('click', async () => {
      const btn = $('#saveJiraBtn');
      btn.disabled = true;
      $('#saveJiraMsg').textContent = 'Saving…';
      try {
        const r = await api(`/api/sessions/${sid}/jira/save`, { method: 'POST', admin: adminToken(), body: {} });
        $('#saveJiraMsg').textContent = `Saved ${r.storyPoints} SP / ${r.hours}h to ${r.key}`;
      } catch (err) {
        $('#saveJiraMsg').textContent = err.message;
      } finally {
        btn.disabled = false;
      }
    });
    $('#copyCsvBtn').addEventListener('click', async () => {
      await copyText(historyCsv());
      toast('History copied as CSV');
    });
    $('#downloadCsvBtn').addEventListener('click', () => {
      const a = h('a', { href: URL.createObjectURL(new Blob([historyCsv()], { type: 'text/csv' })), download: `planning-poker-${sid}.csv` });
      document.body.append(a);
      a.click();
      a.remove();
    });
    $('#saveSettingsBtn').addEventListener('click', () => {
      const rateEl = $('#rateInput');
      const rate = Number(rateEl.value);
      if (!rateEl.checkValidity() || !(rate >= 0.5 && rate <= 100 && Number.isInteger(rate * 2))) {
        rateEl.value = state.session.rate;
        toast('Hours per story point must be a multiple of 0.5 between 0.5 and 100');
        return;
      }
      if (rate !== state.session.rate) wsSend({ type: 'setRate', rate });
      const deck = $('#deckInput').value.split(',').map((x) => x.trim()).filter(Boolean);
      if (deck.join(',') !== state.session.deck.join(',')) wsSend({ type: 'setDeck', deck });
      toast('Settings applied');
    });
    $('#adminVoterToggle').addEventListener('change', (e) => wsSend({ type: 'setVoter', voter: e.target.checked }));

    $('#queueForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const text = e.target.text.value;
      if (!text.trim()) return;
      $('#queueMsg').textContent = state.jira.enabled ? 'Loading from Jira…' : 'Adding…';
      try {
        const r = await api(`/api/sessions/${sid}/queue`, { method: 'POST', admin: adminToken(), body: { text } });
        $('#queueMsg').textContent = `Added ${r.added}`;
        e.target.text.value = '';
      } catch (err) {
        $('#queueMsg').textContent = err.message;
      }
    });
    $('#jqlForm').addEventListener('submit', (e) => {
      e.preventDefault();
      runJql(e.target.jql.value);
    });
    // ---- project + board pickers: comboboxes whose dropdown opens on focus/click and filters while typing ----
    const bf = $('#boardForm');
    // generic keyboard-friendly combobox (input[role=combobox] + ul[role=listbox])
    function makeCombo({ input, menu, idPrefix, load, label, matches, isPicked, onChoose, muted }) {
      let items = [];
      let shown = [];
      let active = -1;
      const isOpen = () => !menu.classList.contains('hidden');
      const close = () => { show(menu, false); input.setAttribute('aria-expanded', 'false'); input.removeAttribute('aria-activedescendant'); active = -1; };
      const setActive = (i) => {
        active = shown.length ? (i + shown.length) % shown.length : -1;
        menu.querySelectorAll('[role=option]').forEach((el, j) => el.classList.toggle('active', j === active));
        const el = menu.querySelector(`#${idPrefix}${active}`);
        if (el) { input.setAttribute('aria-activedescendant', el.id); el.scrollIntoView({ block: 'nearest' }); }
      };
      const render = (list, note) => {
        if (list) items = list;
        const text = input.value.trim().toLowerCase();
        // a picked value shows the whole list again; otherwise filter
        shown = text && !isPicked(input.value.trim()) ? items.filter((it) => matches(it, text)) : items.slice();
        menu.replaceChildren(
          ...shown.map((it, i) => h('li', { id: `${idPrefix}${i}`, role: 'option', class: 'combo-opt' + (muted && muted(it) ? ' muted' : ''), 'data-i': String(i) }, label(it))),
          ...(shown.length ? [] : [h('li', { class: 'combo-empty muted' }, note || 'No matches')]),
        );
        show(menu, true);
        input.setAttribute('aria-expanded', 'true');
        setActive(shown.findIndex((it) => label(it) === input.value.trim()));
      };
      const open = async () => {
        if (!isOpen()) render([], 'Loading…');
        try {
          const list = await load();
          if (document.activeElement === input || isOpen()) render(list);
        } catch (err) { render([], err.message); }
      };
      const choose = (it) => { input.value = label(it); close(); onChoose(it); };
      input.addEventListener('focus', open);
      input.addEventListener('click', () => { if (!isOpen()) open(); });
      input.addEventListener('blur', () => setTimeout(close, 150));
      input.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          if (!isOpen()) { open(); return; }
          setActive(active + (e.key === 'ArrowDown' ? 1 : -1));
        } else if (e.key === 'Enter' && isOpen() && active >= 0 && shown[active]) {
          e.preventDefault();
          choose(shown[active]);
        } else if (e.key === 'Escape' && isOpen()) {
          e.preventDefault();
          close();
        } else if (e.key === 'Tab') close();
      });
      // mousedown (not click) so the choice lands before the input's blur closes the menu
      menu.addEventListener('mousedown', (e) => {
        const li = e.target.closest('[role=option]');
        if (!li) return;
        e.preventDefault();
        choose(shown[Number(li.dataset.i)]);
      });
      return { open, close, render, isOpen, items: () => items };
    }

    // ---- projects ----
    let projectKey = '';
    const ALL_PROJECTS = { key: '', name: 'All projects', all: true };
    const projectLabel = (p) => (p.all ? 'All projects' : `${p.key} - ${p.name}`);
    let projectsPromise = null;
    const loadProjects = () => {
      if (!projectsPromise) {
        projectsPromise = api(`/api/sessions/${sid}/jira/projects`, { admin: adminToken() })
          .then((r) => [ALL_PROJECTS, ...r.projects])
          .catch((err) => { projectsPromise = null; throw err; });
      }
      return projectsPromise;
    };
    // turn what is in the Project box into a key: a picked label, "All projects"/empty, a key or name, else the text as a key
    function resolveProjectKey(text) {
      const t = text.trim();
      if (!t || t.toLowerCase() === 'all projects') return '';
      const list = projectCombo.items();
      const lc = t.toLowerCase();
      const hit = list.find((p) => !p.all && (projectLabel(p).toLowerCase() === lc || p.key.toLowerCase() === lc || p.name.toLowerCase() === lc));
      if (hit) return hit.key;
      const m = t.match(/^([A-Za-z][A-Za-z0-9_]*)\s+-\s+/);
      return (m ? m[1] : t).toUpperCase();
    }
    function showProject(key) {
      const p = projectCombo.items().find((x) => !x.all && x.key === key);
      bf.project.value = key ? (p ? projectLabel(p) : key) : '';
    }
    const projectCombo = makeCombo({
      input: bf.project, menu: $('#projectMenu'), idPrefix: 'projectOpt',
      load: loadProjects, label: projectLabel,
      matches: (p, t) => p.all || p.key.toLowerCase().includes(t) || p.name.toLowerCase().includes(t),
      isPicked: (t) => projectCombo.items().some((p) => projectLabel(p) === t),
      onChoose: (p) => { if (p.all) bf.project.value = ''; setProject(p.key); },
    });
    bf.project.addEventListener('change', () => setProject(resolveProjectKey(bf.project.value), true));

    // ---- boards (of the selected project; empty project = all projects) ----
    let boardCache = { project: null, boards: [], capped: false, loading: null };
    const rememberBoards = (boards) => { for (const b of boards) boardByLabel.set(boardLabel(b), b); };
    async function fetchBoards(q) {
      const qs = new URLSearchParams({ q, project: projectKey });
      const r = await api(`/api/sessions/${sid}/jira/boards?${qs}`, { admin: adminToken() });
      rememberBoards(r.boards);
      return r.boards;
    }
    function loadAllBoards() {
      const project = projectKey;
      if (boardCache.project === project && (boardCache.boards.length || boardCache.loading)) return boardCache.loading || Promise.resolve(boardCache.boards);
      boardCache = { project, boards: [], capped: false, loading: null };
      boardCache.loading = fetchBoards('').then((boards) => {
        if (boardCache.project === project) Object.assign(boardCache, { boards, capped: boards.length >= 100, loading: null });
        return boards;
      }).catch((err) => { boardCache.loading = null; throw err; });
      return boardCache.loading;
    }
    const boardCombo = makeCombo({
      input: bf.board, menu: $('#boardMenu'), idPrefix: 'boardOpt',
      load: loadAllBoards, label: boardLabel,
      matches: (b, t) => b.name.toLowerCase().includes(t),
      isPicked: (t) => boardByLabel.has(t),
      muted: (b) => !b.hasSprints,
      onChoose: (b) => loadSprints(b),
    });
    let boardTimer = null;
    bf.board.addEventListener('input', () => {
      clearTimeout(boardTimer);
      const v = bf.board.value.trim();
      boardCombo.render(boardCache.boards);
      // the cached list is capped at 100 boards: ask Jira by name for anything beyond it
      if (boardCache.capped && v.length >= 2 && !boardByLabel.has(v)) {
        boardTimer = setTimeout(() => fetchBoards(v).then((b) => { if (bf.board.value.trim() === v) boardCombo.render(b); }).catch((err) => { $('#jqlMsg').textContent = err.message; }), 300);
      }
    });
    bf.project.addEventListener('input', () => projectCombo.render());

    // switching the project reloads the board list and clears a board of another project
    function setProject(key, typed = false) {
      key = (key || '').trim().toUpperCase();
      if (typed || document.activeElement !== bf.project) showProject(key);
      if (key === projectKey && boardCache.project === key) return;
      projectKey = key;
      const cur = boardByLabel.get(bf.board.value.trim());
      if (cur && key && (cur.projectKey || '').toUpperCase() !== key) {
        bf.board.value = '';
        show($('#sprintSelect'), false);
      }
      loadAllBoards().then((b) => { $('#jqlMsg').textContent = `${b.length} board(s) in ${key || 'all projects'}`; if (boardCombo.isOpen()) boardCombo.render(b); }).catch((err) => { $('#jqlMsg').textContent = err.message; });
    }
    // preload both lists once the panel is opened, so the dropdowns are instant
    $('#jqlBox').addEventListener('toggle', () => {
      if (!$('#jqlBox').open) return;
      loadProjects().then((list) => { projectCombo.render(list); projectCombo.close(); if (document.activeElement !== bf.project) showProject(projectKey); }).catch(() => {});
      loadAllBoards().catch(() => {});
    });
    // resolve what is typed: a picked label, a board id, or a name (exact match preferred, else first match)
    async function pickBoard(text) {
      if (boardByLabel.has(text)) return boardByLabel.get(text);
      if (/^\d+$/.test(text)) return { id: Number(text), name: 'Board ' + text, type: 'unknown', hasSprints: true };
      const boards = await fetchBoards(text);
      return boards.find((b) => b.name.toLowerCase() === text.toLowerCase()) || boards[0] || null;
    }
    async function loadSprints(b) {
      if (!b.hasSprints) { $('#jqlMsg').textContent = `${b.name} is a ${b.type} board and has no sprints. Pick a scrum board or use a JQL search.`; show($('#sprintSelect'), false); return; }
      $('#jqlMsg').textContent = 'Loading sprints…';
      try {
        const r = await api(`/api/sessions/${sid}/jira/boards/${encodeURIComponent(b.id)}/sprints`, { admin: adminToken() });
        const sel = $('#sprintSelect');
        sel.replaceChildren(h('option', { value: '' }, 'Choose sprint…'), ...r.sprints.map((s) => h('option', { value: s.id }, `${s.name} (${s.state})`)));
        show(sel);
        $('#jqlMsg').textContent = `${r.sprints.length} sprint(s) on ${b.name}`;
      } catch (err) {
        $('#jqlMsg').textContent = err.message;
      }
    }
    bf.addEventListener('submit', async (e) => {
      e.preventDefault();
      boardCombo.close();
      const text = bf.board.value.trim();
      if (!text) { boardCombo.open(); return; }
      try {
        const b = await pickBoard(text);
        if (!b) { $('#jqlMsg').textContent = `No board matches "${text}"`; return; }
        if (boardByLabel.has(boardLabel(b))) bf.board.value = boardLabel(b);
        await loadSprints(b);
      } catch (err) {
        $('#jqlMsg').textContent = err.message;
      }
    });
    // used by the render code to prefill the defaults (JIRA_DEFAULT_BOARD_PROJECT / JIRA_DEFAULT_BOARD)
    setDefaultProject = (key) => setProject(key, true);
    $('#sprintSelect').addEventListener('change', (e) => {
      if (!e.target.value) return;
      const jql = `sprint = ${e.target.value} ORDER BY rank`;
      $('#jqlForm').jql.value = jql;
      runJql(jql);
    });
    $('#addSelectedBtn').addEventListener('click', async () => {
      const keys = [...document.querySelectorAll('#jqlResults input:checked')].map((i) => i.value);
      if (!keys.length) return;
      $('#jqlMsg').textContent = 'Adding…';
      try {
        const r = await api(`/api/sessions/${sid}/queue`, { method: 'POST', admin: adminToken(), body: { text: keys.join(',') } });
        $('#jqlMsg').textContent = `Added ${r.added}`;
      } catch (err) {
        $('#jqlMsg').textContent = err.message;
      }
    });
  }

  async function runJql(jql) {
    if (!jql.trim()) return;
    $('#jqlMsg').textContent = 'Searching…';
    try {
      const r = await api(`/api/sessions/${sid}/jira/search`, { method: 'POST', admin: adminToken(), body: { jql } });
      jqlIssues = r.issues;
      const inQueue = new Set(state.queue.map((q) => q.key));
      $('#jqlResults').replaceChildren(
        ...jqlIssues.map((i) =>
          h('label', {}, h('input', { type: 'checkbox', value: i.key, checked: !inQueue.has(i.key), disabled: inQueue.has(i.key) }),
            h('span', {}, h('b', {}, i.key), ` ${i.title}`, h('span', { class: 'muted' }, ` · ${i.status || ''}${i.currentSP !== null ? ` · ${i.currentSP} SP` : ''}`))),
        ),
      );
      show($('#addSelectedBtn'), jqlIssues.length > 0);
      $('#jqlMsg').textContent = `${jqlIssues.length} issue(s)`;
    } catch (err) {
      $('#jqlMsg').textContent = err.message;
    }
  }

  function historyCsv() {
    const esc = (v) => {
      const s = v === null || v === undefined ? '' : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const rows = [['URL', 'Issue key', 'Title', 'Agreed SP', 'Hours', 'Rate (h/SP)', 'Status']];
    for (const e of state.history) rows.push([ticketText(e), e.key || '', e.title, e.finalSP, e.hours, e.rate, statusText(e)]);
    const t = state.totals;
    if (t && t.tickets) rows.push(['SESSION TOTAL', '', '', t.agreedSP, t.hours, '', '']);
    return rows.map((r) => r.map(esc).join(',')).join('\n');
  }

  // ---------------- Render ----------------
  // ---------- UPDATE Jiras (admin only) ----------
  let jiraInfo = null;
  let jiraInfoRequested = false;
  const MODE_LABEL = { sp: 'story points', time: 'time', both: 'story points + time' };
  function renderJiraUpdate(isAdmin, jira, history) {
    show($('#jiraUpdateBox'), isAdmin);
    if (!isAdmin) return;
    const eligible = history.filter((e) => hasKey(e) && e.finalSP !== null && e.finalSP !== undefined);
    const failed = eligible.filter((e) => e.jira && e.jira.state === 'failed');
    const busy = Boolean(state.jiraBusy);
    const btn = $('#jiraUpdateBtn');
    const configured = Boolean(jira.enabled);
    btn.disabled = !configured || busy || eligible.length === 0;
    btn.textContent = busy ? 'Updating…' : 'UPDATE Jiras';
    $('#jiraMode').disabled = !configured || busy;
    show($('#jiraRetryBtn'), failed.length > 0);
    $('#jiraRetryBtn').disabled = busy || !configured;
    $('#jiraRetryBtn').textContent = `Retry failed (${failed.length})`;
    $('#jiraHint').textContent = !configured ? 'Jira not configured: set JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN' : eligible.length === 0 ? 'No finished Jira tickets to update yet.' : '';
    if (configured && !jiraInfoRequested) {
      jiraInfoRequested = true;
      fetch('/api/jira/status').then((r) => r.json()).then((i) => {
        jiraInfo = i;
        $('#jiraFieldInfo').textContent = `Story points field: ${i.storyPointsField ? `${i.storyPointsField} (${i.storyPointsFieldSource === 'env' ? 'configured' : 'auto-detected'})` : 'not found - set JIRA_STORY_POINTS_FIELD'} · write permission: ${i.writePermission} until the first update`;
      }).catch(() => {});
    }
  }
  function openConfirm({ mode, history }) {
    const modal = $('#confirmModal');
    const list = $('#confirmList');
    const resendBox = $('#resendBox');
    resendBox.checked = false;
    const candidates = () => history.filter((e) => hasKey(e) && e.finalSP !== null && e.finalSP !== undefined && (resendBox.checked || !(e.jira && e.jira.state === 'updated')));
    const alreadyUpdated = history.filter((e) => hasKey(e) && e.finalSP !== null && e.jira && e.jira.state === 'updated').length;
    const refresh = () => {
      const c = candidates();
      $('#confirmTitle').textContent = `Update ${c.length} ticket${c.length === 1 ? '' : 's'}: ${MODE_LABEL[mode]}`;
      list.replaceChildren(...c.map((e) => h('li', {}, h('b', {}, e.key), ` ${fmt(e.finalSP)} SP · ${fmtH(e.hours)}`, e.jira && e.jira.state === 'updated' ? h('span', { class: 'muted small' }, ' (re-send)') : null)));
      if (!c.length) list.replaceChildren(h('li', { class: 'muted' }, 'Nothing to update.'));
      $('#confirmOk').disabled = c.length === 0;
    };
    show($('#resendWrap'), alreadyUpdated > 0);
    $('#resendLabel').textContent = `Re-send already updated (${alreadyUpdated})`;
    resendBox.onchange = refresh;
    refresh();
    show(modal);
    return new Promise((resolve) => {
      const done = (v) => { show(modal, false); $('#confirmOk').onclick = null; $('#confirmCancel').onclick = null; resolve(v); };
      $('#confirmCancel').onclick = () => done(null);
      $('#confirmOk').onclick = () => done({ ids: candidates().map((e) => e.itemId), resend: resendBox.checked });
    });
  }
  async function runJiraUpdate(body, label) {
    try {
      const r = await api(`/api/sessions/${sid}/jira/update`, { method: 'POST', admin: adminToken(), body });
      toast(`${label}: ${r.updated} updated${r.failed ? `, ${r.failed} failed (hover Status for details)` : ''}${r.skipped.length ? `, ${r.skipped.length} skipped` : ''}`);
    } catch (err) {
      toast(err.message);
    }
  }
  function bindJiraUpdate() {
    $('#jiraUpdateBtn').addEventListener('click', async () => {
      const mode = $('#jiraMode').value;
      const choice = await openConfirm({ mode, history: state.history });
      if (!choice) return;
      await runJiraUpdate({ mode, ids: choice.ids, resend: choice.resend }, 'Jira update');
    });
    $('#jiraRetryBtn').addEventListener('click', () => runJiraUpdate({ retryFailed: true }, 'Retry'));
  }

  function render() {
    if (!state || !you) return;
    if (registered) showView('room');
    const { session, round, participants, queue, history, jira } = state;
    const isAdmin = you.isAdmin;
    document.title = `${session.name} · Planning Poker`;
    $('#sessionName').textContent = session.name;
    $('#ratePill').textContent = `${session.rate} h / SP`;
    show($('#ratePill'));
    show($('#conn'));
    show($('#shareBtn'));

    // reset local selection when the round changes
    if (round.id !== lastRoundId) {
      lastRoundId = round.id;
      $('#saveJiraMsg').textContent = '';
    }
    if (!you.voted) localStorage.removeItem(myVoteKey());
    if (lastStatus === 'voting' && round.status === 'revealed') toast(round.autoRevealed ? 'Everybody voted – cards revealed!' : 'Cards revealed');
    lastStatus = round.status;

    // story
    const st = round.story;
    const badge = $('#roundStatus');
    badge.className = `badge ${round.status}`;
    badge.textContent = { idle: 'Waiting', voting: 'Voting', revealed: 'Revealed' }[round.status];
    $('#storyMeta').textContent = st && st.type ? `${st.type}${st.status ? ' · ' + st.status : ''}` : '';
    const title = $('#storyTitle');
    title.replaceChildren();
    if (st) title.append(...ticketLabel(st));
    else title.append(h('span', { class: 'muted' }, isAdmin ? 'Pick a ticket from the queue or just start voting' : 'No story selected yet'));
    const facts = $('#storyFacts');
    facts.replaceChildren();
    if (st && (st.currentSP !== null || st.currentEstimate)) {
      facts.append(h('span', { class: 'fact' }, `Current SP: ${st.currentSP ?? '–'}`), h('span', { class: 'fact' }, `Original estimate: ${st.currentEstimate || '–'}`));
    }

    // admin bar
    show($('#adminBar'), isAdmin);
    if (isAdmin) {
      $('#startBtn').disabled = round.status === 'voting';
      $('#startBtn').textContent = round.status === 'revealed' ? 'Start new vote' : 'Start voting';
      show($('#startBtn'), round.status !== 'revealed');
      $('#revealBtn').disabled = round.status !== 'voting' || round.votedCount === 0;
      show($('#revealBtn'), round.status === 'voting');
      show($('#revoteBtn'), round.status !== 'idle');
      const hasNext = queue.some((q) => q.state === 'pending');
      $('#nextBtn').textContent = hasNext ? 'Next story →' : round.status === 'revealed' ? 'Finish story' : 'Next story →';
      $('#nextBtn').disabled = round.status === 'idle' && !hasNext;
      show($('#skipBtn'), Boolean(round.queueItemId) && round.status !== 'revealed');
    }

    // voting
    const canVote = you.voter;
    show($('#voteArea'), round.status === 'voting' && canVote);
    show($('#waitArea'), round.status === 'idle' || (round.status === 'voting' && !canVote));
    $('#waitText').textContent =
      round.status === 'voting' ? `Voting in progress: ${round.votedCount} of ${round.eligibleCount} voted.` : isAdmin ? 'Select a ticket and press "Start voting".' : 'Waiting for the facilitator to start voting…';
    if (round.status === 'voting' && canVote) {
      const mine = you.voted ? localStorage.getItem(myVoteKey()) : null;
      $('#deck').replaceChildren(
        ...session.deck.map((c) =>
          h('button', {
            class: `pcard${mine === c ? ' selected' : ''}`, type: 'button', 'aria-pressed': mine === c ? 'true' : 'false',
            onclick: () => {
              if (mine === c) { localStorage.removeItem(myVoteKey()); wsSend({ type: 'vote', value: null }); }
              else { localStorage.setItem(myVoteKey(), c); wsSend({ type: 'vote', value: c }); }
            },
          }, c),
        ),
      );
      $('#voteProgress').textContent = `${round.votedCount} / ${round.eligibleCount} voted`;
      $('#voteHint').textContent = you.voted
        ? 'Vote cast. Others can see that you voted, but not the value, until everybody has voted. You can change it until then.'
        : 'Others will see that you voted, but not the value, until everybody has voted.';
    }

    // results
    const r = round.results;
    show($('#results'), round.status === 'revealed' && r);
    if (round.status === 'revealed' && r) {
      const c = $('#consensus');
      c.className = `badge ${r.consensus}`;
      c.textContent = { consensus: 'Consensus', close: 'Close', spread: 'Wide spread – discuss', none: 'No numeric votes' }[r.consensus];
      const named = participants.filter((p) => p.vote);
      $('#revealCards').replaceChildren(...named.map((p, i) => {
        const el = h('div', { class: `rcard${isNaN(Number(p.vote)) ? ' nonnum' : ''}` }, p.vote);
        el.style.animationDelay = `${i * 60}ms`;
        return h('div', { class: 'named-vote' }, el, h('div', { class: 'rname', title: p.name }, p.name, p.id === you.id ? ' (you)' : ''));
      }));
      const maxC = Math.max(1, ...r.histogram.map((x) => x.count));
      $('#histogram').replaceChildren(...r.histogram.map((x) => {
        const bar = h('span');
        bar.style.width = `${(x.count / maxC) * 100}%`;
        return h('div', { class: 'hrow' }, h('b', {}, x.card), h('div', { class: 'hbar' }, bar), h('span', {}, x.count));
      }));
      $('#rateNote').textContent = `(× ${session.rate}, rounded up to ${hoursStep()}h)`;
      $('#stAvg').textContent = fmt(r.avg);
      $('#stAvgH').textContent = fmtH(r.avgHours);
      $('#stMed').textContent = fmt(r.median);
      $('#stMedH').textContent = fmtH(r.medianHours);
      $('#stMinMax').textContent = r.min === null ? '–' : `${fmt(r.min)} / ${fmt(r.max)}`;
      $('#stFinal').textContent = fmt(round.finalSP);
      $('#stFinalH').textContent = fmtH(round.finalHours);
      const ex = [];
      if (r.unknownCount) ex.push(`${r.unknownCount} × ?`);
      if (r.coffeeCount) ex.push(`${r.coffeeCount} × ☕ (break)`);
      $('#excluded').textContent = `${r.totalVotes} vote(s).` + (ex.length ? ` Not counted in stats: ${ex.join(', ')}.` : '');

      show($('#finalControls'), isAdmin);
      if (isAdmin) {
        const numeric = session.deck.filter((d) => d.trim() !== '' && !isNaN(Number(d)));
        $('#finalChoices').replaceChildren(...numeric.map((d) =>
          h('button', { type: 'button', class: `chip${Number(d) === round.finalSP ? ' on' : ''}`, onclick: () => wsSend({ type: 'setFinal', sp: Number(d) }) }, d)));
        if (document.activeElement === $('#finalInput')) previewAgreed($('#finalInput').value);
        else {
          $('#finalInput').value = round.finalSP === null || round.finalSP === undefined ? '' : round.finalSP;
          $('#agreedHoursPreview').textContent = round.finalHours === null || round.finalHours === undefined ? '' : `= ${round.finalHours}h`;
        }
        const hasNext = queue.some((q) => q.state === 'pending');
        $('#confirmNextBtn').textContent = hasNext ? 'Save & next' : 'Finish ticket';
        const canSave = jira.writeBack && st && st.key;
        show($('#saveJiraBtn'), Boolean(canSave));
        $('#saveJiraBtn').disabled = round.finalSP === null;
        $('#saveJiraBtn').textContent = round.savedToJira ? 'Saved ✓ – save again' : 'Save to Jira';
      }
    }

    // participants
    $('#partCount').textContent = `(${participants.filter((p) => p.online).length} online)`;
    $('#participants').replaceChildren(...participants.map((p) =>
      h('li', {},
        h('span', { class: `dot${p.online ? '' : ' off'}`, title: p.online ? 'online' : 'offline' }),
        h('span', { class: 'pname' }, p.name, p.id === you.id ? h('span', { class: 'muted' }, ' (you)') : null),
        p.isAdmin ? h('span', { class: 'tag' }, 'facilitator') : null,
        !p.voter ? h('span', { class: 'tag' }, 'observer') : null,
        p.voter && round.status === 'voting'
          ? (p.voted
              ? h('span', { class: 'fcards down', title: 'Voted (value hidden until everyone has voted)' })
              : h('span', { class: 'vstate no', title: 'Not voted yet' }, '…'))
          : null,
        p.voter && round.status === 'revealed'
          ? (p.vote
              ? h('span', { class: `mini-card${isNaN(Number(p.vote)) ? ' nonnum' : ''}`, title: `${p.name} voted ${p.vote}` }, p.vote)
              : h('span', { class: 'vstate no', title: 'Did not vote' }, '–'))
          : null,
        isAdmin && !p.isAdmin ? h('button', { class: 'icon-btn', title: `Remove ${p.name}`, onclick: () => confirm(`Remove ${p.name} from the session?`) && wsSend({ type: 'kick', memberId: p.id }) }, '✕') : null,
      )));

    // queue
    const done = queue.filter((q) => q.state === 'estimated').length;
    $('#queueCount').textContent = queue.length ? `(${done}/${queue.length} estimated)` : '';
    show($('#queueEmpty'), queue.length === 0);
    $('#queue').replaceChildren(...queue.map((q, i) => {
      const isCur = q.id === round.queueItemId;
      const cls = isCur ? 'current' : q.state;
      const titleEl = h('div', { class: 'qtitle' }, ...ticketLabel(q));
      const meta = h('div', { class: 'qmeta' },
        isCur ? h('span', { class: 'tag' }, round.status === 'voting' ? 'voting now' : 'current') : null,
        q.state === 'skipped' ? h('span', { class: 'tag' }, 'skipped') : null,
        q.type ? h('span', {}, q.type) : null,
        q.status ? h('span', {}, q.status) : null,
        q.state !== 'estimated' && q.currentSP !== null ? h('span', {}, `now ${q.currentSP} SP`) : null,
        q.state !== 'estimated' && q.currentEstimate ? h('span', {}, `est. ${q.currentEstimate}`) : null,
        q.state === 'estimated' ? h('span', { class: 'qresult' }, q.finalSP === null ? 'estimated (no agreed SP)' : `✓ ${q.finalSP} SP = ${q.hours}h agreed${q.savedToJira ? ' · saved to Jira' : ''}`) : null,
        q.jiraError ? h('span', { class: 'qerr' }, q.jiraError) : null);
      const actions = isAdmin
        ? h('div', { class: 'qactions' },
            !isCur && q.state !== 'estimated' ? h('button', { class: 'icon-btn', title: 'Estimate this now', onclick: () => wsSend({ type: 'queueSelect', itemId: q.id }) }, '▶') : null,
            q.state === 'estimated' ? h('button', { class: 'icon-btn', title: 'Edit agreed story points', onclick: () => {
              const v = prompt('Agreed story points', q.finalSP ?? '');
              if (v === null || v.trim() === '') return;
              const n = Number(v);
              if (!Number.isFinite(n) || n < 0) return toast('Enter a valid number of story points');
              wsSend({ type: 'setQueueAgreed', itemId: q.id, sp: n });
            } }, '✎SP') : null,
            q.state === 'estimated' && jira.writeBack && q.key && q.finalSP !== null ? h('button', { class: 'icon-btn', title: 'Save agreed points to Jira', onclick: async () => {
              try {
                const r = await api(`/api/sessions/${sid}/jira/save`, { method: 'POST', admin: adminToken(), body: { itemId: q.id } });
                toast(`Saved ${r.storyPoints} SP / ${r.hours}h to ${r.key}`);
              } catch (err) { toast(err.message); }
            } }, q.savedToJira ? '✓J' : '↑J') : null,
            q.state === 'estimated' || q.state === 'skipped' ? h('button', { class: 'icon-btn', title: 'Put back in queue', onclick: () => wsSend({ type: 'queueRestore', itemId: q.id }) }, '↺') : null,
            i > 0 ? h('button', { class: 'icon-btn', title: 'Move up', onclick: () => wsSend({ type: 'queueMove', itemId: q.id, toIndex: i - 1 }) }, '↑') : null,
            i < queue.length - 1 ? h('button', { class: 'icon-btn', title: 'Move down', onclick: () => wsSend({ type: 'queueMove', itemId: q.id, toIndex: i + 1 }) }, '↓') : null,
            q.state === 'pending' && !isCur ? h('button', { class: 'icon-btn', title: 'Skip', onclick: () => wsSend({ type: 'queueSkip', itemId: q.id }) }, '⤼') : null,
            h('button', { class: 'icon-btn', title: 'Edit title', onclick: () => { const t = prompt('Title', q.title); if (t && t.trim()) wsSend({ type: 'queueEdit', itemId: q.id, title: t }); } }, '✎'),
            h('button', { class: 'icon-btn', title: 'Remove', onclick: () => wsSend({ type: 'queueRemove', itemId: q.id }) }, '✕'))
        : h('span');
      return h('li', { class: cls }, titleEl, actions, meta);
    }));
    show($('#queueAdmin'), isAdmin);
    show($('#jqlBox'), isAdmin && jira.enabled);
    if (isAdmin && jira.enabled && !$('#jqlBox').dataset.init) {
      $('#jqlBox').dataset.init = '1';
      if (jira.defaultJql) $('#jqlForm').jql.value = jira.defaultJql;
      if (jira.defaultBoardProject && setDefaultProject) setDefaultProject(jira.defaultBoardProject);
      if (jira.defaultBoard) {
        $('#boardForm').board.value = jira.defaultBoard;
        // show the configured default board by name (JIRA_DEFAULT_BOARD may be a name or an id)
        api(`/api/sessions/${sid}/jira/boards/default`, { admin: adminToken() }).then((r) => {
          if (r.board && $('#boardForm').board.value === jira.defaultBoard) { boardByLabel.set(boardLabel(r.board), r.board); $('#boardForm').board.value = boardLabel(r.board); }
        }).catch(() => {});
      }
    }

    // settings
    show($('#settings'), isAdmin);
    if (isAdmin) {
      if (document.activeElement !== $('#rateInput')) $('#rateInput').value = session.rate;
      if (document.activeElement !== $('#deckInput')) $('#deckInput').value = session.deck.join(', ');
      $('#deckInput').disabled = round.status === 'voting';
      $('#adminVoterToggle').checked = you.voter;
    }

    // history
    show($('#historyEmpty'), history.length === 0);
    $('#historyBody').replaceChildren(...history.slice().reverse().map((e) =>
      h('tr', {},
        h('td', {}, ...ticketLabel(e)),
        h('td', {}, h('b', {}, fmt(e.finalSP))),
        h('td', { class: 'hours' }, fmtH(e.hours)), h('td', {}, `${e.rate} h/SP`), statusCell(e))));
    renderJiraUpdate(isAdmin, jira, history);
    const totals = state.totals;
    const showTot = Boolean(totals && totals.tickets);
    show($('#historyFoot'), showTot);
    if (showTot) {
      $('#totSP').textContent = fmt(totals.agreedSP);
      $('#totH').textContent = fmtH(totals.hours);
      $('#totNote').textContent = `${totals.tickets} ticket${totals.tickets === 1 ? '' : 's'} (agreed SP / hours)`;
    }
  }

  // ---------------- Boot ----------------
  api('/api/config').then((c) => {
    appConfig = c;
    // default selection of "Update in Jira" (JIRA_UPDATE_DEFAULT_MODE); the admin can still change it per update
    const jm = $('#jiraMode');
    if (jm && ['sp', 'time', 'both'].includes(c.jiraUpdateDefaultMode)) jm.value = c.jiraUpdateDefaultMode;
    if (sid) initSession();
    else initLanding();
  }).catch(() => message('Server unavailable', 'Could not reach the planning poker server.'));
})();
