import { describe, it, expect, afterEach, vi } from "vitest";
import { getCalendarEvent, GoogleCalendarApiError, listCalendarEvents } from "@/core/google-calendar/api";

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

    expect(events[0]).toMatchObject({ isAllDay: true, start: "2026-08-05", end: "2026-08-06" });
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
