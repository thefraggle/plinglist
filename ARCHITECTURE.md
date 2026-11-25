# Architecture of Plinglist

Plinglist is a fast, local-first, bilingual (EN/DE) to-do list application designed as a lightweight successor to Wunderlist and Microsoft To Do. This document describes the architectural principles, component layout, conflict-free delta synchronization, and open-core boundaries.

---

## 1. Architectural Philosophy: Local-First & Strict YAGNI

- **Instant Local Execution:** Every read and mutation (`addTask`, `toggleTaskCompleted`, `addTaskStep`, `updateTask`) executes synchronously against local memory and `localStorage` (`< 16 ms` UI latency, `< 200 ms` cold start). Network synchronization runs strictly asynchronously in the background.
- **Offline-First Resilience:** Tasks can be created, checked off, starred, and edited without network connectivity. All mutations carry Hybrid Logical Clock (HLC) timestamps for deterministic merging upon reconnect.
- **Strict YAGNI Scope:** Six views (*My Day* with automatic midnight reset + smart suggestions, *Starred*, *Planned* with due dates & recurrences, *All*, *Tasks*, and *Custom / Shared Lists*) plus debounced live search (`filterTasksByQuery`) and URL state (`?view=&list=&q=&legal=`). No Kanban boards, no AI bloat.
- **Zero External Runtime Dependencies:** Built directly on Node.js 22 LTS (`node:http`, `node:sqlite`, `node:module.stripTypeScriptTypes`, `node:test`) and standard browser primitives (`<dialog closedby="any">`, Web Audio API, Service Worker, `color-scheme: light dark`, `light-dark()`).
- **Strict CSP Compatibility:** No inline `<script>` tags, no inline `style=""` attributes, and no external font/CDN dependencies.

---

## 2. System Overview

```mermaid
flowchart TB
    subgraph Clients["Client Layer (app/ & Capacitor 7 iOS / macOS / Android)"]
        WebUI["Web-App / PWA / Native WebView\n(index.html, styles.css, web-app.ts)"]
        Store["PlinglistStore\n(localStorage + Background Sync)"]
        Audio["Web Audio API Chime\n(Pure-Sine Pling / Brand Overlay)"]
        WebUI --> Store
        WebUI --> Audio
    end

    subgraph Core["Shared Core Engine (packages/core/)"]
        HLC["HlcClock + LWW Merge\n(mergeTaskLww, mergeListLww)"]
        Views["View & Search Selectors\n(My Day Reset, Suggestions, Recurrence, filterTasksByQuery)"]
        Importers["1-Click Importers\n(Wunderlist JSON, MS To Do JSON & CSV)"]
        Store --> HLC
        Store --> Views
        Store --> Importers
    end

    subgraph Server["Self-Hosted Sync Server (server/)"]
        HTTP["Node 22 HTTP Server\n(/api/health, /api/v1/sync, /api/v1/invites, 404)"]
        Repo["SqliteSyncRepository\n(node:sqlite WAL Mode)"]
        HTTP --> Repo
        Repo --> HLC
    end

    subgraph Cloud["Private Cloud Overlay (./cloud/, gitignored)"]
        Guard["CloudEntitlementGuard\n(Stripe / RevenueCat 15 EUR/yr | 39 EUR Lifetime)"]
        Push["Push Relay\n(APNs / FCM DE & EN Payloads)"]
        Assets["Brand Overlay Script\n(Official Pling Audio & Store Icons)"]
    end

    Store <-->|POST/DELETE /api/v1/sync + Invite Join| HTTP
    Guard -.->|Optional Pro Hook| Repo
    Assets -.->|Release Build Overlay| WebUI
```

---

## 3. Conflict-Free Offline Delta Sync (HLC + Field-Level LWW)

Plinglist uses **Hybrid Logical Clocks** (`packages/core/src/hlc.ts`) formatted as zero-padded lexicographical strings:

```text
<15-digit-wallMs>:<5-digit-counter>:<nodeId>
```

- **Monotonicity:** `HlcClock.now(wallMs)` and `HlcClock.receive(remoteHlc, wallMs)` advance monotonically even when a device's system clock drifts backwards.
- **Field-Level LWW (`mergeTaskLww`):** Each task stores `fieldHlcs` across 12 mergeable fields (`listId`, `title`, `completed`, `completedAt`, `starred`, `myDayDate`, `dueDate`, `reminderAt`, `recurrence`, `note`, `steps`, `deletedAt`). If Device A checks off a task offline while Device B updates its note offline, both changes survive cleanly on merge.
- **List-Level LWW (`mergeListLww`):** Merges `title`, `shared`, `inviteToken`, and soft-delete `deletedAt` by comparing record HLCs while retaining earliest `createdAt` and latest `updatedAt`.
- **Delta-Push Optimization (`lastPushedHlc`):** After initial workspace sync, `PlinglistStore.syncWithServer()` pushes only lists and tasks whose HLC exceeds `lastPushedHlc`, turning idle 15-second background polls (paused while the tab is hidden) into empty-body delta pulls.
- **GDPR Tombstone Content Scrubbing:** Deletions (`deleteTask`, `deleteList`) set `deletedAt` for reliable offline peer propagation while immediately clearing all personal content fields (`title`, `note`, `steps`, `dueDate`, `reminderAt`, `myDayDate`, `starred`) and updating their `fieldHlcs`. Users can also erase all local and server-stored workspace data via `DELETE /api/v1/sync` or switch to local-only mode (`syncEnabled = false`).

---

## 4. Data Model & SQLite WAL Schema

`SqliteSyncRepository` (`server/src/sqlite-repo.ts`) uses Node 22's built-in `node:sqlite` (`DatabaseSync`) with:

```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA busy_timeout = 5000;
```

- **`lists` table:** `(id TEXT PRIMARY KEY, owner_sync_key TEXT, invite_token TEXT, hlc TEXT NOT NULL, payload_json TEXT NOT NULL)` with indexes `idx_lists_invite` and `idx_lists_owner`.
- **`tasks` table:** `(id TEXT PRIMARY KEY, list_id TEXT NOT NULL, hlc TEXT NOT NULL, payload_json TEXT NOT NULL)` with index `idx_tasks_list_hlc`.
- **`entitlements` table:** `(user_key TEXT PRIMARY KEY, plan TEXT NOT NULL, expires_at_ms INTEGER, source TEXT NOT NULL, updated_at TEXT NOT NULL)` storing normalized Stripe/RevenueCat Pro states.
- **Atomic Sync Transactions:** `applyAndPullDeltas` wraps incoming list and task merges in `BEGIN IMMEDIATE ... COMMIT` (with `ROLLBACK` on error) so concurrent sync requests remain consistent.

---

## 5. HTTP API Contract

| Method & Path | Purpose | Notes |
| :--- | :--- | :--- |
| `GET /api/health` | Liveness & healthcheck | Returns `{ status: "ok", service: "plinglist-app", cloudExtensionEnabled }` |
| `POST /api/v1/sync` | Idempotent HLC delta push & pull | Validates payload schema/bounds, enforces source/target list ownership on task moves, rate-limited (240 req/min/IP), returns `403 PRO_ENTITLEMENT_REQUIRED` when `CLOUD_ENFORCE_ENTITLEMENTS=true` without active entitlement |
| `DELETE /api/v1/sync` | GDPR workspace erasure | Deletes all lists owned by `syncKey` / `userId`, their tasks, and entitlements, returning `{ ok: true, deletedLists }` |
| `POST /api/v1/invites/:token/join` | Resolve shared list invite | Rate-limited (60 req/min/IP); returns `{ list }` or `404 INVITE_NOT_FOUND` |
| `GET /join/:token` | Browser invite entry | `302` redirect to `${PUBLIC_BASE_URL}/?join=<token>` |
| `POST /api/v1/cloud/webhooks/stripe` | Cloud billing webhook (`CLOUD_EXTENSION_ENABLED=true`) | Verifies required `Bearer ${CLOUD_WEBHOOK_SECRET}` via `crypto.timingSafeEqual` (fail-closed), persists Stripe `pro_yearly` / `pro_lifetime` / `free` into `entitlements` |
| `POST /api/v1/cloud/webhooks/revenuecat` | Cloud billing webhook (`CLOUD_EXTENSION_ENABLED=true`) | Verifies required `Bearer ${CLOUD_WEBHOOK_SECRET}` via `crypto.timingSafeEqual` (fail-closed), persists RevenueCat `pro_yearly` / `pro_lifetime` / `free` into `entitlements` |
| `GET /` & static assets | App shell & static delivery | Sets `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Content-Security-Policy`, `Cache-Control`, and real `404` HTML/JSON responses |
| `OPTIONS /api/*` | CORS preflight | Returns `204` with `Access-Control-Allow-Origin: *` (`GET, POST, DELETE, OPTIONS`) |

---

## 6. Open-Core & Brand Separation

- **Public Repo (`plinglist`, AGPLv3):** Contains the complete local-first app (with `getDefaultServerUrl()` same-origin resolution, `isNativeShellOrigin()` / `getShareBaseOrigin()` for Capacitor 7 iOS, Mac Catalyst & Android `https://localhost`, `?join=`/`?pair=` URL extraction, and `plinglist://` deep links), core HLC engine, importers, CI/CD Capacitor wrapper workflows (`.github/workflows/build-ios-macos.yml`, `.github/workflows/build-android.yml`), and self-hosted SQLite WAL sync server. Uses a clean pure-sine Web Audio chime and no paywall enforcement by default.
- **Private Cloud Repo (`./cloud/`, gitignored):** Holds Stripe/RevenueCat entitlement checks (`CloudEntitlementGuard`), APNs/FCM push notification payload builders, Contabo deployment workflows, `generate-brand-icons.mjs` (Xcode `AppIcon.appiconset` for iOS/macOS, Android `mipmap-*` + adaptive foregrounds, PWA icons), Playwright/Pillow Store screenshot automation (`generate-appstore-screenshots.py`), App Store Connect & Google Play API sync scripts (`sync-appstore-metadata.mjs`, `sync-playstore-metadata.mjs`), and protected Plinglist trademarks/audio (`TRADEMARK.md`). During release builds, `apply-brand-overlay.sh` copies protected assets into `app/public/`, `ios/App/App/Assets.xcassets/AppIcon.appiconset/`, and `android/app/src/main/res/`, and `scripts/build-app.mjs` mirrors `app/public/` into `app/dist/`.
