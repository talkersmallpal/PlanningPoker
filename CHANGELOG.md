# Changelog

Newest first. Full release notes: `release-notes/<version>/RELEASE_NOTES.md`.

## 1.0.0 - 2026-11-26

First release: self-hosted, Jira-integrated planning poker.

### New
- Admin-started sessions (optional `ADMIN_PASSWORD`) with an invite link; members register by name, live participant list, identity kept across refreshes.
- Ticket queue from pasted Jira URLs (shown verbatim as new-tab links) or keys; optional "Load from Jira" by JQL or by sprint of a board picked by name (dropdowns that open on click: a Project list shown as `KEY - Name` above a board list of that project, scrum boards first, default via `JIRA_DEFAULT_BOARD` / `JIRA_DEFAULT_BOARD_PROJECT`); start, reorder, skip, put back, edit, remove and add tickets.
- Hidden votes until reveal (only "has voted" is shared); auto-reveal when every online voter has voted, early reveal and re-vote; named votes, histogram and stats on reveal.
- Agreed story points pre-filled with the deck card nearest the median (ties go up); hours = agreed SP × rate, rounded up to the next half hour (`HOURS_ROUNDING_STEP`); hours per story point in 0.5 steps (0.5–100), validated by the server; editable finished tickets.
- Session history with agreed SP, hours, rate, Jira status and session totals; CSV copy / download.
- Admin-only **UPDATE Jiras** batch: story points, Original estimate (`21h 30m` format) or both; confirmation dialog, per-ticket status (Not sent / Updated / Failed / Changed since update), default selection set by `JIRA_UPDATE_DEFAULT_MODE` (`sp` | `time` | `both`, default `both`, changeable per update), Remaining estimate recalculated as max(0, new original − time logged) in the same edit (`JIRA_RECALC_REMAINING`, default `true`), re-send and retry failed, concurrency 3 with 429 `Retry-After` handling; `GET /api/jira/status`. Optional per-ticket Save to Jira (`JIRA_WRITE_BACK`).
- `/new?tickets=` prefill links (with optional `&jql=`) and a **Planning Poker** bookmarklet (`/bookmarklet.html`) to start a session from any Jira page.
- `GET /healthz` and `GET /api/config` with the app version; cache-busted static assets (no hard refresh after a deployment).
- Configuration through environment variables (`.env.example`), including `DEFAULT_SESSION_NAME`, `DEFAULT_RATE`, `JIRA_DEFAULT_JQL`, `JIRA_UPDATE_DEFAULT_MODE`, `JIRA_RECALC_REMAINING` and the Jira credentials; secrets stay server-side.
- Docker image (linux/amd64 and linux/arm64), Docker Compose file, Kubernetes manifests (`k8s/`, kustomize) and a README covering build, configuration and deployment.
