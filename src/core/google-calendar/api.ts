// Client Google Calendar minimal — appels REST directs via fetch, comme
// src/core/google-calendar/oauth.ts (pas de SDK "googleapis"). Lecture seule
// pour V1.3b (list/get) ; la création reste hors périmètre (V1.3c).

const CALENDAR_API_BASE = "https://www.googleapis.com/calendar/v3";

export class GoogleCalendarApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "GoogleCalendarApiError";
  }
}

async function parseCalendarErrorResponse(response: Response): Promise<GoogleCalendarApiError> {
  let message = `HTTP ${response.status}`;
  try {
    const body = (await response.json()) as { error?: { message?: string } };
    if (typeof body.error?.message === "string") message = body.error.message;
  } catch {
    // Corps non-JSON ou vide : on garde le message par défaut.
  }
  return new GoogleCalendarApiError(response.status, message);
}

export interface CalendarEventSummary {
  id: string;
  summary: string | null;
  // ISO 8601 avec offset pour un événement horodaté, ou "YYYY-MM-DD" pour un
  // événement journée entière (isAllDay le distingue explicitement, jamais
  // deviné à partir du format seul par l'appelant).
  start: string;
  end: string;
  isAllDay: boolean;
  location: string | null;
}

export interface CalendarEventDetail extends CalendarEventSummary {
  description: string | null;
  attendees: { email: string; responseStatus: string }[];
  htmlLink: string | null;
}

interface RawGoogleEventTime {
  date?: string;
  dateTime?: string;
}

interface RawGoogleEvent {
  id: string;
  summary?: string;
  location?: string;
  description?: string;
  htmlLink?: string;
  start?: RawGoogleEventTime;
  end?: RawGoogleEventTime;
  attendees?: { email: string; responseStatus: string }[];
}

function shiftDateOnly(dateOnly: string, deltaDays: number): string {
  const [year, month, day] = dateOnly.split("-").map(Number);
  const shifted = new Date(Date.UTC(year as number, (month as number) - 1, (day as number) + deltaDays));
  return shifted.toISOString().slice(0, 10);
}

function parseEventTime(part: RawGoogleEventTime | undefined): { value: string; isAllDay: boolean } {
  if (part?.dateTime) return { value: part.dateTime, isAllDay: false };
  if (part?.date) return { value: part.date, isAllDay: true };
  return { value: "", isAllDay: false };
}

// Google stocke la date de fin d'un événement journée entière de façon
// EXCLUSIVE (le lendemain du dernier jour réel) — un détail d'implémentation
// de l'API, pas la façon dont un humain pense sa propre fin d'événement. On
// ramène ici systématiquement à une date de fin INCLUSIVE (le dernier jour
// réel), pour que list/get/create restent cohérents entre eux et avec ce
// qu'un utilisateur attend en lisant "fin : tel jour".
function parseEventEndTime(part: RawGoogleEventTime | undefined): { value: string; isAllDay: boolean } {
  if (part?.dateTime) return { value: part.dateTime, isAllDay: false };
  if (part?.date) return { value: shiftDateOnly(part.date, -1), isAllDay: true };
  return { value: "", isAllDay: false };
}

function toSummary(raw: RawGoogleEvent): CalendarEventSummary {
  const start = parseEventTime(raw.start);
  const end = parseEventEndTime(raw.end);
  return {
    id: raw.id,
    summary: raw.summary ?? null,
    start: start.value,
    end: end.value,
    isAllDay: start.isAllDay,
    location: raw.location ?? null,
  };
}

export async function listCalendarEvents(
  accessToken: string,
  params: { timeMin: string; timeMax: string; maxResults?: number },
): Promise<CalendarEventSummary[]> {
  const url = new URL(`${CALENDAR_API_BASE}/calendars/primary/events`);
  url.searchParams.set("timeMin", params.timeMin);
  url.searchParams.set("timeMax", params.timeMax);
  url.searchParams.set("singleEvents", "true");
  url.searchParams.set("orderBy", "startTime");
  url.searchParams.set("maxResults", String(params.maxResults ?? 25));

  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!response.ok) {
    throw await parseCalendarErrorResponse(response);
  }

  const body = (await response.json()) as { items?: RawGoogleEvent[] };
  return (body.items ?? []).map(toSummary);
}

export async function getCalendarEvent(
  accessToken: string,
  eventId: string,
): Promise<CalendarEventDetail> {
  const url = `${CALENDAR_API_BASE}/calendars/primary/events/${encodeURIComponent(eventId)}`;
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!response.ok) {
    throw await parseCalendarErrorResponse(response);
  }

  const raw = (await response.json()) as RawGoogleEvent;
  return {
    ...toSummary(raw),
    description: raw.description ?? null,
    attendees: (raw.attendees ?? []).map((a) => ({ email: a.email, responseStatus: a.responseStatus })),
    htmlLink: raw.htmlLink ?? null,
  };
}

export interface CreateCalendarEventInput {
  title: string;
  location?: string | null;
  description?: string | null;
  timezone: string;
  allDay: boolean;
  // Horaire (allDay=false) : ISO 8601 avec offset explicite.
  // Journée entière (allDay=true) : "YYYY-MM-DD", endDateTime INCLUSIVE (le
  // dernier jour réel de l'événement — la conversion vers le format exclusif
  // attendu par Google est faite ici, jamais laissée à l'appelant).
  startDateTime: string;
  endDateTime: string;
}

export async function createCalendarEvent(
  accessToken: string,
  input: CreateCalendarEventInput,
): Promise<CalendarEventDetail> {
  const body = {
    summary: input.title,
    location: input.location ?? undefined,
    description: input.description ?? undefined,
    start: input.allDay
      ? { date: input.startDateTime }
      : { dateTime: input.startDateTime, timeZone: input.timezone },
    end: input.allDay
      ? { date: shiftDateOnly(input.endDateTime, 1) }
      : { dateTime: input.endDateTime, timeZone: input.timezone },
  };

  const response = await fetch(`${CALENDAR_API_BASE}/calendars/primary/events`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw await parseCalendarErrorResponse(response);
  }

  const raw = (await response.json()) as RawGoogleEvent;
  return {
    ...toSummary(raw),
    description: raw.description ?? null,
    attendees: (raw.attendees ?? []).map((a) => ({ email: a.email, responseStatus: a.responseStatus })),
    htmlLink: raw.htmlLink ?? null,
  };
}
