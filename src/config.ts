function bool(v: string | undefined, def = false): boolean {
  if (v === undefined || v === '') return def;
  return ['1', 'true', 'yes', 'on'].includes(v.trim().toLowerCase());
}
function num(v: string | undefined, def: number): number {
  const n = Number(v);
  return v !== undefined && v !== '' && Number.isFinite(n) ? n : def;
}

export const JIRA_UPDATE_MODES = ['sp', 'time', 'both'] as const;
export type JiraUpdateMode = (typeof JIRA_UPDATE_MODES)[number];
/** JIRA_UPDATE_DEFAULT_MODE: sp | time | both (case-insensitive). Empty -> both; anything else -> both + a warning. */
export function parseJiraUpdateMode(v: string | undefined): { mode: JiraUpdateMode; warning: string | null } {
  const t = (v ?? '').trim().toLowerCase();
  if (t === '') return { mode: 'both', warning: null };
  if ((JIRA_UPDATE_MODES as readonly string[]).includes(t)) return { mode: t as JiraUpdateMode, warning: null };
  return { mode: 'both', warning: `JIRA_UPDATE_DEFAULT_MODE="${String(v).slice(0, 40)}" is not one of sp, time, both - using "both"` };
}
const updateMode = parseJiraUpdateMode(process.env.JIRA_UPDATE_DEFAULT_MODE);

export const DEFAULT_DECK = ['0', '0.5', '1', '2', '3', '5', '8', '13', '21', '?', '☕'];

export const config = {
  port: num(process.env.PORT, 8080),
  host: process.env.HOST || '0.0.0.0',
  adminPassword: process.env.ADMIN_PASSWORD || '',
  defaultRate: (() => { const n = num(process.env.DEFAULT_RATE, 4); return Math.min(100, Math.max(0.5, Math.round(n * 2) / 2)); })(),
  // Hours are rounded UP to the next multiple of this (0.5 = half hours, 1 = whole hours)
  hoursRoundingStep: (() => { const n = num(process.env.HOURS_ROUNDING_STEP, 0.5); return n > 0 && n <= 24 ? n : 0.5; })(),
  defaultSessionName: (process.env.DEFAULT_SESSION_NAME || '').trim().slice(0, 80) || 'Estimation session',
  sessionTtlMs: num(process.env.SESSION_TTL_HOURS, 24) * 3600_000,
  offlineGraceMs: num(process.env.OFFLINE_GRACE_SECONDS, 20) * 1000,
  dataFile: process.env.DATA_FILE || '',
  trustProxy: bool(process.env.TRUST_PROXY, false),
  jira: {
    baseUrl: (process.env.JIRA_BASE_URL || '').replace(/\/+$/, ''),
    email: process.env.JIRA_EMAIL || '',
    apiToken: process.env.JIRA_API_TOKEN || '',
    storyPointsField: process.env.JIRA_STORY_POINTS_FIELD || '',
    writeBack: bool(process.env.JIRA_WRITE_BACK, false),
    writeOriginalEstimate: bool(process.env.JIRA_WRITE_ORIGINAL_ESTIMATE, true),
    defaultJql: process.env.JIRA_DEFAULT_JQL || 'sprint in openSprints() ORDER BY rank',
    // default board for "Load from Jira": a board name (exact, case-insensitive match preferred, else first contains match)
    // or a numeric id. JIRA_DEFAULT_BOARD_ID is kept as an alias.
    defaultBoard: (process.env.JIRA_DEFAULT_BOARD || process.env.JIRA_DEFAULT_BOARD_ID || '').trim().slice(0, 100),
    // optional project key/id that limits the board picker (and the default board lookup)
    defaultBoardProject: (process.env.JIRA_DEFAULT_BOARD_PROJECT || '').trim().slice(0, 50),
    timeoutMs: num(process.env.JIRA_TIMEOUT_SECONDS, 15) * 1000,
    // when time is written: also set remainingEstimate = max(0, new original - time spent) (read from Jira first)
    recalcRemaining: bool(process.env.JIRA_RECALC_REMAINING, true),
    // default selection of the "Update in Jira" selector (UPDATE Jiras); can be changed per update in the UI
    updateDefaultMode: updateMode.mode,
    updateDefaultModeWarning: updateMode.warning,
  },
};

export const jiraEnabled = (): boolean =>
  Boolean(config.jira.baseUrl && config.jira.email && config.jira.apiToken);
