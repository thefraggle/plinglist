# Changelog

All notable changes to **Plinglist** are documented in this file.

## [0.1.3] - 2026-11-24

### Added
- **1-Click Share & Device Pairing Modal (`#shareDialog`, `?join=`, `?pair=`):** Added unified share dialog in `app/index.html` and `app/src/web-app.ts` to invite collaborators to any list via `https://plinglist.app/?join=<token>` and pair your own phone & computer via `https://plinglist.app/?pair=<syncKey>` (including native OS `navigator.share` + clipboard copy + automatic `?pair=` handling on startup).
- **Mobile-First Navigation & Tactile UI Overhaul (`app/styles.css`):** Added off-canvas slide-over drawer (`#appSidebar` + backdrop) on `< 768px`, fixed bottom mobile tab bar (`My Day`, `Starred`, `Planned`, `Lists`), subtle layered shadows (`--shadow-xs`, `--shadow-sm`, `--shadow-dialog`), circular Wunderlist-style checkboxes, amber stars, and shortened button labels (`white-space: nowrap`).

## [0.1.2] - 2026-11-23

### Added
- **Zero-Auth Capability Sync (`syncKey` + `inviteTokens`):** Replaced static default list IDs with workspace-scoped IDs (`deriveWorkspaceSuffix`), added random `pling-xxxx-xxxx-xxxx` Sync-Keys for account-free multi-device pairing (`setSyncKey` + Settings UI), and enforced capability checks in `InMemorySyncRepository` and `SqliteSyncRepository` (`owner_sync_key` column + shared list `invite_token` validation).
- **Microsoft To Do / Outlook CSV Importer (`importMicrosoftToDoCsv`):** Added RFC 4180 CSV parser supporting both English comma-delimited and German semicolon-delimited (`DD.MM.YYYY`) exports with BOM stripping, quoted multi-line notes, starred importance, and due dates; auto-detected in `PlinglistStore.importJson()` and `#importFileInput` (`.json,.csv`).

## [0.1.1] - 2026-11-23

### Added
- **SQLite WAL Persistence (`server/src/sqlite-repo.ts`):** Replaced in-memory-only runtime storage with `SqliteSyncRepository` (`node:sqlite` in `WAL` mode, `BEGIN IMMEDIATE` transactions, `lists` & `tasks` tables).
- **List Sync & Shared List Invites:** Added `mergeListLww` in `@plinglist/core`, list delta synchronization in `POST /api/v1/sync`, `POST /api/v1/invites/:token/join`, and `GET /join/:token` browser redirect.
- **Client Background Sync (`app/src/store.ts`, `app/src/web-app.ts`):** Added `userId`, `cursorHlc`, `applyServerSync`, `syncWithServer`, `joinSharedListByToken`, debounced background sync on local mutations/reconnect/focus, and automatic `?join=<token>` handling on startup.
- **CORS Support:** Added `OPTIONS /api/*` preflight and `Access-Control-Allow-Origin: *` headers for cross-origin self-hosted and cloud API usage.

### Fixed
- **Strict CSP Compliance:** Replaced the remaining inline `textDecoration` style assignment on task steps in `app/src/web-app.ts` with CSS class `.step-title.is-completed` in `app/styles.css`.

## [0.1.0] - 2026-11-23

### Added
- **Repository & Licensing:** Initialized public AGPLv3 repository with Section 7 digital distribution permissions, Section 7(e) brand/audio exclusions, and `TRADEMARK.md`.
- **Core Engine (`packages/core/`):** Implemented `HlcClock`, field-level `mergeTaskLww`, 4 classic view selectors (*My Day* midnight reset + smart suggestions, *Starred*, *Planned*, *Lists*), `computeNextDueDate`, and 1-click Wunderlist & Microsoft To Do JSON importers.
- **Local-First Web App & PWA (`app/`):** Built responsive Anti-Slop UI with light/dark `color-scheme`, native `<dialog closedby="any">` modals, bilingual DE/EN dictionary with 100% key parity, CC0 Web Audio chime, `manifest.webmanifest`, and offline `sw.js`.
- **Build & Containerization:** Added `scripts/build-app.mjs` (Node 22 `stripTypeScriptTypes`), `Dockerfile`, `docker-compose.yml`, and HTTP health/sync server (`server/src/index.ts`).
