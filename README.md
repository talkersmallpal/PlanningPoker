# Planning Poker (self-hosted, Jira-integrated)

Self-hosted planning poker for any team that uses Jira Cloud (or no Jira at all). Votes are in story points. During voting everyone can see **who has voted**, but not the value. After reveal, each member's vote is shown next to their name. The official ticket result is the **agreed story points** the facilitator enters (pre-filled with the median rounded to the nearest deck card; ties go up) — not the sum or average of the votes. Hours = agreed SP × rate, **always rounded up to the next half hour** by default (e.g. 5.33 SP × 4 = 21.32 → **21.5h**; 5 SP × 4 = 20 → **20h**). The step is configurable with `HOURS_ROUNDING_STEP` (`1` gives whole-hour rounding: 21.32 → 22h).

- Node.js 20 + TypeScript server (plain `http` + `ws`), plain HTML/CSS/JS frontend, one Docker image.
- Sessions live in memory and are persisted to a JSON file in a Docker volume (`/data/sessions.json`); they expire after 24h without activity.

## How it works

1. **Admin starts a session** on `/`: session name, own name, "I will vote too", hours per story point (default 4; a spin button in 0.5 steps, e.g. 2.5), deck (default Fibonacci `0, 0.5, 1, 2, 3, 5, 8, 13, 21, ?, ☕`) and the **Jira tickets to estimate** (paste ticket URLs, one per line or separated by commas, e.g. `https://url1`; bare keys such as `PROJ-123` still work). The URL is kept and shown exactly as entered — as a clickable link (`target=_blank`) on the current ticket, the queue, the history table and in the CSV — so anyone can open it and update the ticket in Jira. The server still extracts the issue key to load the summary, type, status and current story points / original estimate. The admin token is stored in the browser's localStorage. If `ADMIN_PASSWORD` is set, it is required to start a session.
2. **Admin shares the invite link** (`/s/<session-id>`). Members open it and **register with a name**; everyone appears live in the participant list (online dot, a face-down card once they have voted).
3. **Queue:** everyone sees the ticket list with each ticket URL shown verbatim as a new-tab link (Jira title alongside, not instead of the URL). The current ticket is highlighted; estimated ones show `✓ 5 SP = 20h`. The admin can start any ticket (▶), reorder (↑↓), skip (↩), put back (↺), edit the title (✎), edit agreed SP (✎SP), remove (✕) and add more URLs or keys. JQL search and board → sprint loading (boards picked **by name**) are available as a secondary option ("Load from Jira", see [Load from Jira](#load-from-jira)).
4. **Vote values stay hidden until reveal.** The server keeps `member → card` internally. Before reveal, clients only get a "has voted" flag (a face-down card next to the name) — the value is never sent in any WebSocket message. After auto-reveal or an early admin reveal, everyone sees each member's vote next to their name, plus the distribution / average / median as discussion context.
5. **Auto-reveal** when every registered, online voter has voted (members who disconnect are excluded after `OFFLINE_GRACE_SECONDS`, default 20s). The admin can also reveal early. Reveal shows named votes, a histogram, average/median/min/max, a consensus indicator, and hours. `?` and ☕ are excluded from the stats and shown as counts.
6. Admin enters the **agreed story points** (the official result). The field is pre-filled with the deck card nearest the median (ties go up). As the value is typed, the hours (agreed SP × rate, rounded up to the next half hour) update immediately. **Save & next** / **Finish ticket** stores both the agreed SP and the hours on the ticket record (and in `sessions.json`). The admin can also **Re-vote**. Jira is updated in one batch with **UPDATE Jiras** (step 8). The admin can later edit the agreed value on a finished ticket; hours are recomputed and stored again.
7. **Session history** table (ticket URL link and title, agreed SP, hours, rate; no avg/median/time columns) plus a **session total** of agreed SP and hours, with **Copy as CSV** / Download (CSV columns: URL, issue key, title, agreed SP, hours, rate, saved to Jira, plus a session-total row).
8. **UPDATE Jiras (admin only).** Below the session history, choose **Story points**, **Time (Original estimate)** or **Both** (preselected from `JIRA_UPDATE_DEFAULT_MODE`, default **Both**) and press **UPDATE Jiras**. After a confirmation dialog ("Update N tickets: story points + time", with the ticket list), the stored agreed SP and/or hours (Jira duration format, e.g. `20h`, `21h 30m`) of the finished tickets are written to Jira (`PUT /rest/api/3/issue/{key}`: story points field, `timetracking.originalEstimate` and, by default, a recalculated `timetracking.remainingEstimate`; see [Updating Jira](#updating-jira)). Tickets already **Updated** are skipped unless **Re-send already updated** is ticked. Tickets are processed with concurrency 3, results are per ticket, and HTTP 429 is retried using Jira's `Retry-After`. Saving a ticket in the room never writes to Jira.
   - The history table has a **Status** column for every ticket: **Not sent**, **Updated** (local time + which fields), **Failed** (hover for Jira's error, e.g. `403` no permission or field not on the screen) or **Changed since update** (agreed SP edited after a successful update; editing it back clears the flag). Statuses are stored in `sessions.json` and pushed live to everyone; voters see the column read-only.
   - **Retry failed** (visible only when something failed) resends just the failed tickets with the same fields as the failed attempt.
   - The button, selector and retry are admin-only; the server enforces the admin token on `POST /api/sessions/{id}/jira/update`. Without Jira credentials the button is disabled with the hint "Jira not configured: set JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN". `GET /api/jira/status` returns non-secret info (configured yes/no, story points field id configured or auto-detected, write permission "unknown" until the first update).
   - The CSV export includes the Status.
   - `JIRA_WRITE_BACK=true` (default `false`) additionally shows per-ticket **Save to Jira** buttons for single-ticket updates.
9. **Start from Jira with one click (`/new?tickets=`).** `GET /new?tickets=<comma-separated, URL-encoded ticket URLs or keys>` (repeated `tickets=` parameters also work) opens the Start page with the ticket box prefilled, one per line, deduplicated, in order, URLs verbatim. You still enter the admin password and press **Start**. Only `http(s)` URLs and `KEY-123` keys are accepted; anything else is ignored with a notice, at most 200 tickets are kept, and values are only ever set as text (no HTML injection). An optional `&jql=<JQL>` adds the tickets of a Jira search when Jira is configured; the search runs only after the admin password has been entered (if one is set), so the link never exposes Jira data. Open **/bookmarklet.html** (linked from the Start page) for a draggable **Planning Poker** bookmark whose base URL is the current origin, plus copy-paste code and install steps. Click it on any Jira filter/search/backlog page to send every `/browse/KEY-123` link on the page to the app.

Refreshing the page keeps your identity (member token in localStorage) – no duplicate participants.

## 1. Build the Docker image

The [`Dockerfile`](Dockerfile) is a two-stage build on `node:20-alpine`: it compiles the TypeScript, drops dev dependencies, and produces a small image that runs as the non-root `node` user (uid/gid 1000), listens on port `8080` and keeps its data in `/data`.

**Step 1 – get the source** (a git clone or the `planning-poker-<version>-src.zip`) and `cd` into it.

**Step 2 – build for the machine you are on:**

```bash
docker build -t planning-poker:1.0.0 .
```

**Step 3 (optional) – build for a specific CPU architecture** with [buildx](https://docs.docker.com/build/building/multi-platform/). Use `linux/arm64` for Apple Silicon / ARM servers and `linux/amd64` for Intel/AMD servers and most Kubernetes clusters:

```bash
# one-time: a builder that can target other architectures (Docker Desktop already has one)
docker buildx create --name multi --use
# on Linux you may also need QEMU emulation once:
#   docker run --privileged --rm tonistiigi/binfmt --install arm64,amd64

# single-arch images loaded into the local Docker engine
docker buildx build --platform linux/arm64 -t planning-poker:1.0.0-arm64 --load .
docker buildx build --platform linux/amd64 -t planning-poker:1.0.0-amd64 --load .

# or one multi-arch image pushed straight to your registry
docker buildx build --platform linux/amd64,linux/arm64 -t registry.example.com/planning-poker:1.0.0 --push .
```

**Step 4 (optional) – move the image to a machine without registry access** using `docker save` / `docker load`:

```bash
# on the build machine
docker save planning-poker:1.0.0-amd64 | gzip > planning-poker-1.0.0-amd64.tar.gz
sha256sum planning-poker-1.0.0-amd64.tar.gz          # macOS: shasum -a 256 …
# optional: split into 5 MB parts for size-limited transfers
split -b 5m -d -a 2 planning-poker-1.0.0-amd64.tar.gz planning-poker-1.0.0-amd64.tar.gz.part

# on the target machine
cat planning-poker-1.0.0-amd64.tar.gz.part* > planning-poker-1.0.0-amd64.tar.gz   # only if split
sha256sum planning-poker-1.0.0-amd64.tar.gz          # compare with the published sum
docker load -i planning-poker-1.0.0-amd64.tar.gz     # -> planning-poker:1.0.0-amd64
```

Without Docker: `npm ci && npm run build && npm start` (Node.js 20+).

## 2. Configure: environment variables

All configuration comes from environment variables. Everything is optional: with no Jira variables the app runs in manual mode (pasted titles / keys only). Secrets (`ADMIN_PASSWORD`, `JIRA_API_TOKEN`) are only used server-side and are never sent to browsers or written to logs.

| Variable | Required | Default | Description |
|---|---|---|---|
| `ADMIN_PASSWORD` | Recommended | – (no password) | Password needed to start a session. Strongly recommended whenever Jira is configured. **Secret.** |
| `PORT` | Optional | `8080` | HTTP + WebSocket port inside the container |
| `HOST` | Optional | `0.0.0.0` | Listen address |
| `DATA_FILE` | Optional | `/data/sessions.json` in the image; empty (memory only) when run with plain Node | File where sessions are persisted. Mount a volume at `/data` to keep sessions across restarts and upgrades |
| `DEFAULT_SESSION_NAME` | Optional | `Estimation session` | Default session name on the start form, also used when the name is left blank (max 80 chars) |
| `DEFAULT_RATE` | Optional | `4` | Default hours per story point on the start form. Rates are multiples of 0.5 between 0.5 and 100 (other values are rounded to the nearest 0.5) |
| `HOURS_ROUNDING_STEP` | Optional | `0.5` | Hours (SP × rate) are rounded **up** to the next multiple of this: `0.5` = half hours (21.32 → 21.5h), `1` = whole hours (21.32 → 22h), `0.25` = quarter hours. Jira Original estimate is sent as e.g. `21h 30m` |
| `SESSION_TTL_HOURS` | Optional | `24` | Sessions are deleted after this many hours without activity |
| `OFFLINE_GRACE_SECONDS` | Optional | `20` | A member who disconnects still counts for "everybody voted" for this long (covers page refreshes) |
| `JIRA_BASE_URL` | For Jira | – | Your Jira Cloud site, e.g. `https://url1` |
| `JIRA_EMAIL` | For Jira | – | Atlassian account email used for basic auth (a service account is recommended) |
| `JIRA_API_TOKEN` | For Jira | – | API token of that account ([create one](https://id.atlassian.com/manage-profile/security/api-tokens)). **Secret.** |
| `JIRA_STORY_POINTS_FIELD` | Optional | auto-detect | Custom field id of your story points field (e.g. `customfield_12345`). If empty, the server looks up the field named "Story Points" or "Story point estimate" via `/rest/api/3/field` |
| `JIRA_DEFAULT_JQL` | Optional | `sprint in openSprints() ORDER BY rank` | JQL prefilled in "Load from Jira", e.g. `project = PROJ AND sprint in openSprints() ORDER BY rank` |
| `JIRA_DEFAULT_BOARD` | Optional | – | Board prefilled in the board picker of "Load from Jira", **by name**, e.g. `Team board`. An exact (case-insensitive) name match is preferred, otherwise the first board whose name contains the text; a number is used as a board id |
| `JIRA_DEFAULT_BOARD_ID` | Optional | – | Older alias of `JIRA_DEFAULT_BOARD` (used only when `JIRA_DEFAULT_BOARD` is empty) |
| `JIRA_DEFAULT_BOARD_PROJECT` | Optional | – | Project preselected in the Project dropdown (key or id), which limits the board picker and the default board lookup, e.g. `PROJ` |
| `JIRA_TIMEOUT_SECONDS` | Optional | `15` | Timeout for each Jira request |
| `JIRA_RECALC_REMAINING` | Optional | `true` | When time is written, also set the **Remaining estimate** to max(0, new Original estimate − time already logged), read from the ticket just before the write. `false` writes the Original estimate only (Jira then leaves the Remaining estimate unchanged). See [Updating Jira](#updating-jira) |
| `JIRA_UPDATE_DEFAULT_MODE` | Optional | `both` | Default selection of **Update in Jira** for UPDATE Jiras: `sp` (story points), `time` (Original estimate) or `both`. The admin can still change it before each update. Invalid values fall back to `both` with a warning in the log |
| `JIRA_WRITE_BACK` | Optional | `false` | `true` shows per-ticket **Save to Jira** buttons. **UPDATE Jiras** does not need it |
| `JIRA_WRITE_ORIGINAL_ESTIMATE` | Optional | `true` | Per-ticket Save to Jira only: also write `timetracking.originalEstimate`. **UPDATE Jiras** follows its own selector |

Jira is enabled when `JIRA_BASE_URL`, `JIRA_EMAIL` and `JIRA_API_TOKEN` are all set. Jira calls used: `GET /rest/api/3/field`, `GET /rest/api/3/issue/{key}?fields=…`, `POST /rest/api/3/search/jql` (with `nextPageToken` paging), `GET /rest/api/3/project/search` (project picker, paged with `startAt`, max 500 projects), `GET /rest/agile/1.0/board?name=…&projectKeyOrId=…` (board picker, paged with `startAt`, max 100 boards), `GET /rest/agile/1.0/board/{id}` (numeric default board), `GET /rest/agile/1.0/board/{id}/sprint`, and, only when you press UPDATE Jiras (or use a per-ticket Save to Jira button), `GET /rest/api/3/issue/{key}?fields=timetracking` (time spent, when `JIRA_RECALC_REMAINING` is on) followed by `PUT /rest/api/3/issue/{key}` with `{"fields": {"<sp field>": 5, "timetracking": {"originalEstimate": "20h", "remainingEstimate": "18h 30m"}}}`. The token's user needs Browse projects (and Edit issues for updates). Original Estimate requires time tracking to be enabled.

### Load from Jira

The admin's ticket queue has a fold-out **Load from Jira (JQL / sprint)** panel (only when Jira is configured):

- **JQL search:** prefilled from `JIRA_DEFAULT_JQL` (e.g. `project = PROJ AND sprint in openSprints() ORDER BY rank`); edit it and press **Search**. Results (up to 100) are listed with checkboxes; tickets already in the queue are greyed out; **Add selected** appends them in Jira rank order.
- **Project → board → sprint, by name:** the **Project** field sits above the board field and is a dropdown of the Jira projects the token's user can see, shown as `KEY - Name` (first entry **All projects**). It opens on click, filters by key or name as you type, and is prefilled from `JIRA_DEFAULT_BOARD_PROJECT`; typing a key and tabbing away works too. Picking a project reloads the board list and clears a board of another project. The **board** field also opens a dropdown on click (no typing needed) with that project's boards, shown as `Name (PROJECT, type)`; typing narrows it. Scrum boards are listed first; kanban and simple boards are marked "no sprints" because Jira only has sprints on scrum boards. Press **Sprints** to load the board's active and future sprints, then choose a sprint to run `sprint = <id> ORDER BY rank`. Board ids are only used internally; a typed number still works as an id.
- **Default board:** `JIRA_DEFAULT_BOARD` (a board name, or an id) is resolved on the server (exact name match first, then the first contains match) and shown by name in the picker.
- Endpoints (admin token required): `GET /api/sessions/{id}/jira/projects` (all visible projects, max 500, cached 5 minutes), `GET /api/sessions/{id}/jira/boards?q=<name>&project=<key>`, `GET /api/sessions/{id}/jira/boards/default`, `GET /api/sessions/{id}/jira/boards/{boardId}/sprints` (a non-scrum board answers 400 "This board has no sprints").

### Updating Jira

**UPDATE Jiras** (admin only, below the session history) writes the agreed values of finished tickets to Jira in one batch.

| Mode (`Update in Jira`) | Value | What is written |
|---|---|---|
| Story points | `sp` | the story points field (agreed SP) |
| Time (Original estimate) | `time` | `timetracking.originalEstimate` (hours) and, by default, `remainingEstimate` |
| Both | `both` | both of the above in one edit |

- **Default mode:** the selector starts at `JIRA_UPDATE_DEFAULT_MODE` (`sp`, `time` or `both`; default `both`). The admin can pick another mode before each update. An invalid value falls back to `both` and logs a warning at startup. `/api/config` reports the active value as `jiraUpdateDefaultMode`.
- **Remaining estimate:** Jira does not recalculate the Remaining estimate when the Original estimate changes. With `JIRA_RECALC_REMAINING=true` (default) the app reads the ticket's time spent right before writing and sends, in the same edit:
  - `originalEstimate` = agreed SP × rate (rounded up to the next half hour)
  - `remainingEstimate` = max(0, new original − time spent)

  | New original | Time logged | Remaining sent |
  |---|---|---|
  | 4h | none | `4h` |
  | 4h | 1h 30m | `2h 30m` |
  | 4h | 5h | `0m` |

  This overwrites a Remaining estimate that was adjusted by hand in Jira. Set `JIRA_RECALC_REMAINING=false` to write the Original estimate only. `/api/config` reports the setting as `jiraRecalcRemaining`.
- Per-ticket **Save to Jira** (`JIRA_WRITE_BACK=true`) follows the same remaining-estimate rule when it writes time (`JIRA_WRITE_ORIGINAL_ESTIMATE=true`).
- Requirements: the Jira account needs Edit issues, the story points field must be on the edit screen, and time tracking must be enabled. A failed ticket shows **Failed** with Jira's message.

## 3. Run with Docker

**Option A – an env file (recommended).** Copy the template, fill it in, and keep it out of git (`.env` is already in `.gitignore`):

```bash
cp .env.example .env
chmod 600 .env
# edit .env: ADMIN_PASSWORD, JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN, …

docker volume create poker-data
docker run -d --name planning-poker --restart unless-stopped \
  -p 127.0.0.1:8080:8080 \
  -v poker-data:/data \
  --env-file .env \
  planning-poker:1.0.0          # or :1.0.0-arm64 / :1.0.0-amd64
```

**Option B – individual `-e` flags:**

```bash
docker run -d --name planning-poker --restart unless-stopped \
  -p 127.0.0.1:8080:8080 \
  -v poker-data:/data \
  -e ADMIN_PASSWORD='change-me' \
  -e JIRA_BASE_URL='https://url1' \
  -e JIRA_EMAIL='planning-poker@example.com' \
  -e JIRA_API_TOKEN='your-jira-api-token' \
  -e JIRA_DEFAULT_JQL='project = PROJ AND sprint in openSprints() ORDER BY rank' \
  -e DEFAULT_SESSION_NAME='Sprint refinement' \
  planning-poker:1.0.0
```

(Avoid typing real tokens on the command line on shared machines: they end up in shell history. Prefer `--env-file`.)

**Option C – Docker Compose** ([`docker-compose.yml`](docker-compose.yml) reads `.env` and creates the `poker-data` volume):

```bash
cp .env.example .env        # fill in values
docker compose up -d --build
docker compose logs -f
```

**Check it:**

```bash
curl -s http://127.0.0.1:8080/healthz          # {"ok":true,"version":"1.0.0","sessions":N}
curl -s http://127.0.0.1:8080/api/jira/status  # configured yes/no + story points field (no secrets)
docker logs -f planning-poker
```

Open `http://127.0.0.1:8080`. The ports bind to localhost only; put a TLS reverse proxy in front for other users (see below).

**Upgrade:** load or build the new image, then replace the container with the same volume and env file. Sessions in `poker-data` are kept, and browsers pick up the new UI automatically (no hard refresh needed, see [Caching](#caching)):

```bash
docker rm -f planning-poker
docker run -d --name planning-poker --restart unless-stopped \
  -p 127.0.0.1:8080:8080 -v poker-data:/data --env-file .env planning-poker:<new-version>
```

## 4. Deploy on Kubernetes

Manifests are in [`k8s/`](k8s/) and are applied with kustomize. The app keeps WebSocket state in the process and sessions in a file, so it runs as **exactly one replica** (`strategy: Recreate`) with a PersistentVolumeClaim on `/data`.

| File | What it creates |
|---|---|
| `namespace.yaml` | Namespace `planning-poker` |
| `configmap.yaml` | Non-secret settings (`JIRA_BASE_URL`, `JIRA_DEFAULT_JQL`, `DEFAULT_SESSION_NAME`, `DEFAULT_RATE`, …) |
| `secret.example.yaml` | **Template only**, not applied: shows the Secret keys `ADMIN_PASSWORD`, `JIRA_EMAIL`, `JIRA_API_TOKEN` |
| `pvc.yaml` | 1 Gi `ReadWriteOnce` volume for `/data/sessions.json` |
| `deployment.yaml` | 1 replica, non-root, read-only root filesystem, `/healthz` probes, env from the ConfigMap + Secret |
| `service.yaml` | ClusterIP service on port 80 → container port 8080 |
| `ingress.yaml` | Example ingress-nginx Ingress for `poker.example.com` with WebSocket timeouts |
| `kustomization.yaml` | Ties it together and sets the image name/tag |

**Step 1 – push the image to a registry your cluster can pull from.** Most clusters are amd64; use arm64 for ARM nodes, or push a multi-arch image (see section 1).

```bash
export REGISTRY=registry.example.com
docker tag planning-poker:1.0.0-amd64 "$REGISTRY/planning-poker:1.0.0"
docker push "$REGISTRY/planning-poker:1.0.0"
```

Then set the image in `k8s/kustomization.yaml`:

```yaml
images:
  - name: REGISTRY/planning-poker
    newName: registry.example.com/planning-poker
    newTag: "1.0.0"
```

**Step 2 – create the namespace:**

```bash
kubectl create namespace planning-poker --dry-run=client -o yaml | kubectl apply -f -
```

**Step 3 – create the Secret** (real values stay in your shell, never in git):

```bash
kubectl -n planning-poker create secret generic planning-poker \
  --from-literal=ADMIN_PASSWORD='change-me' \
  --from-literal=JIRA_EMAIL='planning-poker@example.com' \
  --from-literal=JIRA_API_TOKEN='your-jira-api-token'
```

Alternatively copy `k8s/secret.example.yaml` to a file outside the repo, put the real values in it and `kubectl apply -f` that copy. To run without Jira, set `JIRA_EMAIL` and `JIRA_API_TOKEN` to empty values (`--from-literal=JIRA_EMAIL=`).

**Step 4 – edit the ConfigMap** (`k8s/configmap.yaml`) for your Jira site (`JIRA_BASE_URL: "https://url1"`), default JQL, default board (`JIRA_DEFAULT_BOARD`, by name) and project, session name and rate. Any variable from the table in section 2 can go here, except the secrets.

**Step 5 – the Ingress (optional).** Change the host `poker.example.com` and `secretName: planning-poker-tls` to a real hostname and TLS secret (or add cert-manager annotations). To skip it, remove `- ingress.yaml` from `kustomization.yaml`.

**Step 6 – preview and apply:**

```bash
kubectl kustomize k8s/        # preview the rendered manifests
kubectl apply -k k8s/
kubectl -n planning-poker rollout status deploy/planning-poker
```

**Step 7 – verify:**

```bash
kubectl -n planning-poker get pods,svc,pvc,ingress
kubectl -n planning-poker logs deploy/planning-poker
kubectl -n planning-poker port-forward svc/planning-poker 8080:80
curl -s http://127.0.0.1:8080/healthz           # {"ok":true,"version":"1.0.0",...}
curl -s http://127.0.0.1:8080/api/jira/status   # "configured": true when the Jira vars are set
# open http://127.0.0.1:8080
```

**Upgrade to a new version:** push the new image, bump `newTag` in `kustomization.yaml` and re-apply (or set it directly). Sessions on the PVC are kept:

```bash
kubectl apply -k k8s/
# or: kubectl -n planning-poker set image deploy/planning-poker planning-poker=registry.example.com/planning-poker:<new-version>
kubectl -n planning-poker rollout status deploy/planning-poker
```

After changing the ConfigMap or Secret, restart the pod so it reads the new values: `kubectl -n planning-poker rollout restart deploy/planning-poker`.

See [`k8s/README.md`](k8s/README.md) for security-context and probe details.

## Caching

HTML pages are served with `Cache-Control: no-cache`; they reference `app.js`, `styles.css`, `bookmarklet.js` and the favicon as `/<file>?v=<content hash>`. Those versioned URLs are cached for a year (`immutable`), and any unversioned or stale-hash request is revalidated. After an upgrade the browser loads the new HTML, sees new hashes and fetches the new assets: no hard refresh needed.

## Reverse proxy (HTTPS + WSS)

The app speaks HTTP and WebSocket on one port (`/ws`). Terminate TLS in front of it; the browser automatically uses `wss://` when the page is served over `https://`.

**nginx**

```nginx
server {
  listen 443 ssl http2;
  server_name poker.example.com;
  ssl_certificate     /etc/ssl/certs/poker.crt;
  ssl_certificate_key /etc/ssl/private/poker.key;

  location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 3600s;   # keep idle WebSockets open (server pings every 30s)
  }
}
```

**Caddy**: `poker.example.com { reverse_proxy 127.0.0.1:8080 }` (WebSockets work out of the box).

Run one instance only (state is in-process). Health check: `GET /healthz`.

## Tests

```bash
npm test            # unit (rounding, stats, key parsing) + end-to-end
```

The end-to-end test starts the real server and a Jira mock (`test/mock-jira.mjs`), connects WebSocket clients (admin + 3 members), and checks: queue loaded from pasted ticket URLs (query strings and trailing slashes kept verbatim, never rewritten to a bare key), registration, who-voted visibility without values, named reveal after the last vote, agreed SP pre-filled from the median (nearest card, ties go up), live hours when the agreed number is changed, admin override, hours always rounded up (to the next 0.5h) and stored on the ticket record, Jira write-back using the agreed SP and hours, session totals, editing a finished ticket (hours recomputed and stored), persistence of URL / agreed SP / hours across restarts, JQL paging, queue skip/reorder/remove/add, reconnect without duplicates, the offline grace period, and the no-Jira mode.

UI screenshots: `PLAYWRIGHT_PATH=/path/to/node_modules/playwright node test/screenshots.mjs` → `screenshots/`.

## Layout

```
src/server.ts     HTTP API, static files, WebSocket protocol, Jira endpoints
src/sessions.ts   session/round/queue state, anonymity boundary (publicState), persistence, expiry
src/stats.ts      results + hours rounding (ceil with float guard)
src/jira.ts       Jira Cloud REST v3 client (read + optional write-back)
src/config.ts     env configuration
public/           index.html, styles.css, app.js (no build step)
test/             unit.mjs, e2e.mjs, mock-jira.mjs, screenshots.mjs
```


### Prefill and bookmarklet tests
Unit tests cover the `/new` ticket sanitizer (verbatim URLs, dedupe, order, 200 cap, XSS-ish input). The e2e test covers `/new`, `/api/prefill` (repeated params, ignored entries, cap, JQL gated by the admin password). `node test/bookmarklet.mjs` (needs Playwright, set `PLAYWRIGHT_PATH`) runs the real bookmarklet code on a fake Jira-like page, checks the prefilled form, starts a session and asserts the history table columns.

### Bookmark code
`/bookmarklet.html` generates this for your origin (shown here for `http://localhost:8080`). With no tickets on the page it shows the alert, then opens the app home page in a new tab:
```
javascript:(()=>{const s=new Set();document.querySelectorAll('a[href*="/browse/"]').forEach(a=>{const m=a.href.match(/^(https:\/\/[^/]+\/browse\/[A-Z][A-Z0-9]+-\d+)/);if(m)s.add(m[1]);});if(!s.size){alert('No Jira tickets found on this page');window.open('http://localhost:8080/','_blank');return;}window.open('http://localhost:8080/new?tickets='+encodeURIComponent([...s].join(',')),'_blank');})();
```
The session name defaults to `Estimation session` (set `DEFAULT_SESSION_NAME` to change it; editable; also used when left blank), and the empty ticket box shows two example ticket URLs (`https://url1`, `https://url2`).

### UPDATE Jiras tests
Unit: status transitions (not sent / updated / changed / restored / failed). E2E against the Jira mock (with forced 403 and field-not-on-screen failures, 429 with Retry-After, concurrency cap): success, failure text, retry failed with same fields, skip already updated, re-send, changed-since-update, admin-only enforcement, unconfigured 503 + `/api/jira/status`, persistence, no token in logs. Playwright: confirm dialog, status column, voter read-only view, disabled button when Jira is not configured.

### Caching and configuration tests
E2E: HTML served `no-cache` with `?v=<content hash>` references for `app.js`, `styles.css`, `favicon.svg` and `bookmarklet.js` (hash = sha256 of the file, first 12 hex chars); versioned requests are `immutable`, unversioned and stale-hash requests `no-cache`; `/healthz` and `/api/config` report the package version; `DEFAULT_SESSION_NAME` sets the start-form default (HTML-escaped) and the blank-name fallback.

### Hours rounding and rate tests
Unit: hours rounded UP to the next 0.5h (21.33 → 21.5, 2.2 → 2.5, 2.6 → 3, 20 → 20, float guard 31.9999… → 32), other steps (1, 0.25), Jira duration strings (`32h`, `21h 30m`, `30m`), rate validation (multiples of 0.5 between 0.5 and 100). E2E: rate spin buttons (`type=number step=0.5 min=0.5 max=100`) on the start form and in Settings; `POST /api/sessions` rejects rates 2.3 / 0 / 0.25 / 101 with 400; `setRate 3.3` returns an `invalid_rate` error and leaves the rate unchanged; rate 2.5 × 3 SP = 7.5h stored, totalled and sent to Jira as `7h 30m`; `/api/config` exposes `hoursRoundingStep`.

### Board picker tests
UI (Playwright, `PLAYWRIGHT_PATH=… node test/board-picker.mjs` after `npm run build`): project prefilled as `KEY - Name`, project dropdown on click with All projects, filter by key/name, keyboard pick reloads boards, board dropdown on click, keyboard/mouse pick, kanban message, Project above Board, no Open sprint button.

E2E against the Jira mock (60 projects, 64 boards incl. one kanban): the project list joins both pages (`startAt` 0, 50), is cached and needs the admin token; name search is a contains match with paging (`startAt` 0, 50), project filter, scrum boards first, invalid project key 400, admin token required; the sprint endpoint of a kanban board answers 400 with a friendly message; `JIRA_DEFAULT_BOARD` resolves an exact case-insensitive name before a contains match, honours `JIRA_DEFAULT_BOARD_PROJECT`, accepts a numeric id, and `JIRA_DEFAULT_BOARD_ID` still works as an alias.

### Jira update mode and remaining estimate tests
Unit: `JIRA_UPDATE_DEFAULT_MODE` parsing (`sp`/`time`/`both`, case-insensitive, invalid → `both` with a warning), remaining-estimate math (nothing logged, partial, logged over the estimate → `0m`). E2E: the configured mode is preselected on the start and session pages and reported by `/api/config`; time writes read `timeSpentSeconds` first and send `originalEstimate` + `remainingEstimate` in one PUT (4h with 0 / 1h 30m / 17m / 5h logged → `4h` / `2h 30m` / `3h 43m` / `0m`); `JIRA_RECALC_REMAINING=false` sends the Original estimate only and skips the read.
