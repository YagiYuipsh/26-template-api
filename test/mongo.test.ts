// Proves the default MongoDB wiring: with no MONGO_URI configured, building
// the app spawns an in-memory MongoDB and prepares the `example` collection —
// no external services needed.
//
// The app plugin is wrapped in `fastify-plugin` at the registration site (the
// same pattern the production dev scripts use) so the decorators added by the
// autoloaded plugins (`fastify.collections`, `fastify.mongo`) collapse onto
// this root instance: fastify-cli's `helper.build` keeps them scoped inside
// the autoloader, invisible to the instance it returns.

import { onTestFinished, test } from "bun:test";
import * as assert from "node:assert";
import Fastify from "fastify";
import fp from "fastify-plugin";
import App from "../src/app.js";

test("the example collection roundtrips documents in the in-memory MongoDB", async () => {
  // pluginTimeout covers the first-run download of the in-memory MongoDB
  // binary, which can outlast Fastify's 10s default.
  const app = Fastify({ pluginTimeout: 5 * 60 * 1000 });
  onTestFinished(() => app.close());

  await app.register(fp(App), {
    mongoUri: undefined,
    mongoTestUri: undefined,
    authSkip: true,
  });
  await app.ready();

  const inserted = await app.collections.events.insertOne({
    owner: "Ken",
    title: "Do technical test",
    startsAt: new Date("2026-09-23T20:00:00Z"),
    endsAt: new Date("2026-09-23T21:00:00Z"),
    version: 1,
    createdAt: new Date("2026-09-23T19:00:00Z"),
    updatedAt: new Date("2026-09-23T19:00:00Z"),
  });
  const found = await app.collections.events.findOne({
    _id: inserted.insertedId,
  });
  assert.equal(found?.owner, "Ken");
});

test("the app reports ready with the collections decorated", async () => {
  const app = Fastify({ pluginTimeout: 5 * 60 * 1000 });
  onTestFinished(() => app.close());

  await app.register(fp(App), {
    mongoUri: undefined,
    mongoTestUri: undefined,
    authSkip: true,
  });
  await app.ready();

  assert.ok(app.collections);
  assert.ok(typeof app.withAuth === "function");
});
