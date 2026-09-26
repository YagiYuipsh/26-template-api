import { afterAll, beforeAll, beforeEach, test } from "bun:test";
import * as assert from "node:assert";
import Fastify from "fastify";
import { MongoClient } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";
import type { EventDocument } from "../../src/event/event.js";
import AuthPlugin from "../../src/plugins/auth.js";
import Sensible from "../../src/plugins/sensible.js";
import Events from "../../src/routes/event/index.js";

const app = Fastify();
let mongod: MongoMemoryServer | undefined;
let client: MongoClient | undefined;
let existingId: string;

function eventBody(start: string, end: string) {
  return {
    title: "Meeting",
    startsAt: `2026-09-24T${start}:00.000Z`,
    endsAt: `2026-09-24T${end}:00.000Z`,
  };
}

function eventMetadata() {
  const now = new Date();
  return { version: 1, createdAt: now, updatedAt: now };
}

function createEvent(start: string, end: string, username = "alice") {
  return app.inject({
    method: "POST",
    url: "/event/",
    headers: { authorization: `Bearer event-test-${username}` },
    payload: eventBody(start, end),
  });
}

function listEvents(query: Record<string, string> = {}) {
  return app.inject({
    url: `/event/?${new URLSearchParams(query)}`,
    headers: { authorization: "Bearer event-test-alice" },
  });
}

beforeAll(async () => {
  // Always use an isolated database, regardless of application environment.
  mongod = await MongoMemoryServer.create();
  client = await new MongoClient(mongod.getUri()).connect();
  app.decorate("collections", {
    events: client.db("event-overlap-test").collection<EventDocument>("events"),
  });
  await app.register(AuthPlugin, {
    users: [
      { username: "alice", name: "Alice", token: "event-test-alice" },
      { username: "bob", name: "Bob", token: "event-test-bob" },
    ],
  });
  await app.register(Sensible);
  await app.register(Events, { prefix: "/event" });
  await app.ready();
}, 60000);

afterAll(async () => {
  try {
    await app.close();
  } finally {
    try {
      await client?.close();
    } finally {
      await mongod?.stop();
    }
  }
});

beforeEach(async () => {
  await app.collections.events.deleteMany({});
  const result = await createEvent("10:00", "11:00");
  assert.equal(result.statusCode, 201, result.payload);
  existingId = result.json().id;
});

test.each([
  ["09:30", "10:30"],
  ["10:30", "11:30"],
  ["10:15", "10:45"],
  ["09:00", "12:00"],
  ["10:00", "11:00"],
])(
  "creation rejects overlapping interval %s–%s without inserting",
  async (start, end) => {
    const result = await createEvent(start, end);
    assert.equal(result.statusCode, 409, result.payload);
    assert.equal(result.json().message, "This time overlaps with Meeting");
    assert.equal(await app.collections.events.countDocuments({}), 1);
  },
);

test.each([
  ["09:00", "10:00"],
  ["11:00", "12:00"],
])("creation allows adjacent interval %s–%s", async (start, end) => {
  const result = await createEvent(start, end);
  assert.equal(result.statusCode, 201, result.payload);
  assert.equal(await app.collections.events.countDocuments({}), 2);
});

test.each(["", "   ", "\t\n"])(
  "creation rejects a blank title %j",
  async (title) => {
    const result = await app.inject({
      method: "POST",
      url: "/event/",
      headers: { authorization: "Bearer event-test-alice" },
      payload: { ...eventBody("12:00", "13:00"), title },
    });
    assert.equal(result.statusCode, 400, result.payload);
    assert.equal(await app.collections.events.countDocuments({}), 1);
  },
);

test("creation trims the title", async () => {
  const result = await app.inject({
    method: "POST",
    url: "/event/",
    headers: { authorization: "Bearer event-test-alice" },
    payload: { ...eventBody("12:00", "13:00"), title: "  Planning  " },
  });
  assert.equal(result.statusCode, 201, result.payload);
  assert.equal(result.json().title, "Planning");
});

test("another user's event does not block creation", async () => {
  const result = await createEvent("10:00", "11:00", "bob");
  assert.equal(result.statusCode, 201, result.payload);
  assert.equal(result.json().owner, "bob");
});

test.each([
  ["09:00", "10:00", { endsAt: eventBody("09:00", "10:30").endsAt }],
  ["12:00", "13:00", { startsAt: eventBody("10:30", "13:00").startsAt }],
])(
  "partial time updates reject overlaps for %s–%s without changing the event",
  async (start, end, payload) => {
    const created = await createEvent(start, end);
    assert.equal(created.statusCode, 201, created.payload);
    const result = await app.inject({
      method: "PATCH",
      url: `/event/${created.json().id}`,
      headers: { authorization: "Bearer event-test-alice" },
      payload: { ...payload, version: created.json().version },
    });
    assert.equal(result.statusCode, 409, result.payload);
    assert.equal(result.json().message, "This time overlaps with Meeting");
    const saved = await app.inject({
      url: `/event/${created.json().id}`,
      headers: { authorization: "Bearer event-test-alice" },
    });
    assert.equal(saved.statusCode, 200, saved.payload);
    assert.deepEqual(saved.json(), created.json());
  },
);

test("updating an event excludes itself from the conflict check", async () => {
  const before = await app.inject({
    url: `/event/${existingId}`,
    headers: { authorization: "Bearer event-test-alice" },
  });
  const result = await app.inject({
    method: "PATCH",
    url: `/event/${existingId}`,
    headers: { authorization: "Bearer event-test-alice" },
    payload: { version: before.json().version, title: "Renamed meeting" },
  });
  assert.equal(result.statusCode, 200, result.payload);
  assert.equal(result.json().title, "Renamed meeting");
});

test("rejects a PATCH with a stale version", async () => {
  const before = await app.inject({
    url: `/event/${existingId}`,
    headers: { authorization: "Bearer event-test-alice" },
  });
  assert.equal(before.statusCode, 200, before.payload);

  const first = await app.inject({
    method: "PATCH",
    url: `/event/${existingId}`,
    headers: { authorization: "Bearer event-test-alice" },
    payload: { version: before.json().version, title: "First update" },
  });
  assert.equal(first.statusCode, 200, first.payload);

  const stale = await app.inject({
    method: "PATCH",
    url: `/event/${existingId}`,
    headers: { authorization: "Bearer event-test-alice" },
    payload: { version: before.json().version, title: "Stale update" },
  });
  assert.equal(stale.statusCode, 409, stale.payload);
  assert.equal(stale.json().message, "Event was modified by another request");
});

test("requires a version for PATCH requests", async () => {
  const result = await app.inject({
    method: "PATCH",
    url: `/event/${existingId}`,
    headers: { authorization: "Bearer event-test-alice" },
    payload: { title: "Missing version" },
  });
  assert.equal(result.statusCode, 400, result.payload);
});

test("rejects a whitespace-only title as an empty update", async () => {
  const before = await app.inject({
    url: `/event/${existingId}`,
    headers: { authorization: "Bearer event-test-alice" },
  });
  assert.equal(before.statusCode, 200, before.payload);

  const result = await app.inject({
    method: "PATCH",
    url: `/event/${existingId}`,
    headers: { authorization: "Bearer event-test-alice" },
    payload: { version: before.json().version, title: "   " },
  });
  assert.equal(result.statusCode, 400, result.payload);
  assert.equal(result.json().message, "No fields to update");

  const after = await app.inject({
    url: `/event/${existingId}`,
    headers: { authorization: "Bearer event-test-alice" },
  });
  assert.equal(after.statusCode, 200, after.payload);
  assert.deepEqual(after.json(), before.json());
});

test("ignores a whitespace-only title when updating another field", async () => {
  const before = await app.inject({
    url: `/event/${existingId}`,
    headers: { authorization: "Bearer event-test-alice" },
  });
  const result = await app.inject({
    method: "PATCH",
    url: `/event/${existingId}`,
    headers: { authorization: "Bearer event-test-alice" },
    payload: {
      version: before.json().version,
      title: "   ",
      venue: "Room 101",
    },
  });
  assert.equal(result.statusCode, 200, result.payload);
  assert.equal(result.json().title, "Meeting");
  assert.equal(result.json().venue, "Room 101");
});

test("another user's event does not block an update", async () => {
  const created = await createEvent("12:00", "13:00", "bob");
  assert.equal(created.statusCode, 201, created.payload);
  const result = await app.inject({
    method: "PATCH",
    url: `/event/${created.json().id}`,
    headers: { authorization: "Bearer event-test-bob" },
    payload: {
      ...eventBody("10:00", "11:00"),
      version: created.json().version,
    },
  });
  assert.equal(result.statusCode, 200, result.payload);
  assert.equal(result.json().owner, "bob");
});

const timeRangeCases: [Record<string, string>, boolean][] = [
  [{}, true],
  [{ from: "2026-09-24T09:00:00Z", to: "2026-09-24T12:00:00Z" }, true],
  [{ from: "2026-09-24T10:15:00Z", to: "2026-09-24T10:45:00Z" }, true],
  [{ from: "2026-09-24T09:30:00Z", to: "2026-09-24T10:30:00Z" }, true],
  [{ from: "2026-09-24T10:30:00Z", to: "2026-09-24T11:30:00Z" }, true],
  [{ from: "2026-09-24T09:00:00Z", to: "2026-09-24T10:00:00Z" }, false],
  [{ from: "2026-09-24T11:00:00Z", to: "2026-09-24T12:00:00Z" }, false],
  [{ from: "2026-09-24T10:30:00Z" }, true],
  [{ from: "2026-09-24T11:00:00Z" }, false],
  [{ to: "2026-09-24T10:30:00Z" }, true],
  [{ to: "2026-09-24T10:00:00Z" }, false],
  [{ from: "2026-09-25T00:00:00Z", to: "2026-09-26T00:00:00Z" }, false],
  [
    { from: "2026-09-24T18:00:00+08:00", to: "2026-09-24T19:00:00+08:00" },
    true,
  ],
];

test.each(timeRangeCases)(
  "event list filters by time range %j",
  async (query, matches) => {
    const result = await listEvents(query);
    assert.equal(result.statusCode, 200, result.payload);
    assert.deepEqual(
      result.json<Array<{ id: string }>>().map((event) => event.id),
      matches ? [existingId] : [],
    );
  },
);

const invalidTimeRanges: Record<string, string>[] = [
  { from: "not-a-date" },
  { to: "not-a-date" },
  { from: "2026-09-24" },
  { to: "2026-09-24T12:00:00" },
  { from: "" },
  { from: "2026-09-24T11:00:00Z", to: "2026-09-24T11:00:00Z" },
  { from: "2026-09-24T12:00:00Z", to: "2026-09-24T11:00:00Z" },
  { from: "2026-06-30T23:59:60Z" },
  { to: "2026-06-30T23:59:60Z" },
];

test.each(invalidTimeRanges)(
  "event list rejects invalid time range %j",
  async (query) => {
    const result = await listEvents(query);
    assert.equal(result.statusCode, 400, result.payload);
    assert.equal(result.json().statusCode, 400);
  },
);

test("time filtering includes events starting on the previous day", async () => {
  const inserted = await app.collections.events.insertOne({
    owner: "alice",
    title: "Overnight event",
    startsAt: new Date("2026-09-23T23:00:00Z"),
    endsAt: new Date("2026-09-24T09:00:00Z"),
    ...eventMetadata(),
  });
  const result = await listEvents({
    from: "2026-09-24T00:00:00Z",
    to: "2026-09-24T08:00:00Z",
  });
  assert.equal(result.statusCode, 200, result.payload);
  assert.deepEqual(
    result.json<Array<{ id: string }>>().map((event) => event.id),
    [inserted.insertedId.toHexString()],
  );
});

test("time filtering preserves owner isolation and chronological ordering", async () => {
  const later = await createEvent("12:00", "13:00");
  const earlier = await createEvent("08:00", "09:00");
  const otherUser = await createEvent("10:00", "11:00", "bob");
  for (const created of [later, earlier, otherUser]) {
    assert.equal(created.statusCode, 201, created.payload);
  }

  for (const query of [
    {},
    { from: "2026-09-24T00:00:00Z", to: "2026-09-25T00:00:00Z" },
  ] as Record<string, string>[]) {
    const result = await listEvents(query);
    assert.equal(result.statusCode, 200, result.payload);
    assert.deepEqual(
      result.json<Array<{ id: string }>>().map((event) => event.id),
      [earlier.json().id, existingId, later.json().id],
    );
  }
});

const titleSearchCases: [string, boolean][] = [
  ["meet", true],
  ["MEETING", true],
  ["eeti", true],
  ["  meeT  ", true],
  ["missing", false],
  [".*", false],
  ["[", false],
];

test.each(titleSearchCases)(
  "event list searches titles containing %s",
  async (title, matches) => {
    const result = await listEvents({ title });
    assert.equal(result.statusCode, 200, result.payload);
    assert.deepEqual(
      result.json<Array<{ id: string }>>().map((event) => event.id),
      matches ? [existingId] : [],
    );
  },
);

test.each(["", "   ", "x".repeat(201)])(
  "event list rejects invalid title search %s",
  async (title) => {
    const result = await listEvents({ title });
    assert.equal(result.statusCode, 400, result.payload);
    assert.equal(result.json().statusCode, 400);
  },
);

test("title search treats regular-expression characters as literal text", async () => {
  const inserted = await app.collections.events.insertOne({
    owner: "alice",
    title: "Literal .* [team] (draft) C++ $5 ^start end? {2} A|B C:\\Temp",
    startsAt: new Date("2026-09-24T12:00:00Z"),
    endsAt: new Date("2026-09-24T13:00:00Z"),
    ...eventMetadata(),
  });
  for (const title of [
    ".*",
    "[team]",
    "(draft)",
    "C++",
    "$5",
    "^start",
    "?",
    "{2}",
    "A|B",
    "C:\\Temp",
  ]) {
    const result = await listEvents({ title });
    assert.equal(result.statusCode, 200, result.payload);
    assert.deepEqual(
      result.json<Array<{ id: string }>>().map((event) => event.id),
      [inserted.insertedId.toHexString()],
      title,
    );
  }
});

test("title search supports Chinese keywords", async () => {
  const inserted = await app.collections.events.insertOne({
    owner: "alice",
    title: "项目讨论",
    startsAt: new Date("2026-09-24T12:00:00Z"),
    endsAt: new Date("2026-09-24T13:00:00Z"),
    ...eventMetadata(),
  });
  const result = await listEvents({ title: "讨论" });
  assert.equal(result.statusCode, 200, result.payload);
  assert.deepEqual(
    result.json<Array<{ id: string }>>().map((event) => event.id),
    [inserted.insertedId.toHexString()],
  );
});

test("title search combines with time filters and preserves ownership and ordering", async () => {
  const later = await createEvent("12:00", "13:00");
  const earlier = await createEvent("08:00", "09:00");
  const otherUser = await createEvent("10:00", "11:00", "bob");
  for (const created of [later, earlier, otherUser]) {
    assert.equal(created.statusCode, 201, created.payload);
  }
  await app.collections.events.insertOne({
    owner: "alice",
    title: "Lunch",
    startsAt: new Date("2026-09-24T11:00:00Z"),
    endsAt: new Date("2026-09-24T11:30:00Z"),
    ...eventMetadata(),
  });

  const result = await listEvents({
    title: "meet",
    from: "2026-09-24T09:30:00Z",
    to: "2026-09-24T12:30:00Z",
  });
  assert.equal(result.statusCode, 200, result.payload);
  assert.deepEqual(
    result.json<Array<{ id: string }>>().map((event) => event.id),
    [existingId, later.json().id],
  );
});

test("event export returns an authenticated iCalendar document", async () => {
  const result = await app.inject({
    url: "/event/export.ics",
    headers: { authorization: "Bearer event-test-alice" },
  });

  assert.equal(result.statusCode, 200, result.payload);
  assert.match(
    result.headers["content-type"] ?? "",
    /^text\/calendar; charset=utf-8/,
  );
  assert.equal(
    result.headers["content-disposition"],
    'attachment; filename="events.ics"',
  );
  assert.match(result.payload, /^BEGIN:VCALENDAR\r\n/);
  assert.match(result.payload, /PRODID:-\/\/USThing\/\/EVENT API\/\/EN\r\n/);
  assert.match(result.payload, /UID:[a-f0-9]{24}@event-api\r\n/);
  assert.match(result.payload, /BEGIN:VEVENT\r\n/);
  assert.match(result.payload, /SUMMARY:Meeting\r\n/);
  assert.match(result.payload, /END:VCALENDAR\r\n$/);
});

test("event export applies filters and does not include another owner's events", async () => {
  const otherUser = await createEvent("12:00", "13:00", "bob");
  assert.equal(otherUser.statusCode, 201, otherUser.payload);

  const result = await app.inject({
    url: "/event/export.ics?from=2026-09-24T09:30:00Z&to=2026-09-24T11:30:00Z",
    headers: { authorization: "Bearer event-test-alice" },
  });

  assert.equal(result.statusCode, 200, result.payload);
  assert.equal((result.payload.match(/BEGIN:VEVENT/g) ?? []).length, 1);
  assert.doesNotMatch(result.payload, /12:00/);
});

test("event export escapes text and folds long UTF-8 lines", async () => {
  await app.collections.events.insertOne({
    owner: "alice",
    title: `${"会议".repeat(60)},;\\`,
    startsAt: new Date("2026-09-24T12:00:00Z"),
    endsAt: new Date("2026-09-24T13:00:00Z"),
    description: "line 1\nline 2",
    venue: "Room, A; B",
    ...eventMetadata(),
  });

  const result = await app.inject({
    url: "/event/export.ics",
    headers: { authorization: "Bearer event-test-alice" },
  });

  assert.equal(result.statusCode, 200, result.payload);
  assert.match(result.payload, /SUMMARY:/);
  assert.match(result.payload, /\\,\\;\\\\/);
  assert.match(result.payload, /DESCRIPTION:line 1\\nline 2/);
  assert.match(result.payload, /LOCATION:Room\\, A\\; B/);
  for (const line of result.payload.split("\r\n").filter(Boolean)) {
    assert.ok(Buffer.byteLength(line, "utf8") <= 75, line);
  }
});
