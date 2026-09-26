# Testing the Custom Timetable Service

This document describes how the tests support customizable timetable service. The tests exercise the HTTP API and the MongoDB-backed behavior; they do not require a running Docker stack.

## Run the checks

Requirements: Bun 1.4.2 or newer and the dependencies from `bun install`.

```sh
bun install
bun run test
bun run compile
bun run check
```

`bun run test` runs `bun test --coverage --timeout=60000 test`. To focus on the custom-event tests, run:

```sh
bun test test/routes/event-overlap.test.ts
```

The database tests start their own `mongodb-memory-server` instances. No manually started MongoDB or API process is needed. On a fresh machine, the first run may download a MongoDB binary (about 150 MB); later runs use its cache. The tests pass explicit in-memory configuration or create an isolated memory server, so they do not use a development database configured in `.env`.

## Test design

| File | What it exercises | Test boundary |
| --- | --- | --- |
| [`test/routes/event-overlap.test.ts`](test/routes/event-overlap.test.ts) | Event CRUD, overlap rules, optimistic versioning, concurrent requests, owner isolation, list filters, cursor pagination, title search, and iCalendar export | Fastify route plugin + real in-memory MongoDB. Each test clears the collection and seeds one Alice event. |
| [`test/mongo.test.ts`](test/mongo.test.ts) | Full application startup, autoloaded plugins, MongoDB collection access, `/health`, and the mounted event route | Full Fastify app + real in-memory MongoDB. |
| [`test/routes/auth-example.test.ts`](test/routes/auth-example.test.ts) | Bearer-token acceptance and rejection, public/protected route separation, and `authSkip` | Auth and example plugins on a small Fastify instance. |
| [`test/routes/auth-schema.test.ts`](test/routes/auth-schema.test.ts) | OpenAPI auth response schema merging and validation-error serialization | Auth, sensible, and Swagger plugins on a small Fastify instance. |
| [`test/options.test.ts`](test/options.test.ts) | Environment-option mapping and unset/blank values | Pure option loading; no server. |
| [`test/init-mongo.test.ts`](test/init-mongo.test.ts) | MongoDB connection-string database defaulting and malformed URI rejection | Pure URI transformation; no connection. |
| [`test/routes/example.test.ts`](test/routes/example.test.ts) | Template example success and error routes | Example and sensible plugins on a small Fastify instance. |

HTTP tests use `app.inject()`, which exercises Fastify routing, validation, authentication hooks, response serialization, the event service, and the repository without opening a network port. The event suite uses a real MongoDB query engine in memory rather than mocking repository results. This matters for date-range queries, owner filters, regular-expression escaping, and atomic version checks.

## Task 1 requirement coverage

| Task 1 requirement | Tests and assertions |
| --- | --- |
| Create, read, update, delete custom events | The event suite runs a complete POST → GET → PATCH → DELETE → GET lifecycle. It checks `201`, `200`, `204`, then `404`, along with returned IDs and updated fields. |
| Validate event data | Creation rejects empty or whitespace-only titles and trims valid titles. PATCH requires a version, rejects an empty update, and preserves the saved event after a rejected update. List queries reject malformed dates, invalid ranges, and invalid title search terms. |
| Prevent overlapping events | Creation covers partial overlap, containment, equal intervals, and both adjacent boundaries. Partial time updates check conflicts without changing the event. A title-only update verifies that the event does not conflict with itself. |
| Handle concurrent writes | Two simultaneous overlapping creates must produce one `201` and one `409`, with only one new matching document. Two simultaneous PATCH requests using the same version must produce one `200` and one `409`, leaving exactly one version increment. A sequential stale-version case checks the same API contract without concurrency. |
| Keep users' events separate | Alice's event does not block Bob from creating or updating at the same time. Bob cannot read or delete Alice's event. List tests filter by owner, including paginated pages. The export test places Bob's event *inside* Alice's requested time window and asserts that only Alice's matching iCalendar `UID` is exported. |
| Provide a minimal authorization handler | Tests cover missing credentials (`401`), an unknown token (`401`), a malformed header (`400`), a valid bearer token (`200`), an unprotected public route, and the local `authSkip` behavior. Schema tests check documented auth responses and normal validation errors. |
| Add a related extra feature | The `/event/export.ics` tests check the content type, download filename, calendar/VEVENT structure, owner and time filtering, text escaping, and UTF-8 line folding. List tests also cover time-window and title search. |
| Containerize the service | `compose.yaml` and `Dockerfile` are present, but the automated suite does not start Docker or verify a built image. This is a documented test boundary, not a passing container test. |

### Event query and pagination cases

Time filtering uses interval intersection: an event is included when it ends after `from` and starts before `to`. Tests cover the start and end boundaries, one-sided filters, a range on another day, an event crossing midnight, a timezone-offset input, chronological ordering, and owner isolation. Title search tests cover case-insensitive substrings, trimmed input, literal regular-expression characters, Chinese text, and the combination of title and time filters.

Pagination tests verify the default page size of 50, acceptance of pages up to 100 items, rejection of a limit above 100, and the `{ items, nextCursor }` response envelope. They follow multiple cursor pages and assert that records are not duplicated or omitted, including records with equal `startsAt` values where `_id` is the tie-breaker. They also reject malformed cursors, combine pagination with title filtering, and verify that Bob's records never appear in Alice's pages.

### iCalendar assertions

The export tests check `text/calendar; charset=utf-8`, `Content-Disposition`, the calendar envelope, a VEVENT, and a stable event `UID`. The filter test creates three relevant records: Alice's event inside the window, Bob's event inside the same window, and Alice's event outside the window. It asserts exactly one VEVENT and checks each `UID` separately. Another case checks escaping of commas, semicolons, backslashes, and newlines, plus the 75-byte physical-line limit with a long Chinese title.

## Latest local verification

Verified on 2026-09-26 with Bun 1.4.2:

| Command | Result |
| --- | --- |
| `bun run test` | 91 passed, 0 failed across 7 files; 97.34% line coverage and 92.03% function coverage. |
| `bun run compile` | Passed for application and test TypeScript. |
| `bun run check` | Passed for the repository. |

Coverage percentages show which code ran; they do not establish that every branch or failure mode has a useful assertion. The tests above provide the behavioral evidence.

## Known test boundaries

- The in-process user lock is tested with concurrent requests to one application instance. The suite does not establish overlap safety across multiple API instances or processes.
- Owner isolation is directly asserted for GET, DELETE, list, and iCalendar export. A cross-user PATCH rejection is not currently tested.
- Cursor pagination is tested as a keyset boundary across a changing in-memory collection, not as a repeatable snapshot across concurrent writes. Inserts or updates between pages can change later page contents.
- The suite does not build or start the Docker image. The full-app test checks startup and routes against an in-memory database instead.

These boundaries describe what the current suite demonstrates; they are not claims that the untested behavior fails.
