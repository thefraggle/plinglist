# Contributing to Plinglist

Thank you for your interest in contributing to Plinglist!

## Core Principles
- **Strict YAGNI:** Keep the app focused on fast, reliable to-do lists (no AI bloat, no Kanban boards).
- **Local-First & Offline-Safe:** All mutations must succeed locally first and merge deterministically via HLC.
- **TDD & Immutable Tests:** Write failing tests first when fixing bugs or adding features. Do not weaken assertions to pass tests.
- **Bilingual (EN/DE):** Keep English and German translation keys strictly in sync.
- **Brand Assets:** Do not submit proprietary assets or trademarked brand graphics; see [TRADEMARK.md](TRADEMARK.md).

## Running Tests

```bash
npm test
```

## Commit Style
Use Conventional Commits (`feat:`, `fix:`, `test:`, `docs:`, `chore:`).
