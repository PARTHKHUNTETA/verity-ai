# VerityAI — Backend

> **VerityAI — Evaluated Research Agent** · _Research with evidence. Answers with confidence._

API and (from Phase 4) worker for VerityAI: a modular Node.js + TypeScript monolith with PostgreSQL + pgvector.
Design docs live in [`../docs`](../docs): [system design](../docs/system-design.md), [database design](../docs/db-design.md), [project plan](../docs/project-plan.md).

## Requirements

- Node.js 22+
- Docker Desktop (for Postgres + pgvector)

## Getting started

```bash
cp .env.example .env      # local settings (already matches docker-compose.yml)
npm install
npm run db:up             # start Postgres + pgvector on localhost:5433
npm run db:migrate        # apply migrations
npm run dev               # API on http://localhost:4000
npm run worker            # in a second terminal: runs research jobs
```

**LLM provider:** `.env.example` uses `LLM_PROVIDER=openai`, which needs `OPENAI_API_KEY`. For free local
testing set `LLM_PROVIDER=fake`, which streams a canned answer. The model is set by `OPENAI_MODEL` (default `gpt-5-mini`).
Cost tracking uses `src/infrastructure/llm/pricing.ts`; verify those prices against OpenAI's pricing page.

**Discovery:** runs search arXiv by default (no key needed). For web search set `WEB_SEARCH_PROVIDER=tavily`
and `TAVILY_API_KEY`. Fetched URLs go through an SSRF-safe fetcher; block or allow domains with
`BLOCKED_DOMAINS` / `ALLOWED_DOMAINS`.

Check it works:

```bash
curl http://localhost:4000/api/v1/health
# {"status":"ok","db":"ok",...}
```

## Scripts

| Script                                  | What it does                                                                     |
| --------------------------------------- | -------------------------------------------------------------------------------- |
| `npm run dev`                           | Start the API with auto-reload (tsx watch)                                       |
| `npm run build` / `npm start`           | Compile to `dist/` / run the compiled server                                     |
| `npm test`                              | Run Vitest tests (needs `npm run db:up`; uses a separate `verity_test` database) |
| `npm run typecheck` · `lint` · `format` | TypeScript check · ESLint · Prettier                                             |
| `npm run db:up` / `db:down`             | Start / stop the Postgres container                                              |
| `npm run db:generate`                   | Create a migration from schema changes (review the SQL before committing)        |
| `npm run db:migrate`                    | Apply pending migrations                                                         |
| `npm run db:studio`                     | Browse the database in Drizzle Studio                                            |

For a hand-written migration (extensions, partitions, roles): `npx drizzle-kit generate --custom --name=<name>`.

## API (so far)

| Method                | Path                                                     | Auth                    |
| --------------------- | -------------------------------------------------------- | ----------------------- |
| GET                   | `/api/v1/health`                                         | public                  |
| POST                  | `/api/v1/auth/register` · `login` · `refresh` · `logout` | public / refresh cookie |
| GET                   | `/api/v1/me`                                             | Bearer token            |
| GET                   | `/api/v1/organization` · `/organization/members`         | `member:read`           |
| POST · PATCH · DELETE | `/api/v1/organization/members[/:userId]`                 | `member:manage`         |

Access tokens (15 min) go in `Authorization: Bearer <token>`. The refresh token lives in the httpOnly
`verity_refresh` cookie and is rotated on every `/auth/refresh`. Roles and permissions:
`src/modules/policies/permissions.ts`.

## Project structure

```
src/
├── app.ts                 # builds the Express app (createApp) — used by server and tests
├── server.ts              # starts HTTP, graceful shutdown
├── worker.ts              # research worker: pg-boss consumer + agent runtime
├── config/env.ts          # all env vars, validated with zod at startup
├── middleware/            # request-id, request-logger, authenticate, require-permission,
│                          # validate, rate-limit, not-found, error-handler
├── modules/               # one folder per feature (routes → controller → service → repository)
│   ├── health/            # GET /api/v1/health (Phase 1)
│   ├── auth/              # register, login, refresh rotation, logout, /me (Phase 2)
│   ├── organizations/     # current org + member management (Phase 2)
│   ├── sources/           # collections, uploads, documents, search API (Phase 5)
│   ├── retrieval/         # parsing (PDF/HTML/text), chunking, ingestion, hybrid search, acquisition
│   ├── tools/             # search providers (Tavily, arXiv, Semantic Scholar) (Phase 6)
│   ├── audit/             # append-only audit log writer (Phase 2)
│   ├── policies/          # permissions.ts: RBAC matrix (Phase 2); policy gateway (Phase 8)
│   └── research/ agent/ tools/ policies/ retrieval/ evaluation/ observability/ reports/
├── infrastructure/
│   ├── database/          # drizzle client, schema/, migrations/
│   ├── llm/               # LLM interface, OpenAI + fake providers, pricing
│   ├── queue/             # pg-boss job queue (research.run, source.ingest)
│   ├── storage/           # file storage (local disk)
│   ├── http/              # SSRF guard + safe fetcher for untrusted URLs
│   └── events/            # run events over Postgres LISTEN/NOTIFY
├── shared/                # errors, logger
├── types/                 # type augmentations
├── utils/
└── tests/                 # cross-module tests (unit tests sit next to their code)
```

## Conventions

- **Errors:** throw `AppError` subclasses from `shared/errors.ts`. Responses always look like
  `{ "error": { "code", "message", "details"?, "requestId" } }`. Unexpected errors become a 500 without leaking details.
- **Request ids:** every response has an `X-Request-Id` header. It appears in every log line and in error bodies.
- **Database:** UUID v7 ids, `timestamptz` timestamps, snake_case columns (see `docs/db-design.md` §3). Never edit an applied migration; add a new one.
- **Imports:** ESM with `.js` extensions in relative imports (required by Node's ESM resolution).
