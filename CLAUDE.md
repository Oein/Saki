# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Saki is a CalDAV server (RFC 4791) that bridges Apple Calendar (and other CalDAV clients) with a Notion database. Events stored in Notion are exposed as iCalendar resources via the CalDAV protocol.

## Commands

- `npm run dev` — Start dev server with hot reload (tsx watch), runs on port 5232
- `npm run build` — Compile TypeScript to `dist/`
- `npm start` — Run compiled JS from `dist/`
- `npx tsc --noEmit` — Type-check without emitting

## Architecture

**Request flow:** CalDAV Client → Express (Digest/Basic Auth) → CalDAV handlers → Notion API

### Source Files

- **`src/index.ts`** — Express server setup, Digest auth middleware (required for Apple Calendar over HTTP since it refuses Basic auth on non-HTTPS), request logging, route registration
- **`src/caldav.ts`** — All CalDAV/WebDAV protocol handlers: PROPFIND (discovery), PROPPATCH, REPORT (calendar-query, calendar-multiget), GET/PUT/DELETE for event resources. Builds XML multistatus responses manually.
- **`src/notion.ts`** — Notion SDK wrapper. CRUD operations on Notion pages. Handles date conversion between iCal (exclusive DTEND) and Notion (inclusive end). Filters out pages with no date.
- **`src/ical.ts`** — iCalendar format generation (`eventToIcs`) and parsing (`parseIcs` via ical.js). Handles all-day vs timed events with correct `VALUE=DATE` formatting.
- **`src/types.ts`** — Shared `CalendarEvent` interface

### Key Design Decisions

- **Digest auth over HTTP**: Apple Calendar won't send Basic auth credentials over plain HTTP. The server implements RFC 2617 Digest auth with nonce management.
- **Date conversion**: iCal all-day DTEND is exclusive (next day), Notion end dates are inclusive. `toNotionDate()` subtracts a day when writing, `pageToEvent()` adds a day when reading.
- **Time zones**: Timed events are stored in Notion with local timezone offset (`+09:00`) via `toLocalISOString()`, not UTC.
- **Notion property names**: The database uses Korean property names: `이름` (title) and `날짜` (date). `UID`, `Description`, `Location` are auto-created in English by `ensureDatabaseProperties()`.
- **CDATA wrapping**: calendar-data in REPORT responses uses `<![CDATA[...]]>` to prevent XML parsers from mangling iCal content.

### CalDAV Discovery Flow

```
/.well-known/caldav → /principals/{user}/ → /calendars/{user}/ → /calendars/{user}/default/
```

## Configuration

Environment variables in `.env` (see `.env.example`):
- `NOTION_TOKEN` — Notion integration token
- `NOTION_DATABASE_ID` — Target Notion database ID
- `CALDAV_USERNAME` / `CALDAV_PASSWORD` — CalDAV auth credentials
- `PORT` — Server port (default 5232)
