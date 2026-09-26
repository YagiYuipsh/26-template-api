# USThing-backend-test: Custom Event

A small Fastify + TypeScript service with MongoDB built in. Bun runs it and Biome keeps it tidy. With no configuration at all, dev and tests spin up a throwaway in-memory MongoDB, so `bun install && bun run dev` is genuinely all it takes to get going.

## What you need

Bun 1.4.2 or newer. Older versions break the MongoDB driver; 1.3.14 will not work. Docker is only worth installing if you want a database that survives restarts.

## Running it

```sh
bun install
bun run dev
```

That serves http://localhost:3000. The first run downloads an in-memory MongoDB binary, roughly 150 MB, once. After that it's cached and startup is quick. If you'd rather have persistent data:

```sh
cp .env.compose.example .env.compose
docker compose --env-file .env.compose up -d
```

## Environment

Everything here is optional. For host development, copy `.env.example` to `.env` and set what you need. For Docker Compose, copy `.env.compose.example` to `.env.compose` and pass it with `--env-file`.

| Variable | What it does |
| --- | --- |
| `MONGO_URI` | MongoDB URI for dev. Unset means in-memory. |
| `MONGO_TEST_URI` | Same thing, but for `bun test`. |
| `AUTH_SKIP` | Set to `true` to turn auth off locally. |
| `NODE_ENV` | Runtime environment; Compose defaults to `production`. |
| `FASTIFY_ADDRESS` | Address for the Fastify server to bind to. |
| `FASTIFY_PORT` | Port for the Fastify server to listen on. |

## Scripts

| Script | What it does |
| --- | --- |
| `bun run dev` | Dev server, watch mode, debug logs |
| `bun run start` | Same without watch, info logs |
| `bun run test` | Tests, with coverage |
| `bun run compile` | Type-check `src` and `test` with `tsc` |
| `bun run check` | Read-only formatting + lint check |
| `bun run lint` | Auto-fix lint issues |
| `bun run fmt` | Auto-format the repo |

## Auth

Setting `AUTH_SKIP=true` turns verification off completely. Scoped requests then come in as a fixed anonymous user (`{ username: "anonymous", name: null }`, plus an `X-Auth-Skip: true` response header), and stale tokens in your HTTP client stop causing mystery 401s.

## API docs

Swagger UI is at http://localhost:3000/documentation, Scalar at http://localhost:3000/reference.

Event list requests use cursor pagination. `limit` defaults to 50 and accepts values from 1 to 100. Results are ordered by `startsAt` and `_id`; the response contains `items` and a `nextCursor`. Pass the cursor back with the same `from`, `to`, and `title` filters to read the next page. `nextCursor` is `null` when there are no more results.

```sh
curl -H "Authorization: Bearer alice-dev-token" \
  "http://localhost:3000/event/?limit=20&title=planning"
```

## Where things live

```
src/
  app.ts                # Fastify app: options, plugins, routes
  options.ts            # Environment variable parsing
  plugins/
    auth.ts             # Bearer-token auth plugin + withAuth scope
    init-mongo.ts       # Collections and index bootstrap
    sensible.ts         # @fastify/sensible error helpers
  auth/
    users.ts            # Users and tokens
  routes/
    example/            # Public example route
    auth-example/       # Protected example route
test/
  routes/               # Route tests
  auth-schema.test.ts   # withAuth schema-merging contract tests
  init-mongo.test.ts    # MongoDB URI-defaulting tests
  mongo.test.ts         # Full-app boot + in-memory MongoDB wiring
  options.test.ts       # Env parsing tests
```

## Tests

`bun run test` runs everything. Route tests exercise plugins on bare Fastify instances; the event route tests and full-app smoke tests use isolated in-memory MongoDB instances. The full-app test explicitly leaves both Mongo URI options unset, so it does not connect to a database configured in `.env`. No running external service is required.

See [TESTING.md](TESTING.md) for the Task 1 test cases, requirement coverage, and known test boundaries.
