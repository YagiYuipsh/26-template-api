import type { FastifyPluginAsync } from "fastify";
import { ObjectId } from "mongodb";
import { Type } from "typebox";
import type { FastifyTypebox } from "../../app.js";
import { createEventRepository } from "../../event/event-repository.js";
import {
  EventBody,
  EventListResponse,
  EventParams,
  EventPatchBody,
  EventQuery,
  EventResponse,
} from "../../event/event-schema.js";
import {
  type CreateEventInput,
  createEventService,
  type EventExportInput,
  type EventService,
  EventServiceError,
  type ListEventInput,
  type PatchEventInput,
} from "../../event/event-service.js";
import { UserLock } from "../../event/user-lock.js";
import { HttpError } from "../../plugins/sensible.js";

function parseObjectId(id: string): ObjectId | undefined {
  return ObjectId.isValid(id) ? new ObjectId(id) : undefined;
}

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
    ...(event.description === undefined
      ? {}
      : { description: event.description }),
    ...(event.venue === undefined ? {} : { venue: event.venue }),
    version: event.version,
    createdAt: event.createdAt.toISOString(),
    updatedAt: event.updatedAt.toISOString(),
  };
}

function sendServiceError(
  reply: {
    badRequest: (message: string) => unknown;
    notFound: (message: string) => unknown;
    conflict: (message: string) => unknown;
    internalServerError: (message: string) => unknown;
  },
  error: unknown,
) {
  if (!(error instanceof EventServiceError)) throw error;
  switch (error.code) {
    case "INVALID_TITLE":
    case "INVALID_START_DATE":
    case "INVALID_END_DATE":
    case "INVALID_TIME_RANGE":
    case "NO_FIELDS_TO_UPDATE":
      return reply.badRequest(error.message);
    case "EVENT_NOT_FOUND":
      return reply.notFound(error.message);
    case "EVENT_VERSION_CONFLICT":
      return reply.conflict(error.message);
    case "EVENT_CONFLICT":
      return reply.conflict(error.message);
    case "EVENT_CREATE_FAILED":
      return reply.internalServerError(error.message);
  }
}

const events: FastifyPluginAsync = async (
  fastify: FastifyTypebox,
): Promise<void> => {
  let service: EventService;
  fastify.addHook("onReady", async () => {
    const userLock = new UserLock();
    service = createEventService(
      createEventRepository(fastify.collections.events),
      userLock,
    );
  });

  fastify.withAuth(async (scope) => {
    scope.get(
      "/export.ics",
      {
        schema: {
          summary: "Export events as iCalendar",
          tags: ["Event"],
          security: [{ Auth: [] }],
          querystring: EventQuery,
          response: {
            200: Type.String({
              description: "RFC 5545 iCalendar document",
            }),
            400: HttpError,
          },
        },
      },
      async (request, reply) => {
        try {
          const calendar = await service.exportIcs(
            request.user.username,
            request.query as EventExportInput,
          );
          return reply
            .type("text/calendar; charset=utf-8")
            .header("Content-Disposition", 'attachment; filename="events.ics"')
            .header("Cache-Control", "private, no-store")
            .send(calendar);
        } catch (error) {
          return sendServiceError(reply, error);
        }
      },
    );

    scope.get(
      "/",
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
        try {
          const rows = await service.list(
            request.user.username,
            request.query as ListEventInput,
          );
          return rows.map(toResponse);
        } catch (error) {
          return sendServiceError(reply, error);
        }
      },
    );

    scope.get(
      "/:id",
      {
        schema: {
          summary: "Read one event",
          tags: ["Event"],
          security: [{ Auth: [] }],
          params: EventParams,
          response: { 200: EventResponse, 400: HttpError, 404: HttpError },
        },
      },
      async (request, reply) => {
        const eventId = parseObjectId(request.params.id);
        if (!eventId) return reply.badRequest("Invalid event id");
        try {
          return toResponse(await service.get(request.user.username, eventId));
        } catch (error) {
          return sendServiceError(reply, error);
        }
      },
    );

    scope.post(
      "/",
      {
        schema: {
          summary: "Create an event",
          tags: ["Event"],
          security: [{ Auth: [] }],
          body: EventBody,
          response: {
            201: EventResponse,
            400: HttpError,
            409: HttpError,
            500: HttpError,
          },
        },
      },
      async (request, reply) => {
        try {
          const event = await service.create(
            request.user.username,
            request.body as CreateEventInput,
          );
          return reply.code(201).send(toResponse(event));
        } catch (error) {
          return sendServiceError(reply, error);
        }
      },
    );

    scope.patch(
      "/:id",
      {
        schema: {
          summary: "Update an event",
          tags: ["Event"],
          security: [{ Auth: [] }],
          params: EventParams,
          body: EventPatchBody,
          response: {
            200: EventResponse,
            400: HttpError,
            404: HttpError,
            409: HttpError,
          },
        },
      },
      async (request, reply) => {
        const eventId = parseObjectId(request.params.id);
        if (!eventId) return reply.badRequest("Invalid event id");
        try {
          const event = await service.update(
            request.user.username,
            eventId,
            request.body as PatchEventInput,
          );
          return toResponse(event);
        } catch (error) {
          return sendServiceError(reply, error);
        }
      },
    );

    scope.delete(
      "/:id",
      {
        schema: {
          summary: "Delete an event",
          tags: ["Event"],
          security: [{ Auth: [] }],
          params: EventParams,
          response: { 204: Type.Null(), 400: HttpError, 404: HttpError },
        },
      },
      async (request, reply) => {
        const eventId = parseObjectId(request.params.id);
        if (!eventId) return reply.badRequest("Invalid event id");
        try {
          await service.remove(request.user.username, eventId);
          return reply.code(204).send(null);
        } catch (error) {
          return sendServiceError(reply, error);
        }
      },
    );
  });
};

export default events;
