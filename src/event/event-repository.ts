import { type Collection, type Filter, ObjectId, type WithId } from "mongodb";
import type { EventDocument } from "./event.js";

export type EventRecord = WithId<EventDocument>;

export type EventUpdate = Partial<
  Pick<EventDocument, "title" | "startsAt" | "endsAt" | "description" | "venue">
>;

export type EventListFilters = { title?: string; from?: Date; to?: Date };

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
    changes: EventUpdate,
  ): Promise<EventRecord | null>;
  delete(owner: string, id: string | ObjectId): Promise<boolean>;
  list(owner: string, filters?: EventListFilters): Promise<EventRecord[]>;
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
    const filter: Filter<EventDocument> = {
      owner,
      startsAt: { $lt: endsAt },
      endsAt: { $gt: startsAt },
    };
    if (excludedId !== undefined) {
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
    changes: EventUpdate,
  ) {
    const objectId = toObjectId(id);
    if (objectId === null) return null;
    const result = await collection.updateOne(
      { _id: objectId, owner },
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

  async function list(owner: string, filters: EventListFilters = {}) {
    const filter: Filter<EventDocument> = {
      owner,
      ...(filters.title === undefined
        ? {}
        : { title: { $regex: filters.title, $options: "i" } }),
      ...(filters.from === undefined ? {} : { endsAt: { $gt: filters.from } }),
      ...(filters.to === undefined ? {} : { startsAt: { $lt: filters.to } }),
    };
    return collection.find(filter).sort({ startsAt: 1, _id: 1 }).toArray();
  }

  return { findById, findOverlapping, insert, update, delete: remove, list };
}
