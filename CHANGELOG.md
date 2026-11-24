# Changelog

All notable changes to **Plinglist** are documented in this file.

## [0.1.8] - 2026-11-24

### Fixed
- **Multi-Device Pairing & Duplicate Default Lists (`app/src/store.ts`, `app/src/web-app.ts`):** Added `consolidateWorkspaceLists()` on load, `setSyncKey()`, and `applyServerSync()` to merge legacy `list-tasks` / `list-groceries` and any duplicate workspace default lists into a single canonical pair (`list-tasks-<suffix>` / `list-groceries-<suffix>`) while remapping tasks cleanly. Also read `?pair=` before initializing `PlinglistStore` so fresh/incognito browsers never seed throwaway workspace IDs first. Service Worker bumped to `plinglist-app-v6`.
- **Legacy Ownership Upgrade & Monotonic Server Watermark HLC (`server/src/sqlite-repo.ts`, `server/src/sync-engine.ts`):** Upgraded `owner_sync_key` from legacy `userId` (`usr-*`) to `syncKey` (`pling-*`) on sync and advanced the stored sync watermark HLC via a server `HlcClock` whenever newly inserted or modified records arrive with an older client/offline timestamp, preventing paired devices from missing older tasks.

## [0.1.7] - 2026-11-24

### Fixed
- **CSS `[hidden]` Specificity (`app/styles.css`):** Added `[hidden] { display: none !important; }` so `.btn-icon { display: inline-grid; }` no longer reveals hidden list action icons inside *My Day*, *Starred*, *Planned*, or *Tasks*.
- **MS To Do Parity & Shared List Delete Guard (`app/src/store.ts`, `app/src/web-app.ts`):** Smart views (*My Day*, *Starred*, *Planned*) and the default *Tasks / Aufgaben* inbox (`list-tasks` / `list-tasks-*`) can no longer be renamed, deleted, or shared (and any legacy shared flag on the default tasks list is sanitized on load/sync). Actively shared custom lists cannot be deleted until sharing is stopped via *Stop sharing / Freigabe beenden*.

### Added
- **Device Pairing Link in Settings (`app/index.html`, `app/src/web-app.ts`):** Added `#copySettingsPairUrlBtn` next to the Sync Key inside Settings so device pairing (`?pair=`) remains accessible even when viewing *My Day* or *Tasks*. Service Worker bumped to `plinglist-app-v5`.

## [0.1.6] - 2026-11-24

### Added
- **Unshare Lists & Read-Only Share Modal Preview (`app/src/store.ts`, `app/src/web-app.ts`):** Added `unshareList()` (clears `shared` & `inviteToken` via HLC and invalidates the server invite token on sync) and `getInviteUrl()`. Opening `#shareDialog` or switching lists in `#shareListSelect` no longer marks lists as shared until the user explicitly clicks *Copy link* or *Share…*, and shared lists show a *Stop sharing / Freigabe beenden* button.

### Changed
- **Decluttered Header (`app/index.html`, `app/styles.css`, `app/sw.js`):** Replaced the prominent *Rename* and *Delete list* text buttons with subtle SVG icon buttons (`.btn-icon`), removed the redundant `DE / EN` header button (language remains in *Settings*), and bumped Service Worker cache to `plinglist-app-v4`.

## [0.1.5] - 2026-11-24

### Added
- **SVG Favicon & PWA Icon (`app/favicon.svg`, `app/manifest.webmanifest`):** Added crisp green checkmark SVG favicon (`#0d6b58`), copied into `app/dist/favicon.svg` via `scripts/build-app.mjs`, and precached in `app/sw.js` (`plinglist-app-v3`).

### Changed
- **Protected Default Tasks List (`app/src/store.ts`, `app/src/web-app.ts`):** Added `isSystemTasksList()` so the initial *Aufgaben / Tasks* inbox list (fallback target for Quick-Add from *My Day* / *Starred* / *Planned*) cannot be renamed or deleted, while custom lists and the seeded *Einkauf / Groceries* list remain editable/deletable.
- **Settings-Integrated Migration (`app/index.html`, `app/styles.css`, `app/src/web-app.ts`):** Moved the one-time Wunderlist / MS To Do import trigger from the sidebar footer into the `#settingsDialog` modal for a cleaner daily UI.

## [0.1.4] - 2026-11-24

### Added
- **Custom List Rename & Soft-Delete (`app/src/store.ts`, `app/src/web-app.ts`):** Added `renameList` (`#renameListDialog`) and `deleteList` (HLC soft-delete propagating to list tasks while guarding the last remaining list) with bilingual EN/DE strings.
- **Local Reminder Notifications (`packages/core/src/views.ts`, `app/src/web-app.ts`):** Added `getDueReminderTasks` and browser toast + chime + Web `Notification` dispatch for due `reminderAt` timestamps.
- **Cloud Entitlement Persistence & Billing Webhooks (`server/src/sqlite-repo.ts`, `server/src/index.ts`):** Added SQLite `entitlements` table, `POST /api/v1/cloud/webhooks/stripe` & `/api/v1/cloud/webhooks/revenuecat` handlers with optional `CLOUD_WEBHOOK_SECRET` bearer verification, and `CLOUD_ENFORCE_ENTITLEMENTS` guard wiring.
- **Brand Audio Overlay Runtime Support (`scripts/build-app.mjs`, `app/src/web-app.ts`):** `build-app.mjs` now copies `app/public/` into `app/dist/` and `playPlingChime()` loads `./audio/pling.wav` into an `AudioBuffer` when present, falling back to the CC0 synth.

### Fixed
- **Same-Origin Default Server URL (`app/src/config.ts`, `app/src/store.ts`):** Added `getDefaultServerUrl()` so web/PWA deployments default to `window.location.origin` (same-origin sync out of the box) and fall back to `https://api.plinglist.app` for non-web/Capacitor origins.
- **Offline-Complete Service Worker (`app/sw.js`):** Expanded `ASSETS` precache (`plinglist-app-v2`) to include all compiled ES modules under `app/src/` and `packages/core/src/`, added old-cache cleanup on `activate`, and bypassed cache interception for `/api/` and `/join/`.
- **Self-Contained Docker Compose (`docker-compose.yml`):** Replaced the unbuilt 2-container setup with a single self-contained `plinglist-app` service (`build: .`).

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
