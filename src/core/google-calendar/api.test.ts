import { describe, it, expect, afterEach, vi } from "vitest";
import {
  createCalendarEvent,
  getCalendarEvent,
  GoogleCalendarApiError,
  listCalendarEvents,
} from "@/core/google-calendar/api";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("Google Calendar API — listCalendarEvents", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("transmet timeMin/timeMax/maxResults et retourne les événements normalisés", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        items: [
          {
            id: "evt-1",
            summary: "Dentiste",
            location: "Cabinet",
            start: { dateTime: "2026-08-02T15:00:00+02:00" },
            end: { dateTime: "2026-08-02T16:00:00+02:00" },
          },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const events = await listCalendarEvents("access-token", {
      timeMin: "2026-08-02T00:00:00+02:00",
      timeMax: "2026-08-03T00:00:00+02:00",
    });

    expect(events).toEqual([
      {
        id: "evt-1",
        summary: "Dentiste",
        start: "2026-08-02T15:00:00+02:00",
        end: "2026-08-02T16:00:00+02:00",
        isAllDay: false,
        location: "Cabinet",
      },
    ]);

    const call = fetchMock.mock.calls[0];
    if (!call) throw new Error("fetch aurait dû être appelé");
    const calledUrl = new URL(call[0] as string);
    expect(calledUrl.searchParams.get("timeMin")).toBe("2026-08-02T00:00:00+02:00");
    expect(calledUrl.searchParams.get("timeMax")).toBe("2026-08-03T00:00:00+02:00");
    expect(calledUrl.searchParams.get("singleEvents")).toBe("true");

    const headers = (call[1] as { headers: Record<string, string> }).headers;
    expect(headers.Authorization).toBe("Bearer access-token");
  });

  it("distingue un événement journée entière (date) d'un événement horodaté (dateTime)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(200, {
          items: [
            {
              id: "evt-allday",
              summary: "Anniversaire",
              start: { date: "2026-08-05" },
              end: { date: "2026-08-06" },
            },
          ],
        }),
      ),
    );

    const events = await listCalendarEvents("token", {
      timeMin: "2026-08-01T00:00:00+02:00",
      timeMax: "2026-08-10T00:00:00+02:00",
    });

    // Google stocke la fin d'un événement journée entière de façon exclusive
    // (le lendemain du dernier jour réel) : "2026-08-06" brut redevient
    // "2026-08-05" une fois ramené à une fin inclusive (V1.3c).
    expect(events[0]).toMatchObject({ isAllDay: true, start: "2026-08-05", end: "2026-08-05" });
  });

  it("retourne une liste vide si Google ne renvoie aucun item", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(200, {})));
    const events = await listCalendarEvents("token", {
      timeMin: "2026-08-01T00:00:00+02:00",
      timeMax: "2026-08-10T00:00:00+02:00",
    });
    expect(events).toEqual([]);
  });

  it("lève GoogleCalendarApiError avec le statut HTTP en cas d'échec", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(401, { error: { message: "Invalid Credentials" } }),
      ),
    );

    await expect(
      listCalendarEvents("expired-token", {
        timeMin: "2026-08-01T00:00:00+02:00",
        timeMax: "2026-08-10T00:00:00+02:00",
      }),
    ).rejects.toMatchObject({ status: 401, message: "Invalid Credentials" });
  });
});

describe("Google Calendar API — getCalendarEvent", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("retourne le détail complet d'un événement, incluant les participants", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(200, {
          id: "evt-1",
          summary: "Réunion projet",
          description: "Point d'avancement",
          location: "Salle B",
          htmlLink: "https://calendar.google.com/event?eid=xyz",
          start: { dateTime: "2026-08-02T10:00:00+02:00" },
          end: { dateTime: "2026-08-02T11:00:00+02:00" },
          attendees: [{ email: "a@example.com", responseStatus: "accepted" }],
        }),
      ),
    );

    const event = await getCalendarEvent("token", "evt-1");

    expect(event).toEqual({
      id: "evt-1",
      summary: "Réunion projet",
      start: "2026-08-02T10:00:00+02:00",
      end: "2026-08-02T11:00:00+02:00",
      isAllDay: false,
      location: "Salle B",
      description: "Point d'avancement",
      attendees: [{ email: "a@example.com", responseStatus: "accepted" }],
      htmlLink: "https://calendar.google.com/event?eid=xyz",
    });
  });

  it("échoue avec GoogleCalendarApiError (404) si l'événement n'existe pas", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse(404, { error: { message: "Not Found" } })),
    );

    await expect(getCalendarEvent("token", "unknown-id")).rejects.toBeInstanceOf(
      GoogleCalendarApiError,
    );
  });

  it("encode correctement l'identifiant d'événement dans l'URL", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        id: "evt with space",
        start: { dateTime: "2026-08-02T10:00:00+02:00" },
        end: { dateTime: "2026-08-02T11:00:00+02:00" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await getCalendarEvent("token", "evt with space");

    const call = fetchMock.mock.calls[0];
    if (!call) throw new Error("fetch aurait dû être appelé");
    expect(call[0] as string).toContain(encodeURIComponent("evt with space"));
  });
});

describe("Google Calendar API — createCalendarEvent", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("envoie dateTime + timeZone pour un événement horaire", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        id: "new-evt",
        summary: "Dentiste",
        start: { dateTime: "2026-08-02T15:00:00+02:00", timeZone: "Europe/Paris" },
        end: { dateTime: "2026-08-02T16:00:00+02:00", timeZone: "Europe/Paris" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const event = await createCalendarEvent("token", {
      title: "Dentiste",
      timezone: "Europe/Paris",
      allDay: false,
      startDateTime: "2026-08-02T15:00:00+02:00",
      endDateTime: "2026-08-02T16:00:00+02:00",
    });

    expect(event).toMatchObject({ id: "new-evt", start: "2026-08-02T15:00:00+02:00" });

    const call = fetchMock.mock.calls[0];
    if (!call) throw new Error("fetch aurait dû être appelé");
    expect(call[0]).toBe("https://www.googleapis.com/calendar/v3/calendars/primary/events");
    const options = call[1] as { method: string; body: string; headers: Record<string, string> };
    expect(options.method).toBe("POST");
    expect(options.headers.Authorization).toBe("Bearer token");
    const sentBody = JSON.parse(options.body);
    expect(sentBody).toEqual({
      summary: "Dentiste",
      start: { dateTime: "2026-08-02T15:00:00+02:00", timeZone: "Europe/Paris" },
      end: { dateTime: "2026-08-02T16:00:00+02:00", timeZone: "Europe/Paris" },
    });
  });

  it("convertit une fin inclusive en fin exclusive (+1 jour) pour un événement journée entière", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        id: "new-allday",
        summary: "Anniversaire de maman",
        start: { date: "2026-08-08" },
        end: { date: "2026-08-09" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await createCalendarEvent("token", {
      title: "Anniversaire de maman",
      timezone: "Europe/Paris",
      allDay: true,
      startDateTime: "2026-08-08",
      endDateTime: "2026-08-08", // même jour, inclusif
    });

    const call = fetchMock.mock.calls[0];
    if (!call) throw new Error("fetch aurait dû être appelé");
    const options = call[1] as { body: string };
    const sentBody = JSON.parse(options.body);
    expect(sentBody.start).toEqual({ date: "2026-08-08" });
    expect(sentBody.end).toEqual({ date: "2026-08-09" });
  });

  it("le résultat retourné reste en fin inclusive, cohérent avec l'entrée", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(200, {
          id: "new-allday",
          summary: "Anniversaire de maman",
          start: { date: "2026-08-08" },
          end: { date: "2026-08-09" },
        }),
      ),
    );

    const event = await createCalendarEvent("token", {
      title: "Anniversaire de maman",
      timezone: "Europe/Paris",
      allDay: true,
      startDateTime: "2026-08-08",
      endDateTime: "2026-08-08",
    });

    expect(event).toMatchObject({ start: "2026-08-08", end: "2026-08-08", isAllDay: true });
  });

  it("omet lieu et description quand ils ne sont pas fournis", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        id: "new-evt",
        summary: "Réunion",
        start: { dateTime: "2026-08-02T15:00:00+02:00" },
        end: { dateTime: "2026-08-02T16:00:00+02:00" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await createCalendarEvent("token", {
      title: "Réunion",
      timezone: "Europe/Paris",
      allDay: false,
      startDateTime: "2026-08-02T15:00:00+02:00",
      endDateTime: "2026-08-02T16:00:00+02:00",
    });

    const call = fetchMock.mock.calls[0];
    if (!call) throw new Error("fetch aurait dû être appelé");
    const options = call[1] as { body: string };
    const sentBody = JSON.parse(options.body);
    expect(sentBody.location).toBeUndefined();
    expect(sentBody.description).toBeUndefined();
  });

  it("lève GoogleCalendarApiError en cas d'échec de création", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse(400, { error: { message: "Invalid time range" } })),
    );

    await expect(
      createCalendarEvent("token", {
        title: "Test",
        timezone: "Europe/Paris",
        allDay: false,
        startDateTime: "2026-08-02T16:00:00+02:00",
        endDateTime: "2026-08-02T15:00:00+02:00",
      }),
    ).rejects.toBeInstanceOf(GoogleCalendarApiError);
  });
});
