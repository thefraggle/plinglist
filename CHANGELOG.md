# Changelog

All notable changes to **Plinglist** are documented in this file.

## [0.1.25] - 2026-11-25

### Deutsch
- Anonyme Diagnosedaten und Datenschutzerklärungen vereinheitlicht (jederzeit in den Einstellungen deaktivierbar).
- Zuverlässigere Übermittlung anonymer Nutzungszähler bei Verbindung mit der offiziellen Cloud.

### English
- Unified anonymous diagnostics and updated privacy disclosures (always opt-out capable in Settings).
- More reliable delivery of anonymous usage counters when connected to the official cloud.

## [0.1.24] - 2026-11-25

### Deutsch
- Verbesserte Gesten-Steuerung: Geöffnete Ansichten und das Listenmenü lassen sich jetzt per Zurück-Wischgeste oder Wischen nach links schließen; auf der Hauptansicht beendet Zurück-Wischen die App sauber.
- Noch zuverlässigere Öffnung von Kopplungs- und Einladungslinks direkt in der App.

### English
- Improved gesture navigation: Open dialogs and the lists menu can now be dismissed with the back gesture or a left swipe, and the back gesture cleanly exits from the main view.
- Even more reliable handoff when opening pairing and invite links directly in the app.

## [0.1.23] - 2026-11-25

### Deutsch
- Sofortige Aktualisierung abgehakter Aufgaben auf allen gekoppelten Geräten ohne Neuladen.
- Zuverlässigere Übernahme beim Antippen von Kopplungslinks direkt in die App.
- Einheitlicher App-Seitentitel auch beim Öffnen von Kopplungs- und Einladungslinks.

### English
- Instant updates for completed tasks across all paired devices without needing to reload.
- More reliable handoff when tapping pairing links directly into the app.
- Consistent app page title when opening pairing and invite links.

## [0.1.22] - 2026-11-25

### Deutsch
- Zuverlässigere Synchronisation nach dem Koppeln: Neue Aufgaben von einem gekoppelten Gerät erscheinen jetzt auch beim Neuladen sofort auf allen verbundenen Geräten.
- Automatische Aktualisierung der App-Oberfläche beim Bereitstellen neuer Versionen, damit keine veralteten Zwischenspeicherstände aktiv bleiben.

### English
- More reliable sync after pairing: New tasks added on a paired device now appear reliably across all connected devices, including after a reload.
- Automatic refresh of cached app assets when new updates are released so older versions do not stay active.

## [0.1.21] - 2026-11-25

### Deutsch
- Zuverlässigere Geräte-Kopplung: Beim Verbinden über einen Sync-Link oder Sync-Key werden alle Listen und Aufgaben sofort vollständig geladen und direkt angezeigt.
- Verbesserte Link-Vorschau beim Teilen von Listen und Kopplungslinks.
- Schneller Wechsel aus geöffneten Web-Links direkt in die installierte App.

### English
- More reliable device pairing: Connecting via a sync link or Sync Key now immediately loads and displays all your lists and tasks.
- Improved link previews when sharing lists and pairing links.
- Quick handoff from shared web links directly into the installed app.

## [0.1.20] - 2026-11-25

### Added
- **Android Google Play Release & Store Automation (`capacitor.config.json`, `.github/workflows/build-android.yml`):** Added Capacitor 7 Android configuration (`allowMixedContent: false`), adaptive/legacy launcher icons, `minSdkVersion 26` / `targetSdkVersion 36`, automatic Google Play `versionCode` resolution, and automated AAB + listing + 18 graphics sync.
- **Universal Links (iOS/macOS), Android App Links & Dynamic Open Graph Previews (`server/src/index.ts`, `server/src/config.ts`, `app/index.html`, `app/src/web-app.ts`):** Added `/.well-known/apple-app-site-association`, `/.well-known/assetlinks.json` (with Play App Signing + upload SHA-256 fingerprints), `@capacitor/app@7` `getLaunchUrl()` cold-start handling, `#nativeAppHandoffBanner` (*Open in App*), `og-image.png` (`1200×630`), and dynamic Open Graph previews (`noindex, nofollow`) for `?join=` and `?pair=` URLs.
- **Automated `v*` Tag Store Builds:** Enabled `on: push: tags: ['v[0-9]*']` in both `build-ios-macos.yml` (`macos-15-intel`, auto build number) and `build-android.yml` (`auto` versionCode).

### Fixed
- **Clean Device Pairing Session Replacement (`app/src/store.ts`, `app/src/web-app.ts`):** Switching `syncKey` via `?pair=` now discards throwaway local session data cleanly, aborts stale in-flight sync responses from the previous `syncKey`, accepts `?pair=` URLs in `#joinSharedListForm`, and fixes the missing `isNativeShellOrigin` import in `web-app.ts`.

## [0.1.19] - 2026-11-25

### Added
- **iOS, macOS & Android App Support (`capacitor.config.json`, `.github/workflows/build-ios-macos.yml`, `.github/workflows/build-android.yml`, `app/src/config.ts`, `app/src/store.ts`, `app/src/web-app.ts`, `app/index.html`, `app/styles.css`):**
  - Added Capacitor 7 configuration (`de.goork.plinglist`, `webDir: app/dist`, iOS custom scheme `Plinglist`, Android `allowMixedContent: false`) and manual `workflow_dispatch` CI workflows for archiving/signing/uploading iOS, Mac Catalyst (`.pkg`), and Android (`.apk` & `.aab`) builds to App Store Connect / TestFlight and Google Play.
  - Added `isNativeShellOrigin()`, `getShareBaseOrigin()`, `extractSyncKeyFromInput()`, and `extractInviteTokenFromInput()` so native iOS, macOS, and Android (`https://localhost`) WebViews sync against the configured backend, emit clean `https://plinglist.app/?join=` / `?pair=` share links, accept pasted `?pair=` / `?join=` URLs directly in-app, and handle incoming `plinglist://` deep links.
  - Added `#joinSharedListForm` in `#shareDialog`, `apple-mobile-web-app-*` PWA meta tags in `app/index.html`, and `env(safe-area-inset-top)` padding on `.sidebar` / `.main-view`.

### Changed
- **Crisp Pure-Sine "Pling" Audio (`app/src/audio.ts`, `app/src/web-app.ts`, `app/sw.js`):** Aligned the app completion chime (`880 Hz -> 1318.51 Hz` pure sine without triangle harmonics) and `pling.wav` overlay with the landing-page sound signature, and bumped Service Worker cache to `plinglist-app-v16`.

## [0.1.18] - 2026-11-24

### Security
- **Cross-Workspace Task Ownership & Isolated Imports (`server/src/sqlite-repo.ts`, `server/src/sync-engine.ts`, `app/src/store.ts`):** Blocked cross-workspace `tasks.id` hijacking/moves unless the caller is authorized for both source and target list, and namespaced deterministic Wunderlist/MS To Do importer IDs per workspace suffix while staying idempotent within the same workspace.
- **High-Entropy Capability Tokens (`app/src/store.ts`):** Upgraded `generateSyncKey()` (`pling-xxxxxx-xxxxxx-xxxxxx-xxxxxx`) and `createInviteToken()` (`inv-<24-hex>`) to 96-bit cryptographic entropy.
- **Fail-Closed Webhooks, Payload Validation, Rate Limiting & Security Headers (`server/src/index.ts`, `server/.env.example`):** Required non-empty `CLOUD_WEBHOOK_SECRET` with `crypto.timingSafeEqual`, validated `POST/DELETE /api/v1/sync` runtime payload schemas/bounds, added per-IP rate limiting for `/api/v1/sync` and `/api/v1/invites/*`, and enforced `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, and `Content-Security-Policy` headers.
- **`localStorage` Quota Resilience (`app/src/store.ts`):** Wrapped `localStorage.setItem` in `persist()` with error capture (`lastStorageError`) so `QuotaExceededError` or private browsing blocks do not crash in-memory updates.

## [0.1.17] - 2026-11-24

### Changed
- **Single-Line Sidebar Footer (`app/index.html`, `app/styles.css`, `app/sw.js`):** Removed the redundant GitHub icon from `.sidebar-legal-row` (GitHub remains linked in *Settings* and *Imprint*) and set `flex-wrap: nowrap` / `white-space: nowrap` so `© 2026 Goork · Impressum · Datenschutz` stays cleanly on one line. Bumped Service Worker cache to `plinglist-app-v15`.

## [0.1.16] - 2026-11-24

### Added
- **Complete Anonymous Diagnostic Funnel (`app/src/web-app.ts`, `app/sw.js`):** Added anonymous `trackDiagnostic()` counters (`task_created`, `list_created`, `list_shared` on native Share API, `list_joined`, and `device_paired` on manual Sync-Key change) strictly on `plinglist.app` when telemetry opt-out is not active. Bumped Service Worker cache to `plinglist-app-v14`.

## [0.1.15] - 2026-11-24

### Changed
- **Sidebar Footer & Inline Link Refinement (`app/index.html`, `app/styles.css`, `app/sw.js`):** Removed permanent underlines from `.sidebar-legal-row` (`.sidebar-legal-link`), linked `Goork` to `https://goork.de`, added a compact GitHub SVG icon link (`.sidebar-legal-icon`), and kept `.link-inline` strictly inline so imprint contact lines preserve natural line spacing. Bumped Service Worker cache to `plinglist-app-v13`.

## [0.1.14] - 2026-11-24

### Added
- **Live Search, URL State & List Selector (`packages/core/src/views.ts`, `app/index.html`, `app/src/web-app.ts`):** Added `filterTasksByQuery()` with a debounced search bar (`#taskSearchInput`, `?q=`), URL state persistence (`?view=`, `?list=`, `?legal=imprint|privacy`) with `popstate` support, and a list selector (`#detailListSelect`) inside `#taskDetailDialog`, plus list names, localized recurrences, and reminder indicators in `.task-meta`.
- **GDPR Cloud-Sync Toggle, Tombstone Scrubbing & Workspace Erasure (`app/src/store.ts`, `server/src/sync-engine.ts`, `server/src/sqlite-repo.ts`, `server/src/index.ts`):** Added `preferences.syncEnabled` (local-only mode), immediate personal content clearing on `deleteTask()` / `deleteList()`, `DELETE /api/v1/sync` (`deleteWorkspace` / `deleteCloudAndResetLocal()`), and expanded privacy disclosures (server logs, retention, Umami opt-out details, Art. 21 & supervisory authority rights).

### Changed
- **UI/UX, Accessibility & Performance Hardening (`app/styles.css`, `app/index.html`, `app/src/web-app.ts`, `app/sw.js`, `server/src/index.ts`):**
  - Switched light canvas to cool neutral `#f2f5f4` (synced with `manifest.webmanifest`), raised input border contrast (`--border-input`) and `--star-light` (`#b45309`) to WCAG AA, enforced 44px touch targets, added `data-loading` button spinners, and removed redundant `box-shadow` declarations on task rows/panels.
  - Added WAI-ARIA `role="tabpanel"` + arrow-key tablist navigation, `inert` + focus restoration for the mobile drawer, `aria-label`/`aria-pressed` on subtask controls, IME-safe `Enter` step creation (`!event.isComposing && event.keyCode !== 229`), and auto-save on `#taskDetailDialog` close.
  - Added delta-push tracking (`lastPushedHlc`), visibility-aware 15s background polling, locale-cached `applyTranslations()`, `<link rel="modulepreload">` tags, Service Worker `v12` (`ignoreSearch: true`), `Cache-Control` headers, true HTTP `404` responses, and toast feedback for clipboard fallbacks and invalid `?join=`/`?pair=` links.

## [0.1.13] - 2026-11-24

### Changed
- **Sidebar Footer & 2-Tab Legal Modal (`app/index.html`, `app/styles.css`, `app/src/i18n.ts`, `app/src/web-app.ts`, `app/sw.js`):** Refined the sidebar footer layout (`Einstellungen` / `Hilfe & Tour` + inline `Impressum` / `Datenschutz` links) and structured `#legalDialog` into two dedicated tabs.

## [0.1.12] - 2026-11-24

### Added
- **Help Modal, Imprint/Privacy Dialog & Opt-Out Diagnostics (`app/index.html`, `app/src/config.ts`, `app/src/store.ts`, `app/src/web-app.ts`, `app/src/i18n.ts`):** Added `#helpDialog`, `#legalDialog` (§ 5 DDG / § 18 Abs. 2 MStV & GDPR), and self-hosted Umami diagnostics strictly restricted to `plinglist.app` with an opt-out toggle in Settings (`isOfficialCloudOrigin`, permanently disabled when self-hosted).

## [0.1.11] - 2026-11-24

### Added
- **Readonly Sync Key Unlock & Guest Revocation Cleanup (`app/index.html`, `app/src/web-app.ts`, `app/src/store.ts`, `server/src/sync-engine.ts`, `server/src/sqlite-repo.ts`):** Protected `#settingsSyncKeyInput` as `readonly` with an explicit `#editSettingsSyncKeyBtn` unlock flow, and returned `revokedListIds` from sync so guests automatically remove unshared lists and their tasks.

## [0.1.10] - 2026-11-24

### Changed
- **Compact Tabbed Settings Modal (`app/index.html`, `app/styles.css`, `app/src/web-app.ts`):** Reorganized `#settingsDialog` into 3 compact no-scroll tabs (*General / Allgemein*, *Lists / Listen*, *Sync & Import*) with tighter checkbox spacing and smart error tab switching. Service Worker bumped to `plinglist-app-v8`.
- **50% Chime Volume (`app/src/audio.ts`, `app/src/web-app.ts`, `cloud/assets/audio/pling.wav`):** Lowered completion chime volume (`CHIME_MASTER_GAIN = 0.5`, halved `CC0_CHIME_NOTES` gains, and regenerated `pling.wav` at 50% amplitude) for a gentler feedback tone.

### Fixed
- **Legacy `api.plinglist.app` Server URL Migration (`app/src/store.ts`):** Automatically upgrades stored `https://api.plinglist.app` URLs to same-origin (`window.location.origin`) when running in a web browser context.

## [0.1.9] - 2026-11-24

### Added
- **Microsoft To Do Settings Parity & Preferences (`app/src/store.ts`, `app/index.html`, `app/src/web-app.ts`):** Added persistent `PlinglistPreferences` (`addNewTasksOnTop`, `moveStarredToTop`, `confirmBeforeDelete`, `autoAddDueTodayToMyDay`, `autoHideEmptySmartLists`, `showAllSmartList`), native `#confirmDeleteDialog` before deleting tasks or lists, optional `∞ All / Alle` smart view, manual **Sync now / Jetzt synchronisieren** button with status in Settings, and a version/privacy footer.
- **Core Selectors & Sorting (`packages/core/src/views.ts`):** Added `getAllOpenTasks()`, `sortTasksForView()` (starred-to-top), and `includeDueToday` support in `getMyDayTasks()` / `getMyDaySuggestions()`.
- **Official Brand Audio (`cloud/assets/audio/pling.wav`):** Generated 16-bit 44.1 kHz harmonic two-note bell chime for the private brand overlay and added an overtone harmonic to the public CC0 Web Audio fallback.

### Changed
- **Clean Sidebar & System Inbox Placement (`app/index.html`, `app/src/web-app.ts`, `app/sw.js`):** Moved the system *Aufgaben / Tasks* inbox (`⌂`) above the sidebar divider alongside *My Day*, *Starred*, *Planned*, and *All*, leaving only custom user lists below the divider. Hid the redundant `"Synchronisiert"` text below the Plinglist brand header while online (displayed only when offline, and inside Settings). Service Worker bumped to `plinglist-app-v7`.

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
