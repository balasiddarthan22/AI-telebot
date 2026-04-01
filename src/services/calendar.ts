import { google } from "googleapis";
import { OAuth2Client } from "google-auth-library";

export function createOAuth2Client(): OAuth2Client {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID!,
    process.env.GOOGLE_CLIENT_SECRET!,
    process.env.GOOGLE_REDIRECT_URI!
  );
}

export function getAuthUrl(oauth2Client: OAuth2Client, telegramId: number): string {
  return oauth2Client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: ["https://www.googleapis.com/auth/calendar"],
    state: String(telegramId),
  });
}

export interface CalendarEvent {
  id?: string;
  title: string;
  start: Date;
  end: Date;
  description?: string;
}

export async function listUpcomingEvents(
  oauth2Client: OAuth2Client,
  maxResults = 10
): Promise<CalendarEvent[]> {
  const calendar = google.calendar({ version: "v3", auth: oauth2Client });

  const res = await calendar.events.list({
    calendarId: "primary",
    timeMin: new Date().toISOString(),
    maxResults,
    singleEvents: true,
    orderBy: "startTime",
  });

  return (res.data.items ?? []).map((e) => ({
    id: e.id ?? undefined,
    title: e.summary ?? "No title",
    start: new Date(e.start?.dateTime ?? e.start?.date ?? ""),
    end: new Date(e.end?.dateTime ?? e.end?.date ?? ""),
    description: e.description ?? undefined,
  }));
}

export async function addEvent(
  oauth2Client: OAuth2Client,
  event: CalendarEvent
): Promise<string> {
  const calendar = google.calendar({ version: "v3", auth: oauth2Client });

  const res = await calendar.events.insert({
    calendarId: "primary",
    requestBody: {
      summary: event.title,
      description: event.description,
      start: { dateTime: event.start.toISOString() },
      end: { dateTime: event.end.toISOString() },
    },
  });

  return res.data.id ?? "";
}

export async function deleteEvent(
  oauth2Client: OAuth2Client,
  eventId: string
): Promise<void> {
  const calendar = google.calendar({ version: "v3", auth: oauth2Client });
  await calendar.events.delete({ calendarId: "primary", eventId });
}

export async function getFreeBusy(
  oauth2Client: OAuth2Client,
  timeMin: Date,
  timeMax: Date
): Promise<Array<{ start: Date; end: Date }>> {
  const calendar = google.calendar({ version: "v3", auth: oauth2Client });

  const res = await calendar.freebusy.query({
    requestBody: {
      timeMin: timeMin.toISOString(),
      timeMax: timeMax.toISOString(),
      items: [{ id: "primary" }],
    },
  });

  const busy = res.data.calendars?.["primary"]?.busy ?? [];
  return busy.map((b) => ({
    start: new Date(b.start ?? ""),
    end: new Date(b.end ?? ""),
  }));
}

export function findFreeSlots(
  busyPeriods: Array<{ start: Date; end: Date }>,
  rangeStart: Date,
  rangeEnd: Date,
  slotDurationMinutes = 60
): Array<{ start: Date; end: Date }> {
  const freeSlots: Array<{ start: Date; end: Date }> = [];
  let cursor = new Date(rangeStart);

  const sorted = [...busyPeriods].sort((a, b) => a.start.getTime() - b.start.getTime());

  for (const busy of sorted) {
    if (cursor < busy.start) {
      const gapMs = busy.start.getTime() - cursor.getTime();
      if (gapMs >= slotDurationMinutes * 60 * 1000) {
        freeSlots.push({ start: new Date(cursor), end: new Date(busy.start) });
      }
    }
    if (busy.end > cursor) cursor = new Date(busy.end);
  }

  if (cursor < rangeEnd) {
    const remainingMs = rangeEnd.getTime() - cursor.getTime();
    if (remainingMs >= slotDurationMinutes * 60 * 1000) {
      freeSlots.push({ start: new Date(cursor), end: new Date(rangeEnd) });
    }
  }

  return freeSlots;
}
