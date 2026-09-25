import { Type } from "typebox";

/** Response representation of an event returned by the HTTP API. */
export const EventResponse = Type.Object(
  {
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
  },
  { $id: "EventResponse" },
);

/** Response representation of an event collection. */
export const EventListResponse = Type.Array(EventResponse);

/** Request body used when creating an event. */
export const EventBody = Type.Object({
  title: Type.String({ minLength: 1, maxLength: 200 }),
  startsAt: Type.String({ format: "date-time" }),
  endsAt: Type.String({ format: "date-time" }),
  description: Type.Optional(Type.String({ maxLength: 5000 })),
  venue: Type.Optional(Type.String({ maxLength: 500 })),
});

/** Request body used when partially updating an event. */
export const EventPatchBody = Type.Intersect([
  Type.Object({
    version: Type.Integer({ minimum: 1 }),
  }),
  Type.Partial(EventBody),
]);

/** Path parameters used by event endpoints addressing a single event. */
export const EventParams = Type.Object({ id: Type.String({ minLength: 1 }) });

/** Query parameters for filtering events by title and time range. */
export const EventQuery = Type.Object({
  title: Type.Optional(
    Type.String({
      minLength: 1,
      maxLength: 200,
      description:
        "Return events whose titles contain this text, ignoring case.",
    }),
  ),
  from: Type.Optional(
    Type.String({
      format: "date-time",
      description: "Return events ending after this time.",
    }),
  ),
  to: Type.Optional(
    Type.String({
      format: "date-time",
      description: "Return events starting before this time.",
    }),
  ),
});
