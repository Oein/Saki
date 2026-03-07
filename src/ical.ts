import ICAL from "ical.js";
import { CalendarEvent } from "./types";

function formatDateTime(d: Date): string {
  return d
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
}

function formatDateOnly(d: Date): string {
  return d.toISOString().split("T")[0].replace(/-/g, "");
}

function isAllDay(event: CalendarEvent): boolean {
  const s = event.dtstart;
  const e = event.dtend;
  return (
    s.getUTCHours() === 0 &&
    s.getUTCMinutes() === 0 &&
    s.getUTCSeconds() === 0 &&
    e.getUTCHours() === 0 &&
    e.getUTCMinutes() === 0 &&
    e.getUTCSeconds() === 0
  );
}

export function eventToIcs(event: CalendarEvent): string {
  const allDay = isAllDay(event);

  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "CALSCALE:GREGORIAN",
    "PRODID:-//Saki//CalDAV//EN",
    "BEGIN:VEVENT",
    `UID:${event.uid}`,
    `DTSTAMP:${formatDateTime(event.lastModified)}`,
  ];

  if (allDay) {
    lines.push(`DTSTART;VALUE=DATE:${formatDateOnly(event.dtstart)}`);
    lines.push(`DTEND;VALUE=DATE:${formatDateOnly(event.dtend)}`);
  } else {
    lines.push(`DTSTART:${formatDateTime(event.dtstart)}`);
    lines.push(`DTEND:${formatDateTime(event.dtend)}`);
  }

  lines.push(`SUMMARY:${escapeIcalText(event.summary)}`);

  if (event.description) {
    lines.push(`DESCRIPTION:${escapeIcalText(event.description)}`);
  }
  if (event.location) {
    lines.push(`LOCATION:${escapeIcalText(event.location)}`);
  }

  lines.push(
    `LAST-MODIFIED:${formatDateTime(event.lastModified)}`,
    `CREATED:${formatDateTime(event.created)}`,
    "END:VEVENT",
    "END:VCALENDAR"
  );

  return lines.join("\r\n") + "\r\n";
}

function escapeIcalText(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\n/g, "\\n");
}

export function parseIcs(icsData: string): {
  uid: string;
  summary: string;
  description: string;
  dtstart: Date;
  dtend: Date;
  location: string;
  allDay: boolean;
} | null {
  try {
    const jcal = ICAL.parse(icsData);
    const comp = new ICAL.Component(jcal);
    const vevent = comp.getFirstSubcomponent("vevent");
    if (!vevent) return null;

    const event = new ICAL.Event(vevent);

    const uid = event.uid || "";
    const summary = event.summary || "";
    const description = event.description || "";
    const location = event.location || "";

    // Check if it's an all-day event (VALUE=DATE)
    const dtStartProp = vevent.getFirstProperty("dtstart");
    const allDay = dtStartProp?.getParameter("value") === "date" ||
      (event.startDate && event.startDate.isDate);

    const dtstart = event.startDate?.toJSDate() ?? new Date();

    let dtend: Date;
    if (event.endDate) {
      dtend = event.endDate.toJSDate();
    } else if (event.duration) {
      const end = event.startDate!.clone();
      end.addDuration(event.duration);
      dtend = end.toJSDate();
    } else {
      dtend = new Date(dtstart.getTime() + (allDay ? 86400000 : 3600000));
    }

    return { uid, summary, description, dtstart, dtend, location, allDay };
  } catch (err) {
    console.error("Failed to parse ICS:", err);
    return null;
  }
}
