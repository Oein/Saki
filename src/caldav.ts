import { Request, Response } from "express";
import {
  getAllEvents,
  getEventByUid,
  createEvent,
  updateEvent,
  deleteEvent,
} from "./notion";
import { eventToIcs, parseIcs } from "./ical";
import { CalendarEvent } from "./types";

const CS_NS = "http://calendarserver.org/ns/";
const DAV_HEADER = "1, 2, access-control, calendar-access";

function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function xml(responses: string[]): string {
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<d:multistatus xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav" xmlns:cs="${CS_NS}" xmlns:ical="http://apple.com/ns/ical/">`,
    ...responses,
    `</d:multistatus>`,
  ].join("\n");
}

function response(href: string, found: string[], notFound: string[] = []): string {
  const parts = [`<d:response>`, `<d:href>${escapeXml(href)}</d:href>`];

  if (found.length > 0) {
    parts.push(
      `<d:propstat>`,
      `<d:prop>`,
      ...found,
      `</d:prop>`,
      `<d:status>HTTP/1.1 200 OK</d:status>`,
      `</d:propstat>`
    );
  }

  if (notFound.length > 0) {
    parts.push(
      `<d:propstat>`,
      `<d:prop>`,
      ...notFound,
      `</d:prop>`,
      `<d:status>HTTP/1.1 404 Not Found</d:status>`,
      `</d:propstat>`
    );
  }

  parts.push(`</d:response>`);
  return parts.join("\n");
}

function principalPath(username: string): string {
  return `/principals/${username}/`;
}

function calendarHomePath(username: string): string {
  return `/calendars/${username}/`;
}

function calendarPath(username: string): string {
  return `/calendars/${username}/default/`;
}

function sendXml(res: Response, body: string): void {
  res
    .status(207)
    .set("Content-Type", "application/xml; charset=utf-8")
    .set("DAV", DAV_HEADER)
    .send(body);
}

// --- Handlers ---

export function handleOptions(_req: Request, res: Response): void {
  res.set({
    DAV: DAV_HEADER,
    Allow: "OPTIONS, GET, HEAD, PUT, DELETE, PROPFIND, PROPPATCH, REPORT, MKCALENDAR",
  });
  res.status(200).end();
}

export function handleProppatch(req: Request, res: Response): void {
  sendXml(
    res,
    xml([
      response(req.path, [
        `<d:prop/>`,
      ]),
    ])
  );
}

export function handleWellKnown(req: Request, res: Response): void {
  const username = (req as any).username || "user";
  res.redirect(301, principalPath(username));
}

export async function handlePropfind(req: Request, res: Response): Promise<void> {
  const username = (req as any).username || "user";
  const path = req.path;
  const depth = req.headers.depth || "0";
  const body = req.body?.toString() || "";

  // Parse requested properties from the PROPFIND body
  const requestedProps = parseRequestedProps(body);

  try {
    // Principal discovery
    if (
      path === "/" ||
      path === "/.well-known/caldav" ||
      path === principalPath(username) ||
      path === `/principals/${username}`
    ) {
      const props = buildPrincipalProps(username, requestedProps);
      sendXml(res, xml([response(principalPath(username), props.found, props.notFound)]));
      return;
    }

    // Calendar home
    if (
      path === calendarHomePath(username) ||
      path === `/calendars/${username}`
    ) {
      const responses = [
        response(calendarHomePath(username), [
          `<d:resourcetype><d:collection/></d:resourcetype>`,
          `<d:owner><d:href>${principalPath(username)}</d:href></d:owner>`,
          `<d:current-user-principal><d:href>${principalPath(username)}</d:href></d:current-user-principal>`,
        ]),
      ];

      if (depth !== "0") {
        const calProps = buildCalendarCollectionProps(username);
        responses.push(response(calendarPath(username), calProps));
      }

      sendXml(res, xml(responses));
      return;
    }

    // Calendar collection
    if (
      path === calendarPath(username) ||
      path === `/calendars/${username}/default`
    ) {
      const calProps = buildCalendarCollectionProps(username);
      const responses = [response(calendarPath(username), calProps)];

      if (depth !== "0") {
        const events = await getAllEvents();
        for (const event of events) {
          const eventHref = `${calendarPath(username)}${event.uid}.ics`;
          responses.push(
            response(eventHref, [
              `<d:resourcetype/>`,
              `<d:getetag>${escapeXml(event.etag)}</d:getetag>`,
              `<d:getcontenttype>text/calendar; charset=utf-8; component=VEVENT</d:getcontenttype>`,
            ])
          );
        }
      }

      sendXml(res, xml(responses));
      return;
    }

    // Individual event resource
    const eventUid = extractUidFromPath(path);
    if (eventUid) {
      const event = await getEventByUid(eventUid);
      if (event) {
        sendXml(
          res,
          xml([
            response(path, [
              `<d:resourcetype/>`,
              `<d:getetag>${escapeXml(event.etag)}</d:getetag>`,
              `<d:getcontenttype>text/calendar; charset=utf-8; component=VEVENT</d:getcontenttype>`,
            ]),
          ])
        );
        return;
      }
    }

    res.status(404).end();
  } catch (err) {
    console.error("PROPFIND error:", err);
    res.status(500).end();
  }
}

export async function handleReport(req: Request, res: Response): Promise<void> {
  const username = (req as any).username || "user";
  const body = req.body?.toString() || "";

  try {
    const isMultiget = body.includes("calendar-multiget");

    let events: CalendarEvent[];

    if (isMultiget) {
      // calendar-multiget: fetch specific events by href
      const hrefRegex = /<[^:>]*:?href[^>]*>([^<]+)<\/[^:>]*:?href>/g;
      const uids: string[] = [];
      let match;
      while ((match = hrefRegex.exec(body)) !== null) {
        const uid = extractUidFromPath(match[1]);
        if (uid) uids.push(uid);
      }

      const allEvents = await getAllEvents();
      events = allEvents.filter((e) => uids.includes(e.uid));
    } else {
      // calendar-query: return all events (simplified - no time-range filter)
      events = await getAllEvents();
    }

    const responses = events.map((event) => {
      const ics = eventToIcs(event);
      const eventHref = `${calendarPath(username)}${event.uid}.ics`;
      return response(eventHref, [
        `<d:getetag>${escapeXml(event.etag)}</d:getetag>`,
        `<cal:calendar-data><![CDATA[${ics}]]></cal:calendar-data>`,
      ]);
    });

    sendXml(res, xml(responses));
  } catch (err) {
    console.error("REPORT error:", err);
    res.status(500).end();
  }
}

export async function handleGet(req: Request, res: Response): Promise<void> {
  const uid = extractUidFromPath(req.path);
  if (!uid) {
    res.status(404).end();
    return;
  }

  try {
    const event = await getEventByUid(uid);
    if (!event) {
      res.status(404).end();
      return;
    }

    const ics = eventToIcs(event);
    res
      .status(200)
      .set("Content-Type", "text/calendar; charset=utf-8")
      .set("ETag", event.etag)
      .send(ics);
  } catch (err) {
    console.error("GET error:", err);
    res.status(500).end();
  }
}

export async function handlePut(req: Request, res: Response): Promise<void> {
  const uid = extractUidFromPath(req.path);
  if (!uid) {
    res.status(400).end();
    return;
  }

  const icsData = req.body?.toString() || "";
  const parsed = parseIcs(icsData);
  if (!parsed) {
    res.status(400).send("Invalid iCalendar data").end();
    return;
  }

  try {
    const existing = await getEventByUid(uid);

    if (existing) {
      const updated = await updateEvent(existing.notionPageId, {
        summary: parsed.summary,
        description: parsed.description,
        dtstart: parsed.dtstart,
        dtend: parsed.dtend,
        location: parsed.location,
        allDay: parsed.allDay,
      });
      res.status(204).set("ETag", updated.etag).end();
    } else {
      const created = await createEvent({
        uid,
        summary: parsed.summary,
        description: parsed.description,
        dtstart: parsed.dtstart,
        dtend: parsed.dtend,
        location: parsed.location,
        allDay: parsed.allDay,
      });
      res.status(201).set("ETag", created.etag).end();
    }
  } catch (err) {
    console.error("PUT error:", err);
    res.status(500).end();
  }
}

export async function handleDelete(req: Request, res: Response): Promise<void> {
  const uid = extractUidFromPath(req.path);
  if (!uid) {
    res.status(404).end();
    return;
  }

  try {
    const event = await getEventByUid(uid);
    if (!event) {
      res.status(404).end();
      return;
    }

    await deleteEvent(event.notionPageId);
    res.status(204).end();
  } catch (err) {
    console.error("DELETE error:", err);
    res.status(500).end();
  }
}

// --- Helpers ---

function extractUidFromPath(path: string): string | null {
  const match = path.match(/\/([^/]+)\.ics$/);
  return match ? match[1] : null;
}

function parseRequestedProps(body: string): string[] {
  if (!body) return [];
  const props: string[] = [];
  const propMatch = body.match(/<[^>]*prop[^/]*>([\s\S]*?)<\/[^>]*prop>/);
  if (propMatch) {
    const tagRegex = /<([a-zA-Z][^/>\s]*)/g;
    let m;
    while ((m = tagRegex.exec(propMatch[1])) !== null) {
      props.push(m[1].toLowerCase());
    }
  }
  return props;
}

function buildPrincipalProps(
  username: string,
  _requestedProps: string[]
): { found: string[]; notFound: string[] } {
  return {
    found: [
      `<d:resourcetype><d:collection/><d:principal/></d:resourcetype>`,
      `<d:current-user-principal><d:href>${principalPath(username)}</d:href></d:current-user-principal>`,
      `<d:displayname>${escapeXml(username)}</d:displayname>`,
      `<d:principal-URL><d:href>${principalPath(username)}</d:href></d:principal-URL>`,
      `<cal:calendar-home-set><d:href>${calendarHomePath(username)}</d:href></cal:calendar-home-set>`,
      `<d:supported-report-set>
        <d:supported-report><d:report><cal:calendar-multiget/></d:report></d:supported-report>
        <d:supported-report><d:report><cal:calendar-query/></d:report></d:supported-report>
      </d:supported-report-set>`,
    ],
    notFound: [],
  };
}

function buildCalendarCollectionProps(username: string): string[] {
  return [
    `<d:resourcetype><d:collection/><cal:calendar/></d:resourcetype>`,
    `<d:displayname>Notion Calendar</d:displayname>`,
    `<cal:supported-calendar-component-set><cal:comp name="VEVENT"/></cal:supported-calendar-component-set>`,
    `<cal:supported-calendar-data><cal:calendar-data content-type="text/calendar" version="2.0"/></cal:supported-calendar-data>`,
    `<d:supported-report-set>
      <d:supported-report><d:report><cal:calendar-multiget/></d:report></d:supported-report>
      <d:supported-report><d:report><cal:calendar-query/></d:report></d:supported-report>
    </d:supported-report-set>`,
    `<d:current-user-privilege-set>
      <d:privilege><d:read/></d:privilege>
      <d:privilege><d:write/></d:privilege>
      <d:privilege><d:write-content/></d:privilege>
      <d:privilege><d:read-current-user-privilege-set/></d:privilege>
    </d:current-user-privilege-set>`,
    `<d:owner><d:href>${principalPath(username)}</d:href></d:owner>`,
    `<d:current-user-principal><d:href>${principalPath(username)}</d:href></d:current-user-principal>`,
    `<cs:getctag>"${Date.now()}"</cs:getctag>`,
    `<d:getcontenttype>text/calendar; charset=utf-8</d:getcontenttype>`,
  ];
}
