import { Client } from "@notionhq/client";
import { v4 as uuidv4 } from "uuid";
import { CalendarEvent } from "./types";

const notion = new Client({ auth: process.env.NOTION_TOKEN });
const databaseId = process.env.NOTION_DATABASE_ID!;

function extractPlainText(
  richText: Array<{ plain_text: string }>
): string {
  return richText.map((t) => t.plain_text).join("");
}

function pageToEvent(page: any): CalendarEvent | null {
  const props = page.properties;

  const uid =
    extractPlainText(props.UID?.rich_text ?? []) || page.id;
  const summary = extractPlainText(props["이름"]?.title ?? []);
  const description = extractPlainText(props.Description?.rich_text ?? []);
  const location = extractPlainText(props.Location?.rich_text ?? []);

  const dateProp = props["날짜"]?.date;
  if (!dateProp?.start) return null;
  const startStr = dateProp.start;
  const isDateOnly = startStr.length === 10; // "2026-03-07" vs "2026-03-07T09:00:00..."
  const dtstart = startStr ? new Date(startStr) : new Date();

  let dtend: Date;
  if (dateProp?.end) {
    const endDate = new Date(dateProp.end);
    if (isDateOnly) {
      // Notion end is inclusive for all-day, iCal DTEND is exclusive → add 1 day
      dtend = new Date(endDate.getTime() + 86400000);
    } else {
      dtend = endDate;
    }
  } else if (isDateOnly) {
    // All-day single day: DTEND should be next day per iCal spec
    dtend = new Date(dtstart.getTime() + 86400000);
  } else {
    dtend = new Date(dtstart.getTime() + 3600000);
  }

  const lastModified = new Date(page.last_edited_time);
  const created = new Date(page.created_time);

  // Extract 상태 (status) property → calendarId
  const statusProp = props["상태"];
  let calendarId = "default";
  if (statusProp?.type === "select" && statusProp.select?.name) {
    calendarId = statusProp.select.name;
  } else if (statusProp?.type === "status" && statusProp.status?.name) {
    calendarId = statusProp.status.name;
  }

  return {
    uid,
    summary,
    description,
    dtstart,
    dtend,
    location,
    lastModified,
    created,
    notionPageId: page.id,
    etag: `"${lastModified.getTime()}"`,
    calendarId,
  };
}

// Cache for status calendars (5 min TTL)
let _calendarCache: { id: string; name: string }[] | null = null;
let _calendarCacheTime = 0;
let _statusPropType: string | null = null;

async function refreshCalendarCache(): Promise<void> {
  const db = await notion.databases.retrieve({ database_id: databaseId });
  const statusProp = (db as any).properties["상태"];

  if (!statusProp) {
    _calendarCache = [{ id: "default", name: "Notion Calendar" }];
    _statusPropType = null;
  } else {
    _statusPropType = statusProp.type;
    let options: any[] = [];
    if (statusProp.type === "select") {
      options = statusProp.select?.options || [];
    } else if (statusProp.type === "status") {
      options = statusProp.status?.options || [];
    }
    _calendarCache = [
      { id: "default", name: "미분류" },
      ...options.map((opt: any) => ({ id: opt.name, name: opt.name })),
    ];
  }
  _calendarCacheTime = Date.now();
}

export async function getStatusCalendars(): Promise<{ id: string; name: string }[]> {
  if (!_calendarCache || Date.now() - _calendarCacheTime > 300000) {
    await refreshCalendarCache();
  }
  return _calendarCache!;
}

export async function getAllEvents(calendarId?: string): Promise<CalendarEvent[]> {
  const events: CalendarEvent[] = [];
  let cursor: string | undefined = undefined;

  do {
    const response: any = await notion.databases.query({
      database_id: databaseId,
      start_cursor: cursor,
    });

    for (const page of response.results) {
      if (page.object === "page" && "properties" in page) {
        const event = pageToEvent(page);
        if (event) events.push(event);
      }
    }
    cursor = response.has_more ? response.next_cursor : undefined;
  } while (cursor);

  if (calendarId === undefined) return events;
  return events.filter((e) => e.calendarId === calendarId);
}

export async function getEventByUid(
  uid: string
): Promise<CalendarEvent | null> {
  const response = await notion.databases.query({
    database_id: databaseId,
    filter: {
      property: "UID",
      rich_text: { equals: uid },
    },
  });

  if (response.results.length === 0) return null;
  const page = response.results[0];
  if (page.object === "page" && "properties" in page) {
    return pageToEvent(page);
  }
  return null;
}

// Format a Date as ISO with timezone offset (e.g. "2026-03-18T09:00:00+09:00")
function toLocalISOString(d: Date): string {
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  const absOff = Math.abs(off);
  const hh = String(Math.floor(absOff / 60)).padStart(2, "0");
  const mm = String(absOff % 60).padStart(2, "0");
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const hours = String(d.getHours()).padStart(2, "0");
  const mins = String(d.getMinutes()).padStart(2, "0");
  const secs = String(d.getSeconds()).padStart(2, "0");
  return `${year}-${month}-${day}T${hours}:${mins}:${secs}${sign}${hh}:${mm}`;
}

function toNotionDate(dtstart: Date, dtend: Date, allDay: boolean): { start: string; end: string | null } {
  if (allDay) {
    const startStr = dtstart.toISOString().split("T")[0];
    // iCal DTEND is exclusive for all-day events, Notion end is inclusive → subtract 1 day
    const notionEnd = new Date(dtend.getTime() - 86400000);
    const endStr = notionEnd.toISOString().split("T")[0];
    return { start: startStr, end: startStr === endStr ? null : endStr };
  }
  const startStr = toLocalISOString(dtstart);
  const endStr = toLocalISOString(dtend);
  return { start: startStr, end: startStr === endStr ? null : endStr };
}

export async function createEvent(event: {
  uid: string;
  summary: string;
  description: string;
  dtstart: Date;
  dtend: Date;
  location: string;
  allDay: boolean;
  calendarId?: string;
}): Promise<CalendarEvent> {
  const { start, end } = toNotionDate(event.dtstart, event.dtend, event.allDay);

  // Ensure cache is populated to know the status prop type
  if (!_calendarCache) await refreshCalendarCache();

  const properties: any = {
    "이름": { title: [{ text: { content: event.summary } }] },
    "날짜": { date: { start, end } },
    Description: { rich_text: [{ text: { content: event.description } }] },
    Location: { rich_text: [{ text: { content: event.location } }] },
    UID: { rich_text: [{ text: { content: event.uid } }] },
  };

  // Set 상태 property when calendarId is a named status (not default)
  if (event.calendarId && event.calendarId !== "default" && _statusPropType) {
    if (_statusPropType === "select") {
      properties["상태"] = { select: { name: event.calendarId } };
    } else if (_statusPropType === "status") {
      properties["상태"] = { status: { name: event.calendarId } };
    }
  }

  const page = await notion.pages.create({
    parent: { database_id: databaseId },
    properties,
  });

  return pageToEvent(page as any)!;
}

export async function updateEvent(
  notionPageId: string,
  event: {
    summary: string;
    description: string;
    dtstart: Date;
    dtend: Date;
    location: string;
    allDay: boolean;
  }
): Promise<CalendarEvent> {
  const { start, end } = toNotionDate(event.dtstart, event.dtend, event.allDay);

  const page = await notion.pages.update({
    page_id: notionPageId,
    properties: {
      "이름": {
        title: [{ text: { content: event.summary } }],
      },
      "날짜": {
        date: { start, end },
      },
      Description: {
        rich_text: [{ text: { content: event.description } }],
      },
      Location: {
        rich_text: [{ text: { content: event.location } }],
      },
    },
  });

  return pageToEvent(page as any)!;
}

export async function deleteEvent(notionPageId: string): Promise<void> {
  await notion.pages.update({
    page_id: notionPageId,
    archived: true,
  });
}

export async function ensureDatabaseProperties(): Promise<void> {
  try {
    const db = await notion.databases.retrieve({ database_id: databaseId });
    const props = (db as any).properties;
    const updates: Record<string, any> = {};

    if (!props.UID) {
      updates.UID = { rich_text: {} };
    }
    if (!props.Description) {
      updates.Description = { rich_text: {} };
    }
    if (!props.Location) {
      updates.Location = { rich_text: {} };
    }
    if (!props["날짜"]) {
      updates["날짜"] = { date: {} };
    }

    if (Object.keys(updates).length > 0) {
      await notion.databases.update({
        database_id: databaseId,
        properties: updates,
      });
      console.log("Added missing properties to Notion database:", Object.keys(updates));
    }
  } catch (err) {
    console.error("Failed to ensure database properties:", err);
  }
}
