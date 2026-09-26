import { afterAll, beforeAll, beforeEach, test } from "bun:test";
import * as assert from "node:assert";
import Fastify from "fastify";
import { MongoClient, ObjectId } from "mongodb";
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

function getEvent(id: string, username = "alice") {
  return app.inject({
    url: `/event/${id}`,
    headers: { authorization: `Bearer event-test-${username}` },
  });
}

function updateEvent(
  id: string,
  version: number,
  payload: Record<string, unknown>,
  username = "alice",
) {
  return app.inject({
    method: "PATCH",
    url: `/event/${id}`,
    headers: { authorization: `Bearer event-test-${username}` },
    payload: { ...payload, version },
  });
}

function deleteEvent(id: string, username = "alice") {
  return app.inject({
    method: "DELETE",
    url: `/event/${id}`,
    headers: { authorization: `Bearer event-test-${username}` },
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

test("concurrent creation for one user allows only one overlapping event", async () => {
  const results = await Promise.all([
    createEvent("12:00", "13:00"),
    createEvent("12:00", "13:00"),
  ]);

  assert.deepEqual(
    results.map((result) => result.statusCode).sort(),
    [201, 409],
  );
  assert.equal(
    await app.collections.events.countDocuments({ owner: "alice" }),
    2,
  );
  assert.equal(
    await app.collections.events.countDocuments({
      owner: "alice",
      title: "Meeting",
      startsAt: new Date("2026-09-24T12:00:00.000Z"),
      endsAt: new Date("2026-09-24T13:00:00.000Z"),
    }),
    1,
  );
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

test("concurrent updates with one version permit exactly one winner", async () => {
  const created = await createEvent("12:00", "13:00");
  assert.equal(created.statusCode, 201, created.payload);
  const event = created.json<{ id: string; version: number }>();

  const results = await Promise.all([
    updateEvent(event.id, event.version, { title: "First concurrent update" }),
    updateEvent(event.id, event.version, { title: "Second concurrent update" }),
  ]);

  assert.deepEqual(
    results.map((result) => result.statusCode).sort(),
    [200, 409],
  );
  const saved = await getEvent(event.id);
  assert.equal(saved.statusCode, 200, saved.payload);
  assert.equal(saved.json().version, event.version + 1);
  assert.ok(
    ["First concurrent update", "Second concurrent update"].includes(
      saved.json().title,
    ),
  );
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

test("CRUD lifecycle creates, reads, updates, and deletes an event", async () => {
  const created = await createEvent("12:00", "13:00");
  assert.equal(created.statusCode, 201, created.payload);
  const event = created.json<{ id: string; version: number }>();

  const read = await getEvent(event.id);
  assert.equal(read.statusCode, 200, read.payload);
  assert.equal(read.json().id, event.id);

  const updated = await updateEvent(event.id, event.version, {
    title: "Updated lifecycle event",
  });
  assert.equal(updated.statusCode, 200, updated.payload);
  assert.equal(updated.json().title, "Updated lifecycle event");

  const removed = await deleteEvent(event.id);
  assert.equal(removed.statusCode, 204, removed.payload);
  assert.equal(removed.payload, "");

  const afterDelete = await getEvent(event.id);
  assert.equal(afterDelete.statusCode, 404, afterDelete.payload);
});

test("another user cannot delete or read an event they do not own", async () => {
  const created = await createEvent("12:00", "13:00");
  assert.equal(created.statusCode, 201, created.payload);
  const event = created.json<{ id: string }>();

  const deleteAttempt = await deleteEvent(event.id, "bob");
  assert.equal(deleteAttempt.statusCode, 404, deleteAttempt.payload);
  assert.equal(deleteAttempt.json().message, "Event not found");

  const readByOwner = await getEvent(event.id);
  assert.equal(readByOwner.statusCode, 200, readByOwner.payload);
  assert.equal(readByOwner.json().owner, "alice");

  const readByOtherUser = await getEvent(event.id, "bob");
  assert.equal(readByOtherUser.statusCode, 404, readByOtherUser.payload);
  assert.equal(
    await app.collections.events.countDocuments({
      _id: new ObjectId(event.id),
    }),
    1,
  );
});

const timeRangeCases: [Record<string, string>, boolean][] = [
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
      result
        .json<{ items: Array<{ id: string }> }>()
        .items.map((event) => event.id),
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
    result
      .json<{ items: Array<{ id: string }> }>()
      .items.map((event) => event.id),
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
      result
        .json<{ items: Array<{ id: string }> }>()
        .items.map((event) => event.id),
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
];

test.each(titleSearchCases)(
  "event list searches titles containing %s",
  async (title, matches) => {
    const result = await listEvents({ title });
    assert.equal(result.statusCode, 200, result.payload);
    assert.deepEqual(
      result
        .json<{ items: Array<{ id: string }> }>()
        .items.map((event) => event.id),
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
      result
        .json<{ items: Array<{ id: string }> }>()
        .items.map((event) => event.id),
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
    result
      .json<{ items: Array<{ id: string }> }>()
      .items.map((event) => event.id),
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
    result
      .json<{ items: Array<{ id: string }> }>()
      .items.map((event) => event.id),
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
  const otherUser = await createEvent("10:00", "11:00", "bob");
  const outsideRange = await createEvent("12:00", "13:00");
  assert.equal(otherUser.statusCode, 201, otherUser.payload);
  assert.equal(outsideRange.statusCode, 201, outsideRange.payload);

  const result = await app.inject({
    url: "/event/export.ics?from=2026-09-24T09:30:00Z&to=2026-09-24T11:30:00Z",
    headers: { authorization: "Bearer event-test-alice" },
  });

  assert.equal(result.statusCode, 200, result.payload);
  assert.equal((result.payload.match(/BEGIN:VEVENT/g) ?? []).length, 1);
  assert.ok(result.payload.includes(`UID:${existingId}@event-api`));
  assert.ok(!result.payload.includes(`UID:${otherUser.json().id}@event-api`));
  assert.ok(
    !result.payload.includes(`UID:${outsideRange.json().id}@event-api`),
  );
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

test("event list uses a default limit and cursor pagination", async () => {
  const metadata = eventMetadata();
  await app.collections.events.insertMany(
    [8, 9, 12, 13].map((hour) => ({
      owner: "alice",
      title: `Event ${hour}`,
      startsAt: new Date(
        `2026-09-24T${hour.toString().padStart(2, "0")}:00:00Z`,
      ),
      endsAt: new Date(`2026-09-24T${hour.toString().padStart(2, "0")}:30:00Z`),
      ...metadata,
    })),
  );

  const first = await listEvents({ limit: "2" });
  assert.equal(first.statusCode, 200, first.payload);
  const firstPage = first.json<{
    items: Array<{ id: string }>;
    nextCursor: string | null;
  }>();
  assert.equal(firstPage.items.length, 2);
  assert.ok(firstPage.nextCursor);

  const second = await listEvents({
    limit: "2",
    cursor: firstPage.nextCursor!,
  });
  assert.equal(second.statusCode, 200, second.payload);
  const secondPage = second.json<{
    items: Array<{ id: string }>;
    nextCursor: string | null;
  }>();
  assert.equal(secondPage.items.length, 2);
  assert.ok(secondPage.nextCursor);

  const third = await listEvents({
    limit: "2",
    cursor: secondPage.nextCursor!,
  });
  assert.equal(third.statusCode, 200, third.payload);
  const thirdPage = third.json<{
    items: Array<{ id: string }>;
    nextCursor: string | null;
  }>();
  assert.equal(thirdPage.items.length, 1);
  assert.equal(thirdPage.nextCursor, null);
  assert.equal(
    new Set([
      ...firstPage.items.map((event) => event.id),
      ...secondPage.items.map((event) => event.id),
      ...thirdPage.items.map((event) => event.id),
    ]).size,
    5,
  );
});

test("event list defaults to 50 items", async () => {
  const metadata = eventMetadata();
  await app.collections.events.insertMany(
    Array.from({ length: 55 }, (_, index) => ({
      owner: "alice",
      title: `Event ${index}`,
      startsAt: new Date(Date.UTC(2026, 8, 1, index)),
      endsAt: new Date(Date.UTC(2026, 8, 1, index, 30)),
      ...metadata,
    })),
  );
  const result = await listEvents();
  assert.equal(result.statusCode, 200, result.payload);
  const page = result.json<{ items: unknown[]; nextCursor: string | null }>();
  assert.equal(page.items.length, 50);
  assert.ok(page.nextCursor);
});

test("event list rejects a limit above the maximum", async () => {
  const result = await listEvents({ limit: "101" });
  assert.equal(result.statusCode, 400, result.payload);
});

test("event list rejects an invalid cursor", async () => {
  const result = await listEvents({ cursor: "not-a-valid-cursor" });
  assert.equal(result.statusCode, 400, result.payload);
});

test("event cursor uses _id to paginate equal start times", async () => {
  const startsAt = new Date("2026-09-24T14:00:00Z");
  const endsAt = new Date("2026-09-24T14:30:00Z");
  await app.collections.events.insertMany(
    ["A", "B", "C"].map((suffix) => ({
      owner: "alice",
      title: `Same start ${suffix}`,
      startsAt,
      endsAt,
      ...eventMetadata(),
    })),
  );

  const ids: string[] = [];
  let cursor: string | undefined;
  for (let pageNumber = 0; pageNumber < 3; pageNumber += 1) {
    const result = await listEvents({
      title: "Same start",
      limit: "1",
      ...(cursor === undefined ? {} : { cursor }),
    });
    assert.equal(result.statusCode, 200, result.payload);
    const page = result.json<{
      items: Array<{ id: string }>;
      nextCursor: string | null;
    }>();
    assert.equal(page.items.length, 1);
    ids.push(page.items[0]!.id);
    cursor = page.nextCursor ?? undefined;
  }

  assert.equal(new Set(ids).size, 3);
  assert.equal(cursor, undefined);
});

test("event list combines filters with pagination and keeps owner isolation", async () => {
  await app.collections.events.insertMany([
    {
      owner: "alice",
      title: "Planning",
      startsAt: new Date("2026-09-24T12:00:00Z"),
      endsAt: new Date("2026-09-24T12:30:00Z"),
      ...eventMetadata(),
    },
    {
      owner: "bob",
      title: "Planning",
      startsAt: new Date("2026-09-24T12:15:00Z"),
      endsAt: new Date("2026-09-24T12:45:00Z"),
      ...eventMetadata(),
    },
  ]);
  const result = await listEvents({ title: "plan", limit: "1" });
  assert.equal(result.statusCode, 200, result.payload);
  assert.equal(
    result.json<{ items: Array<{ owner: string }> }>().items[0]?.owner,
    "alice",
  );
});
