# Plinglist

> *"Pling. Done. – The simple to-do list that stays."*

[![License: AGPLv3](https://img.shields.io/badge/License-AGPLv3-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/Node.js-22%20LTS-339933.svg?logo=node.js&logoColor=white)](Dockerfile)
[![Docker](https://img.shields.io/badge/Docker-Ready-2496ED.svg?logo=docker&logoColor=white)](docker-compose.yml)
[![i18n](https://img.shields.io/badge/i18n-English%20%7C%20Deutsch-0d6b58.svg)](app/src/i18n.ts)

Plinglist is a fast, local-first, bilingual (EN/DE) successor to **Wunderlist** and **Microsoft To Do** (ahead of the June 30, 2027 Microsoft To Do shutdown).

- **Local-First & Offline-Ready:** Instant startup (`< 200 ms`), synchronous local writes (`localStorage`), deterministic field-level Last-Write-Wins (HLC) delta sync (`lastPushedHlc`), and `Service Worker` offline support (`sw.js`).
- **6 Smart & Custom Views (Strict YAGNI):** *My Day / Mein Tag* (midnight reset + smart suggestions), *Starred / Wichtig*, *Planned / Geplant* (with recurrences), *All / Alle*, *Tasks / Aufgaben*, and *Custom & Shared Lists* (`?join=`), plus debounced live search (`?q=`) and URL state persistence (`?view=`).
- **Zero-Auth Device Pairing & GDPR Privacy:** Pair devices via Sync-Key (`?pair=`), toggleable Cloud Sync (optional `Local-Only` mode), automatic GDPR tombstone content scrubbing on delete, and 1-click workspace erasure (`DELETE /api/v1/sync`).
- **1-Click Migration:** Built-in importers for **Wunderlist (JSON)** and **Microsoft To Do (JSON & CSV)**.
- **Open Core + Self-Hostable:** Defaults to same-origin sync (`getDefaultServerUrl()`) or a configurable custom `Server URL` via `docker compose` (SQLite WAL).

---

## Repository Layout

```text
plinglist/
├── packages/core/       # HLC clock, field-level LWW merge, view/search selectors & JSON/CSV importers
├── server/              # Node 22 HTTP static + SQLite WAL sync server & invite endpoints
│   └── src/
│       ├── config.ts
│       ├── index.ts     # HTTP server (/api/health, /api/v1/sync [POST/DELETE], /api/v1/invites, /join/:token, 404)
│       ├── sqlite-repo.ts
│       └── sync-engine.ts
├── app/                 # Bilingual local-first Web-App & PWA (index.html, styles.css, store.ts, web-app.ts)
├── scripts/             # Zero-dependency TypeScript-stripping build script (build-app.mjs)
├── ARCHITECTURE.md      # Technical architecture, HLC sync & SQLite WAL schema
├── CHANGELOG.md
├── Dockerfile
└── docker-compose.yml
```

*(Note: Official managed cloud billing, push notification relay, and protected brand assets reside in the private `plinglist-cloud` repository under `./cloud/`, which is gitignored here.)*

---

## Quick Start (Development & Tests)

Requires **Node.js 22+**.

```bash
# Run the test suite across core, server, and app (36 tests)
npm test

# Build the browser bundle into app/dist/
npm run build

# Build and preview locally on http://localhost:8080
npm run preview
```

## Self-Hosting with Docker

```bash
cp server/.env.example server/.env
docker build -t plinglist-app .
docker run -d -p 3001:3001 -v $(pwd)/data:/app/data --name plinglist-app plinglist-app
```

Or via `docker compose`:

```bash
docker compose up -d --build
```

---

## Documentation & Governance

- [ARCHITECTURE.md](ARCHITECTURE.md) — System diagram, HLC conflict resolution, SQLite WAL schema, and API contract
- [CHANGELOG.md](CHANGELOG.md) — Release history (`v0.1.0` – `v0.1.19`)
- [CONTRIBUTING.md](CONTRIBUTING.md) — Coding, TDD, and i18n guidelines
- [SECURITY.md](SECURITY.md) — Vulnerability disclosure policy
- [TRADEMARK.md](TRADEMARK.md) — Mandatory rebranding policy for forks and public deployments

---

## License & Trademark

- **Source Code:** Licensed under the [GNU Affero General Public License v3.0 (AGPLv3)](LICENSE) with Section 7 digital distribution exceptions.
- **Trademarks & Brand Assets:** The name **"Plinglist"**, slogan **"Pling. Done."**, official icons/logos, `de.goork.plinglist` identifiers, and the original "Pling" sound effect are **excluded** from the open-source license. See [TRADEMARK.md](TRADEMARK.md) for details.
