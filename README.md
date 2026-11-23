# Plinglist

> *"Pling. Done. – The simple to-do list that stays."*

[![License: AGPLv3](https://img.shields.io/badge/License-AGPLv3-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/Node.js-22%20LTS-339933.svg?logo=node.js&logoColor=white)](Dockerfile)
[![Docker](https://img.shields.io/badge/Docker-Ready-2496ED.svg?logo=docker&logoColor=white)](docker-compose.yml)
[![i18n](https://img.shields.io/badge/i18n-English%20%7C%20Deutsch-0d6b58.svg)](app/src/i18n.ts)

Plinglist is a fast, local-first, bilingual (EN/DE) successor to **Wunderlist** and **Microsoft To Do** (ahead of the June 30, 2027 Microsoft To Do shutdown).

- **Local-First & Offline-Ready:** Instant startup (`< 200 ms`), synchronous local writes (`localStorage`), and deterministic field-level Last-Write-Wins (HLC) delta sync.
- **4 Classic Views (Strict YAGNI):** *My Day / Mein Tag* (midnight reset + smart suggestions), *Starred / Wichtig*, *Planned / Geplant* (with recurrences), and *Lists / Shared Lists*.
- **1-Click Migration:** Built-in importers for **Wunderlist (JSON)** and **Microsoft To Do (JSON/Graph export)**.
- **Open Core + Self-Hostable:** Use locally for free on one device or self-host your own SQLite WAL sync server via `docker compose`. Configurable `Server URL` (default: `https://api.plinglist.app`).

---

## Repository Layout

```text
plinglist/
├── packages/core/       # HLC clock, field-level LWW merge, view selectors & JSON importers
├── server/              # Node 22 HTTP static + SQLite WAL sync server & invite endpoints
│   └── src/
│       ├── config.ts
│       ├── index.ts     # HTTP server (/api/health, /api/v1/sync, /api/v1/invites, /join/:token)
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
# Run the test suite across core, server, and app (17 tests)
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
- [CHANGELOG.md](CHANGELOG.md) — Release history (`v0.1.0` – `v0.1.1`)
- [CONTRIBUTING.md](CONTRIBUTING.md) — Coding, TDD, and i18n guidelines
- [SECURITY.md](SECURITY.md) — Vulnerability disclosure policy
- [TRADEMARK.md](TRADEMARK.md) — Mandatory rebranding policy for forks and public deployments

---

## License & Trademark

- **Source Code:** Licensed under the [GNU Affero General Public License v3.0 (AGPLv3)](LICENSE) with Section 7 digital distribution exceptions.
- **Trademarks & Brand Assets:** The name **"Plinglist"**, slogan **"Pling. Done."**, official icons/logos, `de.goork.plinglist` identifiers, and the original "Pling" sound effect are **excluded** from the open-source license. See [TRADEMARK.md](TRADEMARK.md) for details.
