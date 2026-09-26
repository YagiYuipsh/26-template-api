import { type Collection, type Filter, ObjectId, type WithId } from "mongodb";
import type { EventDocument } from "./event.js";

export type EventRecord = WithId<EventDocument>;

export type EventUpdate = Partial<
  Pick<EventDocument, "title" | "startsAt" | "endsAt" | "description" | "venue">
>;

export type EventListFilters = { title?: string; from?: Date; to?: Date };

export type EventListCursor = { startsAt: Date; id: ObjectId };

export type EventListOptions = EventListFilters & {
  limit: number;
  cursor?: EventListCursor;
};

export type EventListPage = {
  items: EventRecord[];
  hasMore: boolean;
};

export interface EventRepository {
  findById(owner: string, id: string | ObjectId): Promise<EventRecord | null>;
  findOverlapping(
    owner: string,
    startsAt: Date,
    endsAt: Date,
    excludedId?: string | ObjectId,
  ): Promise<EventRecord | null>;
  insert(event: EventDocument): Promise<EventRecord>;
  update(
    owner: string,
    id: string | ObjectId,
    expectedVersion: number,
    changes: EventUpdate,
  ): Promise<EventRecord | null>;
  delete(owner: string, id: string | ObjectId): Promise<boolean>;
  list(owner: string, options: EventListOptions): Promise<EventListPage>;
  listAll(owner: string, filters?: EventListFilters): Promise<EventRecord[]>;
}

function toObjectId(id: string | ObjectId): ObjectId | null {
  if (id instanceof ObjectId) return id;
  return ObjectId.isValid(id) ? new ObjectId(id) : null;
}

export function createEventRepository(
  collection: Collection<EventDocument>,
): EventRepository {
  async function findById(owner: string, id: string | ObjectId) {
    const objectId = toObjectId(id);
    return objectId === null
      ? null
      : collection.findOne({ _id: objectId, owner });
  }

  async function findOverlapping(
    owner: string,
    startsAt: Date,
    endsAt: Date,
    excludedId?: string | ObjectId,
  ) {
    // Events use half-open intervals: [startsAt, endsAt). This allows one
    // event to start exactly when another event ends.
    const filter: Filter<EventDocument> = {
      owner,
      startsAt: { $lt: endsAt },
      endsAt: { $gt: startsAt },
    };
    if (excludedId !== undefined) {
      // When updating an event, exclude the current document so it does not
      // conflict with its own existing time range.
      const excludedObjectId = toObjectId(excludedId);
      if (excludedObjectId === null) return null;
      filter._id = { $ne: excludedObjectId };
    }
    return collection.findOne(filter);
  }

  async function insert(event: EventDocument) {
    const result = await collection.insertOne(event);
    const inserted = await collection.findOne({
      _id: result.insertedId,
      owner: event.owner,
    });
    if (inserted === null) throw new Error("Event was not created");
    return inserted;
  }

  async function update(
    owner: string,
    id: string | ObjectId,
    expectedVersion: number,
    changes: EventUpdate,
  ) {
    const objectId = toObjectId(id);
    if (objectId === null) return null;
    // Include the expected version in the MongoDB predicate so the version
    // check and update are atomic.
    const result = await collection.updateOne(
      { _id: objectId, owner, version: expectedVersion },
      { $set: { ...changes, updatedAt: new Date() }, $inc: { version: 1 } },
    );
    if (result.matchedCount === 0) return null;
    return collection.findOne({ _id: objectId, owner });
  }

  async function remove(owner: string, id: string | ObjectId) {
    const objectId = toObjectId(id);
    if (objectId === null) return false;
    const result = await collection.deleteOne({ _id: objectId, owner });
    return result.deletedCount === 1;
  }

  function buildFilter(
    owner: string,
    filters: EventListFilters,
    cursor?: EventListCursor,
  ): Filter<EventDocument> {
    const clauses: Filter<EventDocument>[] = [{ owner }];
    if (filters.title !== undefined) {
      clauses.push({ title: { $regex: filters.title, $options: "i" } });
    }
    if (filters.from !== undefined)
      clauses.push({ endsAt: { $gt: filters.from } });
    if (filters.to !== undefined)
      clauses.push({ startsAt: { $lt: filters.to } });
    if (cursor !== undefined) {
      // Continue strictly after the cursor's (startsAt, _id) position. The
      // _id tie-breaker prevents duplicates or omissions for equal start times.
      clauses.push({
        $or: [
          { startsAt: { $gt: cursor.startsAt } },
          { startsAt: cursor.startsAt, _id: { $gt: cursor.id } },
        ],
      });
    }
    return { $and: clauses };
  }

  async function list(owner: string, options: EventListOptions) {
    // Fetch one extra row so the response can indicate whether another page
    // exists without issuing a separate count query.
    const rows = await collection
      .find(buildFilter(owner, options, options.cursor))
      .sort({ startsAt: 1, _id: 1 })
      .limit(options.limit + 1)
      .toArray();
    return {
      items: rows.slice(0, options.limit),
      hasMore: rows.length > options.limit,
    };
  }

  async function listAll(owner: string, filters: EventListFilters = {}) {
    return collection
      .find(buildFilter(owner, filters))
      .sort({ startsAt: 1, _id: 1 })
      .toArray();
  }

  return {
    findById,
    findOverlapping,
    insert,
    update,
    delete: remove,
    list,
    listAll,
  };
}
