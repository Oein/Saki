export interface CalendarEvent {
  uid: string;
  summary: string;
  description: string;
  dtstart: Date;
  dtend: Date;
  location: string;
  lastModified: Date;
  created: Date;
  notionPageId: string;
  etag: string;
  calendarId: string; // 상태 property value, "default" if unset
}

export interface NotionEventProperties {
  Name: { title: Array<{ plain_text: string }> };
  Date: { date: { start: string; end: string | null } | null };
  Description: { rich_text: Array<{ plain_text: string }> };
  Location: { rich_text: Array<{ plain_text: string }> };
  UID: { rich_text: Array<{ plain_text: string }> };
}

export interface CalDavPrincipal {
  username: string;
  calendarPath: string;
}
