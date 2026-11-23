# Plinglist

> *"Pling. Done. – The simple to-do list that stays."*

Plinglist is a fast, local-first, bilingual (EN/DE) successor to **Wunderlist** and **Microsoft To Do** (ahead of the June 30, 2027 Microsoft To Do shutdown).

- **Local-First & Offline-Ready:** Instant startup (`< 200 ms`), immediate local writes, and deterministic field-level Last-Write-Wins (HLC) delta sync.
- **4 Classic Views (Strict YAGNI):** *My Day / Mein Tag* (midnight reset + smart suggestions), *Starred / Wichtig*, *Planned / Geplant*, and *Lists / Shared Lists*.
- **1-Click Migration:** Built-in importers for **Wunderlist (JSON)** and **Microsoft To Do (JSON/Graph export)**.
- **Open Core + Self-Hostable:** Use locally for free on one device or self-host your own sync server via `docker compose`. Configurable `Server URL` (default: `https://api.plinglist.app`).

---

## Repository Layout

```text
plinglist/
├── packages/core/   # Local-first data model, HLC LWW merge, view selectors & importers
├── server/          # Lightweight self-hosted delta-sync server (SQLite WAL + WebSockets)
├── app/             # Bilingual client core (Web/PWA + Capacitor 7 mobile)
└── docker-compose.yml
```

*(Note: Official managed cloud billing, push notification relay, and protected brand assets reside in the private `plinglist-cloud` repository under `./cloud/`, which is gitignored here.)*

---

## Quick Start (Development & Tests)

Requires **Node.js 22+**.

```bash
# Run the test suite across core, server, and app
npm test
```

## Self-Hosting with Docker Compose

```bash
cp server/.env.example server/.env
docker compose up -d --build
```

---

## License & Trademark

- **Source Code:** Licensed under the [GNU Affero General Public License v3.0 (AGPLv3)](LICENSE) with Section 7 digital distribution exceptions.
- **Trademarks & Brand Assets:** The name **"Plinglist"**, slogan **"Pling. Done."**, official icons/logos, `de.goork.plinglist` identifiers, and the original "Pling" sound effect are **excluded** from the open-source license. See [TRADEMARK.md](TRADEMARK.md) for mandatory rebranding rules when forking or redistributing.
