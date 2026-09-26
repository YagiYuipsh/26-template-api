import { ObjectId } from "mongodb";
import type { EventDocument } from "./event.js";
import type {
  EventListCursor,
  EventListFilters,
  EventRecord,
  EventRepository,
  EventUpdate,
} from "./event-repository.js";
import { serializeIcs } from "./ical-service.js";
import { UserLock } from "./user-lock.js";

export type CreateEventInput = {
  title: string;
  startsAt: string;
  endsAt: string;
  description?: string;
  venue?: string;
};

export type PatchEventInput = Partial<CreateEventInput> & {
  version: number;
};

export type ListEventInput = {
  title?: string;
  from?: string;
  to?: string;
  limit?: number;
  cursor?: string;
};

/** Options accepted by the calendar export, matching the event list query. */
export type EventExportInput = Pick<ListEventInput, "title" | "from" | "to">;

export type EventListResult = {
  items: EventRecord[];
  nextCursor: string | null;
};

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

export type EventServiceErrorCode =
  | "INVALID_TITLE"
  | "INVALID_START_DATE"
  | "INVALID_END_DATE"
  | "INVALID_TIME_RANGE"
  | "INVALID_LIMIT"
  | "INVALID_CURSOR"
  | "NO_FIELDS_TO_UPDATE"
  | "EVENT_NOT_FOUND"
  | "EVENT_VERSION_CONFLICT"
  | "EVENT_CONFLICT"
  | "EVENT_CREATE_FAILED";

export class EventServiceError extends Error {
  constructor(
    readonly code: EventServiceErrorCode,
    message: string,
    readonly conflictTitle?: string,
  ) {
    super(message);
    this.name = "EventServiceError";
  }
}

function parseDate(
  value: string,
  code: "INVALID_START_DATE" | "INVALID_END_DATE",
  message: string,
): Date {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new EventServiceError(code, message);
  }
  return date;
}

function validateTimeRange(startsAt: Date, endsAt: Date): void {
  if (startsAt >= endsAt) {
    throw new EventServiceError("INVALID_TIME_RANGE", "Invalid time duration");
  }
}

function normalizeTitle(title: string): string {
  const normalizedTitle = title.trim();
  if (normalizedTitle.length === 0) {
    throw new EventServiceError("INVALID_TITLE", "Invalid title in request");
  }
  return normalizedTitle;
}

function throwConflict(title: string): never {
  throw new EventServiceError(
    "EVENT_CONFLICT",
    `This time overlaps with ${title}`,
    title,
  );
}

function escapeRegex(value: string): string {
  // Treat the user's search text as a literal substring rather than allowing
  // regular-expression operators to change the MongoDB query.
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseLimit(value: number | undefined): number {
  const limit = value ?? DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new EventServiceError(
      "INVALID_LIMIT",
      `Limit must be an integer between 1 and ${MAX_LIMIT}`,
    );
  }
  return limit;
}

function decodeCursor(value: string | undefined): EventListCursor | undefined {
  if (value === undefined) return undefined;
  // Cursors are opaque base64url values at the API boundary. Validate both
  // position fields before using them in the MongoDB keyset filter.
  try {
    const decoded = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    ) as {
      startsAt?: unknown;
      id?: unknown;
    };
    if (
      typeof decoded.startsAt !== "string" ||
      typeof decoded.id !== "string"
    ) {
      throw new Error("Invalid cursor shape");
    }
    const startsAt = new Date(decoded.startsAt);
    if (Number.isNaN(startsAt.getTime()) || !ObjectId.isValid(decoded.id)) {
      throw new Error("Invalid cursor values");
    }
    return { startsAt, id: new ObjectId(decoded.id) };
  } catch {
    throw new EventServiceError("INVALID_CURSOR", "Invalid cursor in request");
  }
}

function encodeCursor(event: EventRecord): string {
  // Expose only the ordering position needed to request the next page; the
  // cursor is intentionally opaque to API clients.
  return Buffer.from(
    JSON.stringify({
      startsAt: event.startsAt.toISOString(),
      id: event._id.toHexString(),
    }),
  ).toString("base64url");
}

function toCreateDocument(
  owner: string,
  input: CreateEventInput,
): EventDocument {
  const title = normalizeTitle(input.title);
  const startsAt = parseDate(
    input.startsAt,
    "INVALID_START_DATE",
    "Invalid start date in request",
  );
  const endsAt = parseDate(
    input.endsAt,
    "INVALID_END_DATE",
    "Invalid end date in request",
  );
  validateTimeRange(startsAt, endsAt);
  const now = new Date();

  return {
    owner,
    title,
    startsAt,
    endsAt,
    version: 1,
    createdAt: now,
    updatedAt: now,
    ...(input.description === undefined
      ? {}
      : { description: input.description }),
    ...(input.venue === undefined ? {} : { venue: input.venue }),
  };
}

export interface EventService {
  create(owner: string, input: CreateEventInput): Promise<EventRecord>;
  get(owner: string, id: string | ObjectId): Promise<EventRecord>;
  list(owner: string, input?: ListEventInput): Promise<EventListResult>;
  exportIcs(owner: string, input?: EventExportInput): Promise<string>;
  update(
    owner: string,
    id: string | ObjectId,
    input: PatchEventInput,
  ): Promise<EventRecord>;
  remove(owner: string, id: string | ObjectId): Promise<void>;
}

export function createEventService(
  repository: EventRepository,
  userLock = new UserLock(),
): EventService {
  async function create(owner: string, input: CreateEventInput) {
    return userLock.run(owner, async () => {
      // Keep overlap detection and insertion in the same per-user critical
      // section. Otherwise, concurrent requests could both pass the check.
      const document = toCreateDocument(owner, input);
      const conflict = await repository.findOverlapping(
        owner,
        document.startsAt,
        document.endsAt,
      );
      if (conflict) throwConflict(conflict.title);

      try {
        return await repository.insert(document);
      } catch (error) {
        if (error instanceof EventServiceError) throw error;
        throw new EventServiceError(
          "EVENT_CREATE_FAILED",
          "Event was not created",
          undefined,
        );
      }
    });
  }

  async function get(owner: string, id: string | ObjectId) {
    const event = await repository.findById(owner, id);
    if (event === null) {
      throw new EventServiceError("EVENT_NOT_FOUND", "Event not found");
    }
    return event;
  }

  async function list(owner: string, input: ListEventInput = {}) {
    const title = input.title?.trim();
    if (title !== undefined && title.length === 0) {
      throw new EventServiceError("INVALID_TITLE", "Invalid title in request");
    }

    const from =
      input.from === undefined
        ? undefined
        : parseDate(
            input.from,
            "INVALID_START_DATE",
            "Invalid start date in request",
          );
    const to =
      input.to === undefined
        ? undefined
        : parseDate(
            input.to,
            "INVALID_END_DATE",
            "Invalid end date in request",
          );
    if (from !== undefined && to !== undefined && from >= to) {
      throw new EventServiceError("INVALID_TIME_RANGE", "Invalid time range");
    }

    const filters: EventListFilters = {
      title: title === undefined ? undefined : escapeRegex(title),
      from,
      to,
    };
    // The range filter uses interval intersection:
    // event.endsAt > from && event.startsAt < to.
    // The repository then applies the opaque cursor as a keyset position.
    const page = await repository.list(owner, {
      ...filters,
      limit: parseLimit(input.limit),
      cursor: decodeCursor(input.cursor),
    });
    const last = page.items.at(-1);
    return {
      items: page.items,
      nextCursor:
        page.hasMore && last !== undefined ? encodeCursor(last) : null,
    };
  }

  async function exportIcs(owner: string, input: EventExportInput = {}) {
    const title = input.title?.trim();
    if (title !== undefined && title.length === 0) {
      throw new EventServiceError("INVALID_TITLE", "Invalid title in request");
    }
    const from =
      input.from === undefined
        ? undefined
        : parseDate(
            input.from,
            "INVALID_START_DATE",
            "Invalid start date in request",
          );
    const to =
      input.to === undefined
        ? undefined
        : parseDate(
            input.to,
            "INVALID_END_DATE",
            "Invalid end date in request",
          );
    if (from !== undefined && to !== undefined && from >= to) {
      throw new EventServiceError("INVALID_TIME_RANGE", "Invalid time range");
    }
    return serializeIcs(
      await repository.listAll(owner, {
        title: title === undefined ? undefined : escapeRegex(title),
        from,
        to,
      }),
    );
  }

  async function update(
    owner: string,
    id: string | ObjectId,
    input: PatchEventInput,
  ) {
    return userLock.run(owner, async () => {
      // The client must update from the version it read. The repository repeats
      // the version check atomically so only one concurrent update can succeed.
      const current = await get(owner, id);
      if (current.version !== input.version) {
        throw new EventServiceError(
          "EVENT_VERSION_CONFLICT",
          "Event was modified by another request",
        );
      }
      const startsAt =
        input.startsAt === undefined
          ? current.startsAt
          : parseDate(
              input.startsAt,
              "INVALID_START_DATE",
              "Invalid start date in request",
            );
      const endsAt =
        input.endsAt === undefined
          ? current.endsAt
          : parseDate(
              input.endsAt,
              "INVALID_END_DATE",
              "Invalid end date in request",
            );
      validateTimeRange(startsAt, endsAt);

      const normalizedTitle = input.title?.trim();
      const changes: EventUpdate = {
        ...(normalizedTitle ? { title: normalizedTitle } : {}),
        ...(input.startsAt === undefined ? {} : { startsAt }),
        ...(input.endsAt === undefined ? {} : { endsAt }),
        ...(input.description === undefined
          ? {}
          : { description: input.description }),
        ...(input.venue === undefined ? {} : { venue: input.venue }),
      };
      if (Object.keys(changes).length === 0) {
        throw new EventServiceError(
          "NO_FIELDS_TO_UPDATE",
          "No fields to update",
        );
      }

      const conflict = await repository.findOverlapping(
        owner,
        startsAt,
        endsAt,
        id,
      );
      if (conflict) throwConflict(conflict.title);

      const updated = await repository.update(
        owner,
        id,
        input.version,
        changes,
      );
      if (updated === null) {
        throw new EventServiceError(
          "EVENT_VERSION_CONFLICT",
          "Event was modified by another request",
        );
      }
      return updated;
    });
  }

  async function remove(owner: string, id: string | ObjectId) {
    const deleted = await repository.delete(owner, id);
    if (!deleted) {
      throw new EventServiceError("EVENT_NOT_FOUND", "Event not found");
    }
  }

  return { create, get, list, exportIcs, update, remove };
}
