import type { ObjectId } from "mongodb";
import type { EventDocument } from "./event.js";
import type {
  EventListFilters,
  EventRecord,
  EventRepository,
  EventUpdate,
} from "./event-repository.js";
import { UserLock } from "./user-lock.js";

export type CreateEventInput = {
  title: string;
  startsAt: string;
  endsAt: string;
  description?: string;
  venue?: string;
};

export type PatchEventInput = Partial<CreateEventInput>;

export type ListEventInput = {
  title?: string;
  from?: string;
  to?: string;
};

export type EventServiceErrorCode =
  | "INVALID_TITLE"
  | "INVALID_START_DATE"
  | "INVALID_END_DATE"
  | "INVALID_TIME_RANGE"
  | "NO_FIELDS_TO_UPDATE"
  | "EVENT_NOT_FOUND"
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
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
  list(owner: string, input?: ListEventInput): Promise<EventRecord[]>;
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
    return repository.list(owner, filters);
  }

  async function update(
    owner: string,
    id: string | ObjectId,
    input: PatchEventInput,
  ) {
    return userLock.run(owner, async () => {
      const current = await get(owner, id);
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

      const updated = await repository.update(owner, id, changes);
      if (updated === null) {
        throw new EventServiceError("EVENT_NOT_FOUND", "Event not found");
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

  return { create, get, list, update, remove };
}
