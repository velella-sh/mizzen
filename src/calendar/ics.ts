/**
 * Writes an iCalendar file (RFC 5545) for events that are calendar days. There are no time zones and no times of day:
 * an event starts on a date and, when it lasts, ends on a date. Everything written comes from the arguments, so the
 * same events always give the same bytes: lines end in CRLF, properties come in a fixed order, and no clock is read.
 */

/** A reminder written as a `VALARM` that fires a whole number of days before the event. */
export interface IcsAlarm {
  /** Whole days before the event's first day. */
  readonly days: number;
  /** Text shown when the reminder fires. */
  readonly description: string;
}

/** One event: a day or a run of days. */
export interface IcsEvent {
  /** Stable identifier; the same event keeps the same one in every build. */
  readonly uid: string;
  /** Day the event record was last stamped, `YYYY-MM-DD`; written as midnight UTC of that day. */
  readonly stamp: string;
  /** Revision number; written only when above zero. */
  readonly sequence?: number;
  /** First day, `YYYY-MM-DD`. */
  readonly start: string;
  /** Last day, `YYYY-MM-DD`, inclusive. Default: the first day. */
  readonly end?: string;
  readonly summary: string;
  readonly description?: string;
  readonly url?: string;
  /** Reminders, written in the order given. */
  readonly alarms?: readonly IcsAlarm[];
}

/** One calendar file. */
export interface IcsCalendar {
  /** Written as `X-WR-CALNAME`, the name a calendar app shows. */
  readonly name?: string;
  /** Written as `PRODID`. Default `-//Mizzen//Calendar//EN`. */
  readonly productId?: string;
  readonly events: readonly IcsEvent[];
}

const MAX_OCTETS = 75;
const encoder = new TextEncoder();

/** Escapes a TEXT value: backslash, semicolon, comma, and line breaks. Other control characters are dropped. */
export function escapeText(text: string): string {
  return text
    .replace(/\r\n|\r|\n/g, "\n")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "")
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\;")
    .replace(/,/g, "\\,")
    .replace(/\n/g, "\\n");
}

/**
 * Folds one content line at 75 octets, counting the leading space of a continuation line. A break never falls inside a
 * UTF-8 sequence, so Persian and Arabic text is never split inside a character.
 */
export function foldLine(line: string): string[] {
  if (encoder.encode(line).length <= MAX_OCTETS) return [line];
  const lines: string[] = [];
  let current = "";
  let octets = 0;
  for (const char of line) {
    const size = encoder.encode(char).length;
    if (octets + size > MAX_OCTETS) {
      lines.push(current);
      current = " ";
      octets = 1;
    }
    current += char;
    octets += size;
  }
  lines.push(current);
  return lines;
}

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** `YYYY-MM-DD` as `YYYYMMDD`. Throws on anything else: a caller passes only dates it has validated. */
function compactDate(date: string): string {
  const match = DATE.exec(date);
  if (match === null) throw new Error(`Not a calendar day: ${date}`);
  return `${match[1]}${match[2]}${match[3]}`;
}

/** The day after `date`, `YYYY-MM-DD`; an all-day event's `DTEND` is exclusive. */
export function nextDay(date: string): string {
  compactDate(date);
  const next = new Date(`${date}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString().slice(0, 10);
}

function eventLines(event: IcsEvent): string[] {
  const lines = ["BEGIN:VEVENT", `UID:${escapeText(event.uid)}`, `DTSTAMP:${compactDate(event.stamp)}T000000Z`];
  if (event.sequence !== undefined && event.sequence > 0) lines.push(`SEQUENCE:${event.sequence}`);
  const last = event.end !== undefined && event.end > event.start ? event.end : event.start;
  lines.push(`DTSTART;VALUE=DATE:${compactDate(event.start)}`, `DTEND;VALUE=DATE:${compactDate(nextDay(last))}`);
  lines.push(`SUMMARY:${escapeText(event.summary)}`);
  if (event.description !== undefined) lines.push(`DESCRIPTION:${escapeText(event.description)}`);
  if (event.url !== undefined) lines.push(`URL:${event.url.replace(/[\u0000-\u001f\u007f]/g, "")}`);
  for (const alarm of event.alarms ?? []) {
    lines.push(
      "BEGIN:VALARM",
      "ACTION:DISPLAY",
      `DESCRIPTION:${escapeText(alarm.description)}`,
      `TRIGGER:-P${alarm.days}D`,
      "END:VALARM",
    );
  }
  lines.push("END:VEVENT");
  return lines;
}

/** Writes the calendar: CRLF line ends, folded lines, a trailing CRLF, events in the order given. */
export function writeIcs(calendar: IcsCalendar): string {
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", `PRODID:${calendar.productId ?? "-//Mizzen//Calendar//EN"}`, "CALSCALE:GREGORIAN"];
  if (calendar.name !== undefined) lines.push(`X-WR-CALNAME:${escapeText(calendar.name)}`);
  for (const event of calendar.events) lines.push(...eventLines(event));
  lines.push("END:VCALENDAR");
  return lines.flatMap(foldLine).join("\r\n") + "\r\n";
}
