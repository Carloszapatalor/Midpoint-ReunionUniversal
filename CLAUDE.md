# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- `deno task dev` — run server with `--watch` on `http://localhost:8000` (override with `PORT=...`).
- `deno task start` — run server without watch.
- `deno task test-turso` — sanity-check `TURSO_URL` / `TURSO_AUTH_TOKEN` by hitting the DB HTTP endpoint.

All tasks load env from `.env` via `--env-file`. Copy `.env.example` → `.env` and fill `TURSO_URL` (libsql HTTP URL, e.g. `https://...turso.io`) and `TURSO_AUTH_TOKEN`. No separate build, lint, or test commands exist.

## Architecture

Single-process Deno app: `main.ts` (Hono) serves JSON APIs under `/api/*` and falls through to `serveStatic({ root: "./public" })` for the browser UI. There is no bundler; `public/app.js` runs as-is in the browser.

### Data layer — `torso.ts`

The app talks to Turso over plain HTTP (POST `TURSO_URL` with `{ statements: [...] }`), not via a client library. Two important quirks encoded here that new code should preserve:

- **Batch response shape is inconsistent.** `getMeetingTorso` deliberately issues two separate single-statement requests (meeting then participants) instead of one batch, because Turso returns batches as `[{results:[stmt1]}, {results:[stmt2]}]` rather than a single merged object. `unwrapTursoPayload` + `getFirstResult` assume one statement per call.
- **Schema is lazy-initialized.** Every public function awaits `ensureSchema()`, which runs `CREATE TABLE IF NOT EXISTS` + indexes exactly once per process via a memoized `schemaPromise`. Do not rely on migrations existing elsewhere.

Schedules (`local_schedule`, `utc_schedule`) are stored as JSON-stringified arrays in TEXT columns; `parseSchedule` tolerates both arrays and JSON strings when reading. Participants are upserted with `ON CONFLICT(uid) DO UPDATE`, with a pre-check for nick collisions that throws `"... ya esta en uso ..."` — `main.ts` maps that substring to HTTP 409 and `"no existe"` to 404.

### Frontend — `public/app.js`

Vanilla JS, no framework. State is three module-level variables: `currentMeeting`, `currentUser`, `localSchedule`. The meeting UID travels in the URL as `?meeting=<uid>`; per-meeting session (participant uid + nick) is persisted in `localStorage` under `agenda:meeting:<uid>:participantUid` and `:session`.

**UTC aggregation is computed client-side.** `toUtcSlot(day, hour)` anchors each weekday/hour pair to a fixed reference Monday (`2025-01-06`) and converts through the browser's timezone to a `utcDay-utcHour` string. `buildUtcAggregate` sums these across all participants to color the right-hand grid; the current user's unsaved edits are merged into the aggregate before rendering so the UI reflects pending changes. `startAutoRefresh` re-fetches the meeting every 15s (skipped when `document.hidden`).

### API surface

All under `/api/meetings`:
- `POST /` — create meeting from `{ title }`.
- `GET /:meetingUid` — meeting + participants; returns `{ exists: false }` with 404 when missing.
- `GET /:meetingUid/participants/uid/:uid` and `.../nick/:nick` — lookup helpers used for session restore and login.
- `POST /:meetingUid/participants` — upsert participant schedule.
