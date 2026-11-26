# Planning Poker 1.0.0

Release date: 2026-11-26

First release of a self-hosted, Jira-integrated planning poker app. Votes are in story points and stay hidden until reveal; the official result per ticket is the **agreed story points** the facilitator enters, converted to hours with a per-session rate.

## Features

### Sessions and members
- The admin starts a session on `/`: session name (default `Estimation session`, configurable with `DEFAULT_SESSION_NAME`), own name, "I will vote too", hours per story point and deck (default Fibonacci `0, 0.5, 1, 2, 3, 5, 8, 13, 21, ?, ☕`, or a custom deck). If `ADMIN_PASSWORD` is set, it is required to start a session.
- Members join through the invite link (`/s/<session-id>`) and register with a name. The participant list is live (online dot, face-down card once a member has voted). Refreshing the page keeps the identity, so no duplicate participants.
- Sessions are kept in memory, persisted to `/data/sessions.json`, and expire after `SESSION_TTL_HOURS` (default 24) without activity.

### Ticket queue
- Paste Jira ticket URLs (one per line or comma separated) or bare keys such as `PROJ-123`. URLs are kept and shown exactly as entered (query strings and trailing slashes included) and open in a new tab from the current ticket, the queue, the history and the CSV.
- With Jira configured, the server reads the summary, type, status and current story points / original estimate. "Load from Jira" adds tickets by JQL search (`JIRA_DEFAULT_JQL`, default `sprint in openSprints() ORDER BY rank`) or from a board's sprints. First pick a **project** from a dropdown of the visible Jira projects (`KEY - Name`, or **All projects**), then a **board by name** from a dropdown of that project's boards, shown as `Name (PROJECT, type)`, scrum boards first; both open on click and filter as you type. Kanban/simple boards are marked as having no sprints. Default board: `JIRA_DEFAULT_BOARD` (name or id) and `JIRA_DEFAULT_BOARD_PROJECT`.
- The admin can start any ticket, reorder, skip, put back, edit the title, edit agreed SP, remove, and add more tickets.

### Voting and reveal
- Vote values never leave the server before reveal: clients only see who has voted.
- Auto-reveal once every registered, online voter has voted (members who disconnect are excluded after `OFFLINE_GRACE_SECONDS`, default 20). The admin can reveal early or re-vote.
- Reveal shows each member's vote next to their name, a histogram, average / median / min / max, a consensus indicator and hours. `?` and ☕ are counted but excluded from the stats.

### Agreed story points and hours
- The admin enters the agreed story points, pre-filled with the deck card nearest the median (ties go up).
- Hours = agreed SP × rate, rounded **up** to the next half hour (e.g. 5.33 SP × 4 = 21.32 → 21.5h; 5 × 4 = 20h). The step is configurable with `HOURS_ROUNDING_STEP` (`1` = whole hours, `0.25` = quarter hours). Hours update live while typing and are stored on the ticket.
- Hours per story point is a spin button in 0.5 steps (0.5 to 100) on the start form and in Settings; the server rejects other values.
- Finished tickets can be edited later; hours and totals are recomputed.

### Session history and export
- History table per ticket: link and title, agreed SP, hours, rate and Jira status, plus a session total of agreed SP and hours.
- Copy as CSV / Download (URL, issue key, title, agreed SP, hours, rate, status, plus a total row).

### UPDATE Jiras (admin only)
- Below the session history, choose **Story points**, **Time (Original estimate)** or **Both** and press **UPDATE Jiras**. The selector starts at `JIRA_UPDATE_DEFAULT_MODE` (`sp`, `time` or `both`; default `both`) and can be changed before each update. A confirmation dialog lists the tickets before anything is written.
- Values are written with `PUT /rest/api/3/issue/{key}`: the story points field and `timetracking.originalEstimate` in Jira duration format (`20h`, `21h 30m`, `30m`).
- **Remaining estimate is kept in step** (`JIRA_RECALC_REMAINING`, default `true`): before writing time, the app reads the ticket's time spent and sends `remainingEstimate` = max(0, new original − time spent) in the same edit. Example for a new 4h estimate: nothing logged → 4h, 1h 30m logged → 2h 30m, 5h logged → 0m. `false` writes the Original estimate only. Per-ticket Save to Jira follows the same rule.
- Status per ticket: **Not sent**, **Updated** (time and fields), **Failed** (hover shows Jira's error) or **Changed since update**. Statuses are stored, pushed live to everyone, and read-only for voters.
- Already updated tickets are skipped unless **Re-send already updated** is ticked; **Retry failed** resends only the failed tickets with the same fields.
- Requests run with concurrency 3 and honour HTTP 429 `Retry-After`. Finishing a ticket in the room never writes to Jira.
- The button is disabled with a hint when Jira credentials are missing. `GET /api/jira/status` reports non-secret status (configured, story points field, write permission).
- Optional: `JIRA_WRITE_BACK=true` adds per-ticket **Save to Jira** buttons.

### Start from Jira with one click
- `GET /new?tickets=<URLs or keys>` opens the start page with the tickets prefilled (deduplicated, in order, at most 200; only http(s) URLs and `KEY-123` keys are accepted). An optional `&jql=` adds the results of a Jira search, run only after the admin password is entered.
- `/bookmarklet.html` provides a draggable **Planning Poker** bookmark for the current origin. Clicked on a Jira filter, search or backlog page, it sends every `/browse/KEY-123` link to the app; with no tickets on the page it shows an alert and opens the app home page.

### Operations
- `GET /healthz` returns `{"ok":true,"version":"1.0.0","sessions":N}`; `GET /api/config` returns non-secret settings including the version.
- Static assets are cache-busted (`?v=<content hash>`, cached as immutable); HTML is served `no-cache`, so a new deployment never needs a hard refresh.
- Secrets (`ADMIN_PASSWORD`, `JIRA_API_TOKEN`) are used only server-side and never sent to browsers or written to logs.

## Configuration

All settings are environment variables; everything is optional. Without Jira variables the app runs in manual mode.

| Variable | Default | Purpose |
|---|---|---|
| `ADMIN_PASSWORD` | – | Required to start a session (recommended). Secret |
| `PORT` / `HOST` | `8080` / `0.0.0.0` | Listen port and address |
| `DATA_FILE` | `/data/sessions.json` (image) | Session persistence file |
| `DEFAULT_SESSION_NAME` | `Estimation session` | Default session name |
| `DEFAULT_RATE` | `4` | Default hours per story point (multiple of 0.5) |
| `HOURS_ROUNDING_STEP` | `0.5` | Hours are rounded up to this step |
| `SESSION_TTL_HOURS` | `24` | Inactive sessions are deleted after this |
| `OFFLINE_GRACE_SECONDS` | `20` | Disconnected members still count for auto-reveal this long |
| `JIRA_BASE_URL` | – | Jira Cloud site, e.g. `https://url1` |
| `JIRA_EMAIL` | – | Jira account email |
| `JIRA_API_TOKEN` | – | Jira API token. Secret |
| `JIRA_STORY_POINTS_FIELD` | auto-detect | Story points custom field id |
| `JIRA_DEFAULT_JQL` | `sprint in openSprints() ORDER BY rank` | JQL prefilled in "Load from Jira" |
| `JIRA_DEFAULT_BOARD` | – | Default board in the board picker, by name (exact match preferred, else first contains match; a number = id). `JIRA_DEFAULT_BOARD_ID` is an alias |
| `JIRA_DEFAULT_BOARD_PROJECT` | – | Project preselected in the Project dropdown; limits the board picker |
| `JIRA_TIMEOUT_SECONDS` | `15` | Timeout per Jira request |
| `JIRA_RECALC_REMAINING` | `true` | Also set Remaining estimate = max(0, new original − time logged) |
| `JIRA_UPDATE_DEFAULT_MODE` | `both` | Default of "Update in Jira": `sp`, `time` or `both` |
| `JIRA_WRITE_BACK` | `false` | Show per-ticket Save to Jira buttons |
| `JIRA_WRITE_ORIGINAL_ESTIMATE` | `true` | Per-ticket save also writes the Original estimate |

Jira is enabled when `JIRA_BASE_URL`, `JIRA_EMAIL` and `JIRA_API_TOKEN` are all set. The Jira account needs Browse projects, and Edit issues for updates; the Original estimate needs time tracking enabled.

## Deployment

- **Docker image:** two-stage `node:20-alpine` build, runs as the non-root `node` user, port `8080`, data in `/data`. Build with `docker build -t planning-poker:1.0.0 .` or per architecture with `docker buildx` (`planning-poker:1.0.0-arm64`, `planning-poker:1.0.0-amd64`).
- **Docker:**
  ```bash
  cp .env.example .env && chmod 600 .env   # fill in values
  docker run -d --name planning-poker --restart unless-stopped \
    -p 127.0.0.1:8080:8080 -v poker-data:/data --env-file .env planning-poker:1.0.0
  curl -s http://127.0.0.1:8080/healthz
  ```
  Docker Compose: `docker compose up -d --build`.
- **Kubernetes:** kustomize manifests in `k8s/` (namespace, ConfigMap, Secret template, PVC, single-replica Deployment with `strategy: Recreate`, Service, example Ingress). Create the Secret with `kubectl create secret generic`, edit the ConfigMap and image tag, then `kubectl apply -k k8s/`.
- **Reverse proxy:** put TLS in front (nginx or Caddy examples in the README); WebSockets use `/ws` on the same port. Run one instance only.

See `README.md` for the full guide.

## Known limitations
- One instance only: state lives in the process and a JSON file.
- The Jira account must be able to edit the tickets, and the story points field must be on the edit screen; otherwise the ticket shows Failed with Jira's message.
- With `JIRA_RECALC_REMAINING=true`, a Remaining estimate adjusted by hand in Jira is overwritten on the next time update.
- The bookmarklet collects every `/browse/KEY-123` link on the page, not only selected rows.
