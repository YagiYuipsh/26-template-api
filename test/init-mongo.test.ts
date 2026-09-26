// Pins the URI-defaulting rules for MongoDB connection strings: the database
// name is appended only when missing, query parameters survive, and invalid
// URIs fail here with a clear message instead of at driver connect time.

import { describe, expect, test } from "bun:test";
import { withDefaultMongoDatabase } from "../src/plugins/init-mongo.js";

describe("withDefaultMongoDatabase", () => {
  test("appends the database name when none is present", () => {
    expect(
      withDefaultMongoDatabase("mongodb://localhost:27018", "usthing"),
    ).toBe("mongodb://localhost:27018/usthing");
  });

  test("keeps an explicitly named database unchanged", () => {
    expect(
      withDefaultMongoDatabase("mongodb://localhost:27018/other", "usthing"),
    ).toBe("mongodb://localhost:27018/other");
  });

  test("preserves query parameters while defaulting the database", () => {
    expect(
      withDefaultMongoDatabase("mongodb://localhost:27018/?tls=true", "db"),
    ).toBe("mongodb://localhost:27018/db?tls=true");
  });

  test("defaults the authSource for credentials without a database", () => {
    const uri = withDefaultMongoDatabase(
      "mongodb://user:pass@localhost:27018",
      "db",
    );
    const parsed = new URL(uri);
    expect(parsed.username).toBe("user");
    expect(parsed.searchParams.get("authSource")).toBe("admin");
  });

  test("rejects scheme-less URIs instead of failing at connect time", () => {
    expect(() => withDefaultMongoDatabase("localhost:27018", "db")).toThrow(
      "Invalid MongoDB URI",
    );
  });
});
