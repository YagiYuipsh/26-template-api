import type { FastifyPluginAsync } from "fastify";
import { ObjectId } from "mongodb";
import { Type } from "typebox";
import type { FastifyTypebox } from "../../app.js";
import { HttpError } from "../../plugins/sensible.js";

// response structure of Event
const EventResponse = Type.Object({
  id: Type.String(),
  owner: Type.String(),
  title: Type.String({ minLength: 1 }),
  startsAt: Type.String({ format: "date-time" }),
  endsAt: Type.String({ format: "date-time" }),
  description: Type.Optional(Type.String()),
  venue: Type.Optional(Type.String()),
  version: Type.Integer({ minimum: 1 }),
  createdAt: Type.String({ format: "date-time" }),
  updatedAt: Type.String({ format: "date-time" }),
}, { $id: "EventResponse" });
// response structure of Event list 
const EventListResponse = Type.Array(EventResponse);

//Request body structure
const EventBody = Type.Object({
  title: Type.String({ minLength: 1, maxLength: 200 }),
  startsAt: Type.String({ format: "date-time" }),
  endsAt: Type.String({ format: "date-time" }),
  description: Type.Optional(Type.String({ maxLength: 5000 })),
  venue: Type.Optional(Type.String({ maxLength: 500 })),
});

//Request body structure when updating event
const EventPatchBody = Type.Partial(EventBody);

//Event Id parameter in request
const EventParams = Type.Object({ id: Type.String({ minLength: 1 }) });

//Query parameters for filtering events by title and time range
const EventQuery = Type.Object({
  title: Type.Optional(Type.String({
    minLength: 1,
    maxLength: 200,
    description: "Return events whose titles contain this text, ignoring case.",
  })),
  from: Type.Optional(Type.String({
    format: "date-time",
    description: "Return events ending after this time.",
  })),
  to: Type.Optional(Type.String({
    format: "date-time",
    description: "Return events starting before this time.",
  })),
});

//Convert the string id in request to ObjectId
function parseObjectId(id: string): ObjectId | undefined {
  return ObjectId.isValid(id) ? new ObjectId(id) : undefined;
}

//Convert the response of the document reading to strings
function toResponse(event: {
  _id: ObjectId;
  owner: string;
  title: string;
  startsAt: Date;
  endsAt: Date;
  description?: string;
  venue?: string;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: event._id.toHexString(),
    owner: event.owner,
    title: event.title,
    startsAt: event.startsAt.toISOString(),
    endsAt: event.endsAt.toISOString(),
    ...(event.description === undefined ? {} : { description: event.description }),
    ...(event.venue === undefined ? {} : { venue: event.venue }),
    version: event.version,
    createdAt: event.createdAt.toISOString(),
    updatedAt: event.updatedAt.toISOString(),
  };
}


const events: FastifyPluginAsync = async (fastify: FastifyTypebox): Promise<void> => {
  fastify.withAuth(async (fastify) => {
    // Check whether there is a conflict with another event
    async function findConflict(owner: string, startsAt: Date, endsAt: Date, eventId?: ObjectId) {
      return fastify.collections.events.findOne({
        owner,
        startsAt: { $lt: endsAt },
        endsAt: { $gt: startsAt },
        ...(eventId === undefined ? {} : { _id: { $ne: eventId } }),
      });
    }

    //Read all events or filter by title and time range from that user
    fastify.get("/",
      {
        schema: {
          summary: "Read all events",
          tags: ["Event"],
          security: [{ Auth: [] }],
          querystring: EventQuery,
          response: { 200: EventListResponse, 400: HttpError },
        },
      },
      async (request, reply) => {
        const title = request.query.title?.trim();
        if (title !== undefined && title.length === 0) return reply.badRequest("Invalid title in request");
        const titlePattern = title === undefined ? undefined : title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

        const from = request.query.from === undefined ? undefined : new Date(request.query.from);
        const to = request.query.to === undefined ? undefined : new Date(request.query.to);
        if (from !== undefined && Number.isNaN(from.getTime())) return reply.badRequest("Invalid start date in request");
        if (to !== undefined && Number.isNaN(to.getTime())) return reply.badRequest("Invalid end date in request");
        if (from !== undefined && to !== undefined && from >= to) return reply.badRequest("Invalid time range");

        const rows = await fastify.collections.events
          .find({
            owner: request.user.username,
            ...(titlePattern === undefined ? {} : { title: { $regex: titlePattern, $options: "i" } }),
            ...(from === undefined ? {} : { endsAt: { $gt: from } }),
            ...(to === undefined ? {} : { startsAt: { $lt: to } }),
          })
          .sort({ startsAt: 1, _id: 1 })
          .toArray();

        return rows.map(toResponse);
      });

    //Read the event by id from that user
    fastify.get("/:id",
      {
        schema: {
          summary: "Read one event",
          tags: ["Event"],
          security: [{ Auth: [] }],
          params: EventParams,
          response: {
            200: EventResponse,
            400: HttpError,
            404: HttpError
          },
        },
      }, async (request, reply) => {
        const eventId = parseObjectId(request.params.id);
        if (!eventId) return reply.badRequest("Invalid event id");
        const event = await fastify.collections.events.findOne({ _id: eventId, owner: request.user.username });
        if (!event) return reply.notFound("Event not found");
        return toResponse(event);
      });

    //Creat an event for that user
    fastify.post("/", {
      schema: {
        summary: "Create an event",
        tags: ["Event"],
        security: [{ Auth: [] }],
        body: EventBody,
        response: { 201: EventResponse, 400: HttpError, 409: HttpError },
      },
    }, async (request, reply) => {

      const startsAt = new Date(request.body.startsAt);
      const endsAt = new Date(request.body.endsAt);
      if (startsAt >= endsAt) return reply.badRequest("Invalid time duration");

      const conflict = await findConflict(request.user.username, startsAt, endsAt);
      if (conflict) return reply.conflict(`This time overlaps with ${conflict.title}`);

      const now = new Date();

      const document = {
        owner: request.user.username,
        title: request.body.title,
        startsAt,
        endsAt,
        version: 1,
        createdAt: now,
        updatedAt: now,
        ...(request.body.description === undefined ? {} : { description: request.body.description }),
        ...(request.body.venue === undefined ? {} : { venue: request.body.venue }),

      };
      const result = await fastify.collections.events.insertOne(document);
      const event = await fastify.collections.events.findOne({
        _id: result.insertedId,
        owner: request.user.username,
      });
      if (!event) return reply.internalServerError("Event was not created");
      return reply.code(201).send(toResponse(event));
    });

    fastify.patch("/:id", {
      schema: {
        summary: "Update an event",
        tags: ["Event"],
        security: [{ Auth: [] }],
        params: EventParams,
        body: EventPatchBody,
        response: { 200: EventResponse, 400: HttpError, 404: HttpError, 409: HttpError },
      },
    }, async (request, reply) => {
      const eventId = parseObjectId(request.params.id);
      if (!eventId) return reply.badRequest("Invalid event id");

      const current = await fastify.collections.events.findOne({ _id: eventId, owner: request.user.username });
      if (!current) return reply.notFound("Event not found");

      const body = request.body;
      const startsAt = body.startsAt === undefined ? current.startsAt : new Date(body.startsAt);
      const endsAt = body.endsAt === undefined ? current.endsAt : new Date(body.endsAt);
      if (startsAt >= endsAt) return reply.badRequest("Invalid time duration");

      const normalizedTitle = body.title?.trim();
      const changes = {
        ...(normalizedTitle ? { title: normalizedTitle } : {}),
        ...(body.startsAt === undefined ? {} : { startsAt }),
        ...(body.endsAt === undefined ? {} : { endsAt }),
        ...(body.description === undefined ? {} : { description: body.description }),
        ...(body.venue === undefined ? {} : { venue: body.venue }),
      };
      if (Object.keys(changes).length === 0) return reply.badRequest("No fields to update");

      const update = {
        ...changes,
        updatedAt: new Date(),
      };

      const conflict = await findConflict(request.user.username, startsAt, endsAt, eventId);
      if (conflict) return reply.conflict(`This time overlaps with ${conflict.title}`);

      await fastify.collections.events.updateOne({ _id: eventId, owner: request.user.username }, { $set: update, $inc: { version: 1 } });
      const updated = await fastify.collections.events.findOne({ _id: eventId, owner: request.user.username });
      if (!updated) return reply.notFound("Event not found");
      return toResponse(updated);
    });

    fastify.delete("/:id", {
      schema: {
        summary: "Delete an event",
        tags: ["Event"],
        security: [{ Auth: [] }],
        params: EventParams,
        response: { 204: Type.Null(), 400: HttpError, 404: HttpError },
      },
    }, async (request, reply) => {
      const eventId = parseObjectId(request.params.id);
      if (!eventId) return reply.badRequest("Invalid event id");

      const result = await fastify.collections.events.deleteOne({ _id: eventId, owner: request.user.username });
      if (result.deletedCount === 0) return reply.notFound("Event not found");
      return reply.code(204).send(null);
    });
  });
};

export default events;

