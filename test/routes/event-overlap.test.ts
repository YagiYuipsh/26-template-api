import { afterAll, beforeAll, beforeEach, test } from "bun:test";
import * as assert from "node:assert";
import Fastify from "fastify";
import { MongoClient } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";
import type { Eventdocument } from "../../src/event/event.js";
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
    events: client.db("event-overlap-test").collection<Eventdocument>("events"),
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
])("creation rejects overlapping interval %s–%s without inserting", async (start, end) => {
  const result = await createEvent(start, end);
  assert.equal(result.statusCode, 409, result.payload);
  assert.equal(result.json().message, "This time overlaps with Meeting");
  assert.equal(await app.collections.events.countDocuments({}), 1);
});

test.each([
  ["09:00", "10:00"],
  ["11:00", "12:00"],
])("creation allows adjacent interval %s–%s", async (start, end) => {
  const result = await createEvent(start, end);
  assert.equal(result.statusCode, 201, result.payload);
  assert.equal(await app.collections.events.countDocuments({}), 2);
});

test("another user's event does not block creation", async () => {
  const result = await createEvent("10:00", "11:00", "bob");
  assert.equal(result.statusCode, 201, result.payload);
  assert.equal(result.json().owner, "bob");
});

test.each([
  ["09:00", "10:00", { endsAt: eventBody("09:00", "10:30").endsAt }],
  ["12:00", "13:00", { startsAt: eventBody("10:30", "13:00").startsAt }],
])("partial time updates reject overlaps for %s–%s without changing the event", async (start, end, payload) => {
  const created = await createEvent(start, end);
  assert.equal(created.statusCode, 201, created.payload);
  const result = await app.inject({
    method: "PATCH",
    url: `/event/${created.json().id}`,
    headers: { authorization: "Bearer event-test-alice" },
    payload,
  });
  assert.equal(result.statusCode, 409, result.payload);
  assert.equal(result.json().message, "This time overlaps with Meeting");
  const saved = await app.inject({
    url: `/event/${created.json().id}`,
    headers: { authorization: "Bearer event-test-alice" },
  });
  assert.equal(saved.statusCode, 200, saved.payload);
  assert.deepEqual(saved.json(), created.json());
});

test("updating an event excludes itself from the conflict check", async () => {
  const result = await app.inject({
    method: "PATCH",
    url: `/event/${existingId}`,
    headers: { authorization: "Bearer event-test-alice" },
    payload: { title: "Renamed meeting" },
  });
  assert.equal(result.statusCode, 200, result.payload);
  assert.equal(result.json().title, "Renamed meeting");
});

test("another user's event does not block an update", async () => {
  const created = await createEvent("12:00", "13:00", "bob");
  assert.equal(created.statusCode, 201, created.payload);
  const result = await app.inject({
    method: "PATCH",
    url: `/event/${created.json().id}`,
    headers: { authorization: "Bearer event-test-bob" },
    payload: eventBody("10:00", "11:00"),
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
  [{ from: "2026-09-24T18:00:00+08:00", to: "2026-09-24T19:00:00+08:00" }, true],
];

test.each(timeRangeCases)("event list filters by time range %j", async (query, matches) => {
  const result = await listEvents(query);
  assert.equal(result.statusCode, 200, result.payload);
  assert.deepEqual(
    result.json<Array<{ id: string }>>().map((event) => event.id),
    matches ? [existingId] : [],
  );
});

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

test.each(invalidTimeRanges)("event list rejects invalid time range %j", async (query) => {
  const result = await listEvents(query);
  assert.equal(result.statusCode, 400, result.payload);
  assert.equal(result.json().statusCode, 400);
});

test("time filtering includes events starting on the previous day", async () => {
  const inserted = await app.collections.events.insertOne({
    owner: "alice",
    title: "Overnight event",
    startsAt: new Date("2026-09-23T23:00:00Z"),
    endsAt: new Date("2026-09-24T09:00:00Z"),
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

  for (const query of [{}, { from: "2026-09-24T00:00:00Z", to: "2026-09-25T00:00:00Z" }] as Record<string, string>[]) {
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

test.each(titleSearchCases)("event list searches titles containing %s", async (title, matches) => {
  const result = await listEvents({ title });
  assert.equal(result.statusCode, 200, result.payload);
  assert.deepEqual(
    result.json<Array<{ id: string }>>().map((event) => event.id),
    matches ? [existingId] : [],
  );
});

test.each(["", "   ", "x".repeat(201)])("event list rejects invalid title search %s", async (title) => {
  const result = await listEvents({ title });
  assert.equal(result.statusCode, 400, result.payload);
  assert.equal(result.json().statusCode, 400);
});

test("title search treats regular-expression characters as literal text", async () => {
  const inserted = await app.collections.events.insertOne({
    owner: "alice",
    title: "Literal .* [team] (draft) C++ $5 ^start end? {2} A|B C:\\Temp",
    startsAt: new Date("2026-09-24T12:00:00Z"),
    endsAt: new Date("2026-09-24T13:00:00Z"),
  });
  for (const title of [".*", "[team]", "(draft)", "C++", "$5", "^start", "?", "{2}", "A|B", "C:\\Temp"]) {
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
