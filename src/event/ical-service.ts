import type { EventRecord } from "./event-repository.js";

/** Escapes a text value according to RFC 5545 section 3.3.11. */
function escapeIcsText(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll("\r\n", "\\n")
    .replaceAll("\r", "\\n")
    .replaceAll("\n", "\\n")
    .replaceAll(";", "\\;")
    .replaceAll(",", "\\,");
}

function formatIcsDate(value: Date): string {
  const pad = (part: number, length = 2) =>
    part.toString().padStart(length, "0");

  return `${pad(value.getUTCFullYear(), 4)}${pad(value.getUTCMonth() + 1)}${pad(value.getUTCDate())}T${pad(value.getUTCHours())}${pad(value.getUTCMinutes())}${pad(value.getUTCSeconds())}Z`;
}

/**
 * Folds a content line without splitting a UTF-8 code point. RFC 5545 limits
 * the first physical line to 75 octets and continuation lines to 74 octets
 * after their required leading space.
 */
function foldIcsLine(line: string): string[] {
  const codePoints = Array.from(line);
  const folded: string[] = [];
  let current = "";
  let limit = 75;

  for (const codePoint of codePoints) {
    const bytes = Buffer.byteLength(codePoint, "utf8");
    if (
      current.length > 0 &&
      Buffer.byteLength(current, "utf8") + bytes > limit
    ) {
      folded.push(current);
      current = "";
      limit = 74;
    }
    current += codePoint;
  }

  folded.push(current);
  return folded.length === 1
    ? folded
    : [folded[0]!, ...folded.slice(1).map((part) => ` ${part}`)];
}

function serializeEvent(event: EventRecord): string[] {
  const lines = [
    "BEGIN:VEVENT",
    `UID:${event._id.toHexString()}@event-api`,
    `DTSTAMP:${formatIcsDate(event.createdAt)}`,
    `LAST-MODIFIED:${formatIcsDate(event.updatedAt)}`,
    `SEQUENCE:${event.version}`,
    `DTSTART:${formatIcsDate(event.startsAt)}`,
    `DTEND:${formatIcsDate(event.endsAt)}`,
    `SUMMARY:${escapeIcsText(event.title)}`,
  ];

  if (event.description !== undefined) {
    lines.push(`DESCRIPTION:${escapeIcsText(event.description)}`);
  }
  if (event.venue !== undefined) {
    lines.push(`LOCATION:${escapeIcsText(event.venue)}`);
  }

  lines.push("END:VEVENT");
  return lines.flatMap(foldIcsLine);
}

/** Serializes events as a CRLF-terminated RFC 5545 iCalendar document. */
export function serializeIcs(events: EventRecord[]): string {
  const lines = [
    "BEGIN:VCALENDAR",
    "PRODID:-//USThing//EVENT API//EN",
    "VERSION:2.0",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    ...events.flatMap(serializeEvent),
    "END:VCALENDAR",
  ];

  return `${lines.join("\r\n")}\r\n`;
}
