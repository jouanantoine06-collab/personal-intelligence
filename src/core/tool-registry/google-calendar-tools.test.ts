import { describe, it, expect, beforeEach, vi } from "vitest";
import { getTool } from "@/core/tool-registry/index";
import { registerGoogleCalendarTools } from "@/core/tool-registry/google-calendar-tools";
import { GoogleCalendarApiError } from "@/core/google-calendar/api";
import {
  ensureFreshAccessToken,
  GoogleCalendarReconnectRequiredError,
  markConnectionError,
} from "@/core/google-calendar/connections";
import {
  createCalendarEvent,
  deleteCalendarEvent,
  getCalendarEvent,
  listCalendarEvents,
  updateCalendarEvent,
} from "@/core/google-calendar/api";

vi.mock("@/lib/supabase/service-role", () => ({
  createServiceRoleClient: vi.fn(() => ({})),
}));

vi.mock("@/core/google-calendar/connections", () => ({
  ensureFreshAccessToken: vi.fn(),
  markConnectionError: vi.fn(),
  GoogleCalendarReconnectRequiredError: class extends Error {},
}));

vi.mock("@/core/google-calendar/api", async () => {
  const actual = await vi.importActual<typeof import("@/core/google-calendar/api")>(
    "@/core/google-calendar/api",
  );
  return {
    ...actual,
    listCalendarEvents: vi.fn(),
    getCalendarEvent: vi.fn(),
    createCalendarEvent: vi.fn(),
    updateCalendarEvent: vi.fn(),
    deleteCalendarEvent: vi.fn(),
  };
});

registerGoogleCalendarTools();

describe("list_calendar_events — schéma d'entrée", () => {
  const tool = getTool("list_calendar_events")!;

  it("est classé no_risk", () => {
    expect(tool.riskLevel).toBe("no_risk");
  });

  it("accepte des dates ISO 8601 avec offset explicite", () => {
    expect(() =>
      tool.parseInput({
        timeMin: "2026-08-02T00:00:00+02:00",
        timeMax: "2026-08-03T00:00:00+02:00",
      }),
    ).not.toThrow();
  });

  it("refuse une date sans offset", () => {
    expect(() =>
      tool.parseInput({ timeMin: "2026-08-02T00:00:00", timeMax: "2026-08-03T00:00:00" }),
    ).toThrow();
  });

  it("refuse une expression relative ('demain')", () => {
    expect(() => tool.parseInput({ timeMin: "demain", timeMax: "après-demain" })).toThrow();
  });

  it("refuse une date sans heure (date seule)", () => {
    expect(() => tool.parseInput({ timeMin: "2026-08-02", timeMax: "2026-08-03" })).toThrow();
  });

  it("refuse une chaîne invalide", () => {
    expect(() => tool.parseInput({ timeMin: "n'importe quoi", timeMax: "toujours" })).toThrow();
  });

  it("refuse un champ additionnel non prévu", () => {
    expect(() =>
      tool.parseInput({
        timeMin: "2026-08-02T00:00:00+02:00",
        timeMax: "2026-08-03T00:00:00+02:00",
        extra: "champ non prévu",
      }),
    ).toThrow();
  });

  it("accepte maxResults optionnel dans les bornes", () => {
    expect(() =>
      tool.parseInput({
        timeMin: "2026-08-02T00:00:00+02:00",
        timeMax: "2026-08-03T00:00:00+02:00",
        maxResults: 10,
      }),
    ).not.toThrow();
  });

  it("refuse maxResults hors bornes", () => {
    expect(() =>
      tool.parseInput({
        timeMin: "2026-08-02T00:00:00+02:00",
        timeMax: "2026-08-03T00:00:00+02:00",
        maxResults: 500,
      }),
    ).toThrow();
  });
});

describe("get_calendar_event — schéma d'entrée", () => {
  const tool = getTool("get_calendar_event")!;

  it("est classé no_risk", () => {
    expect(tool.riskLevel).toBe("no_risk");
  });

  it("accepte un eventId non vide", () => {
    expect(() => tool.parseInput({ eventId: "abc123" })).not.toThrow();
  });

  it("refuse un eventId vide ou absent", () => {
    expect(() => tool.parseInput({ eventId: "" })).toThrow();
    expect(() => tool.parseInput({})).toThrow();
  });
});

describe("create_calendar_event — schéma d'entrée", () => {
  const tool = getTool("create_calendar_event")!;

  it("est classé external (confirmation toujours obligatoire)", () => {
    expect(tool.riskLevel).toBe("external");
  });

  it("accepte un événement horaire valide", () => {
    expect(() =>
      tool.parseInput({
        title: "Dentiste",
        allDay: false,
        startDateTime: "2026-08-02T15:00:00+02:00",
        endDateTime: "2026-08-02T16:00:00+02:00",
        timezone: "Europe/Paris",
      }),
    ).not.toThrow();
  });

  it("accepte un événement journée entière valide (endDateTime inclusif)", () => {
    expect(() =>
      tool.parseInput({
        title: "Anniversaire de maman",
        allDay: true,
        startDateTime: "2026-08-08",
        endDateTime: "2026-08-08",
        timezone: "Europe/Paris",
      }),
    ).not.toThrow();
  });

  it("accepte lieu et description optionnels", () => {
    expect(() =>
      tool.parseInput({
        title: "Réunion Verdict",
        allDay: false,
        startDateTime: "2026-08-07T09:00:00+02:00",
        endDateTime: "2026-08-07T11:00:00+02:00",
        timezone: "Europe/Paris",
        location: "Bureau",
        description: "Point d'avancement",
      }),
    ).not.toThrow();
  });

  it("refuse un événement horaire sans offset explicite", () => {
    expect(() =>
      tool.parseInput({
        title: "Dentiste",
        allDay: false,
        startDateTime: "2026-08-02T15:00:00",
        endDateTime: "2026-08-02T16:00:00",
        timezone: "Europe/Paris",
      }),
    ).toThrow();
  });

  it("refuse un fuseau horaire invalide (offset fixe ou chaîne arbitraire)", () => {
    expect(() =>
      tool.parseInput({
        title: "Dentiste",
        allDay: false,
        startDateTime: "2026-08-02T15:00:00+02:00",
        endDateTime: "2026-08-02T16:00:00+02:00",
        timezone: "+02:00",
      }),
    ).toThrow();
    expect(() =>
      tool.parseInput({
        title: "Dentiste",
        allDay: false,
        startDateTime: "2026-08-02T15:00:00+02:00",
        endDateTime: "2026-08-02T16:00:00+02:00",
        timezone: "n'importe quoi",
      }),
    ).toThrow();
  });

  it("refuse une fin antérieure ou égale au début pour un événement horaire", () => {
    expect(() =>
      tool.parseInput({
        title: "Dentiste",
        allDay: false,
        startDateTime: "2026-08-02T16:00:00+02:00",
        endDateTime: "2026-08-02T15:00:00+02:00",
        timezone: "Europe/Paris",
      }),
    ).toThrow();
    expect(() =>
      tool.parseInput({
        title: "Dentiste",
        allDay: false,
        startDateTime: "2026-08-02T15:00:00+02:00",
        endDateTime: "2026-08-02T15:00:00+02:00",
        timezone: "Europe/Paris",
      }),
    ).toThrow(/postérieur/);
  });

  it("refuse une fin antérieure au début pour un événement journée entière", () => {
    expect(() =>
      tool.parseInput({
        title: "Voyage",
        allDay: true,
        startDateTime: "2026-08-10",
        endDateTime: "2026-08-08",
        timezone: "Europe/Paris",
      }),
    ).toThrow(/inclus/);
  });

  it("refuse une expression relative dans startDateTime/endDateTime", () => {
    expect(() =>
      tool.parseInput({
        title: "Dentiste",
        allDay: false,
        startDateTime: "demain",
        endDateTime: "demain plus tard",
        timezone: "Europe/Paris",
      }),
    ).toThrow();
  });

  it("refuse une durée manquante (endDateTime absent) plutôt que de la déduire silencieusement", () => {
    expect(() =>
      tool.parseInput({
        title: "Dentiste",
        allDay: false,
        startDateTime: "2026-08-02T15:00:00+02:00",
        timezone: "Europe/Paris",
      }),
    ).toThrow();
  });

  it("refuse un fuseau horaire absent", () => {
    expect(() =>
      tool.parseInput({
        title: "Dentiste",
        allDay: false,
        startDateTime: "2026-08-02T15:00:00+02:00",
        endDateTime: "2026-08-02T16:00:00+02:00",
      }),
    ).toThrow();
  });

  it("refuse un événement horaire sans titre", () => {
    expect(() =>
      tool.parseInput({
        title: "",
        allDay: false,
        startDateTime: "2026-08-02T15:00:00+02:00",
        endDateTime: "2026-08-02T16:00:00+02:00",
        timezone: "Europe/Paris",
      }),
    ).toThrow();
  });

  it("refuse un champ additionnel non prévu", () => {
    expect(() =>
      tool.parseInput({
        title: "Dentiste",
        allDay: false,
        startDateTime: "2026-08-02T15:00:00+02:00",
        endDateTime: "2026-08-02T16:00:00+02:00",
        timezone: "Europe/Paris",
        extra: "non prévu",
      }),
    ).toThrow();
  });

  it("refuse un mélange de champs journée entière et horaire (date seule avec allDay=false)", () => {
    expect(() =>
      tool.parseInput({
        title: "Dentiste",
        allDay: false,
        startDateTime: "2026-08-02",
        endDateTime: "2026-08-02T16:00:00+02:00",
        timezone: "Europe/Paris",
      }),
    ).toThrow();
  });
});

describe("create_calendar_event — exécution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("appelle createCalendarEvent avec le token de l'utilisateur et le payload figé", async () => {
    const tool = getTool("create_calendar_event")!;
    vi.mocked(ensureFreshAccessToken).mockResolvedValue("token-a");
    vi.mocked(createCalendarEvent).mockResolvedValue({
      id: "evt-new",
      summary: "Dentiste",
      start: "2026-08-02T15:00:00+02:00",
      end: "2026-08-02T16:00:00+02:00",
      isAllDay: false,
      location: null,
      description: null,
      attendees: [],
      htmlLink: null,
    });

    const input = tool.parseInput({
      title: "Dentiste",
      allDay: false,
      startDateTime: "2026-08-02T15:00:00+02:00",
      endDateTime: "2026-08-02T16:00:00+02:00",
      timezone: "Europe/Paris",
    });

    const result = await tool.execute(input, { supabase: {} as never, userId: "user-a" });

    expect(ensureFreshAccessToken).toHaveBeenCalledWith(expect.anything(), "user-a");
    expect(createCalendarEvent).toHaveBeenCalledWith("token-a", input);
    expect((result as { event: { id: string } }).event.id).toBe("evt-new");
  });

  it("deux utilisateurs différents utilisent chacun leur propre token, jamais celui de l'autre", async () => {
    const tool = getTool("create_calendar_event")!;
    vi.mocked(ensureFreshAccessToken).mockImplementation(async (_client, userId) =>
      userId === "user-a" ? "token-a" : "token-b",
    );
    vi.mocked(createCalendarEvent).mockResolvedValue({
      id: "evt-new",
      summary: "Test",
      start: "2026-08-02T15:00:00+02:00",
      end: "2026-08-02T16:00:00+02:00",
      isAllDay: false,
      location: null,
      description: null,
      attendees: [],
      htmlLink: null,
    });

    const input = tool.parseInput({
      title: "Test",
      allDay: false,
      startDateTime: "2026-08-02T15:00:00+02:00",
      endDateTime: "2026-08-02T16:00:00+02:00",
      timezone: "Europe/Paris",
    });

    await tool.execute(input, { supabase: {} as never, userId: "user-a" });
    await tool.execute(input, { supabase: {} as never, userId: "user-b" });

    expect(vi.mocked(createCalendarEvent).mock.calls[0]?.[0]).toBe("token-a");
    expect(vi.mocked(createCalendarEvent).mock.calls[1]?.[0]).toBe("token-b");
  });

  it("propage l'erreur de reconnexion sans jamais appeler createCalendarEvent si aucune connexion n'existe", async () => {
    const tool = getTool("create_calendar_event")!;
    vi.mocked(ensureFreshAccessToken).mockRejectedValue(
      new GoogleCalendarReconnectRequiredError("aucune connexion enregistrée"),
    );

    const input = tool.parseInput({
      title: "Dentiste",
      allDay: false,
      startDateTime: "2026-08-02T15:00:00+02:00",
      endDateTime: "2026-08-02T16:00:00+02:00",
      timezone: "Europe/Paris",
    });

    await expect(
      tool.execute(input, { supabase: {} as never, userId: "user-a" }),
    ).rejects.toThrow(GoogleCalendarReconnectRequiredError);
    expect(createCalendarEvent).not.toHaveBeenCalled();
  });

  it("marque la connexion en erreur et invite à reconnecter sur un 401 de Google à la création", async () => {
    const tool = getTool("create_calendar_event")!;
    vi.mocked(ensureFreshAccessToken).mockResolvedValue("stale-token");
    vi.mocked(createCalendarEvent).mockRejectedValue(
      new GoogleCalendarApiError(401, "Invalid Credentials"),
    );

    const input = tool.parseInput({
      title: "Dentiste",
      allDay: false,
      startDateTime: "2026-08-02T15:00:00+02:00",
      endDateTime: "2026-08-02T16:00:00+02:00",
      timezone: "Europe/Paris",
    });

    await expect(
      tool.execute(input, { supabase: {} as never, userId: "user-a" }),
    ).rejects.toThrow(/reconnecte/i);
    expect(markConnectionError).toHaveBeenCalledWith(expect.anything(), "user-a", expect.any(String));
  });

  it("une erreur Google autre que 401 (ex: 400 créneau invalide) n'affirme jamais un succès et n'altère pas le statut", async () => {
    const tool = getTool("create_calendar_event")!;
    vi.mocked(ensureFreshAccessToken).mockResolvedValue("token-a");
    vi.mocked(createCalendarEvent).mockRejectedValue(
      new GoogleCalendarApiError(400, "Invalid time range"),
    );

    const input = tool.parseInput({
      title: "Dentiste",
      allDay: false,
      startDateTime: "2026-08-02T15:00:00+02:00",
      endDateTime: "2026-08-02T16:00:00+02:00",
      timezone: "Europe/Paris",
    });

    await expect(
      tool.execute(input, { supabase: {} as never, userId: "user-a" }),
    ).rejects.toBeInstanceOf(GoogleCalendarApiError);
    expect(markConnectionError).not.toHaveBeenCalled();
  });
});

describe("Outils calendrier — exécution, isolation utilisateur, renouvellement", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("list_calendar_events récupère le token du BON utilisateur puis appelle l'API avec", async () => {
    const tool = getTool("list_calendar_events")!;
    vi.mocked(ensureFreshAccessToken).mockImplementation(async (_client, userId) =>
      userId === "user-a" ? "token-a" : "token-b",
    );
    vi.mocked(listCalendarEvents).mockResolvedValue([]);

    const input = tool.parseInput({
      timeMin: "2026-08-02T00:00:00+02:00",
      timeMax: "2026-08-03T00:00:00+02:00",
    });

    await tool.execute(input, { supabase: {} as never, userId: "user-a" });

    expect(ensureFreshAccessToken).toHaveBeenCalledWith(expect.anything(), "user-a");
    expect(listCalendarEvents).toHaveBeenCalledWith("token-a", input);
  });

  it("deux utilisateurs différents ne partagent jamais le même token entre deux exécutions", async () => {
    const tool = getTool("list_calendar_events")!;
    vi.mocked(ensureFreshAccessToken).mockImplementation(async (_client, userId) =>
      userId === "user-a" ? "token-a" : "token-b",
    );
    vi.mocked(listCalendarEvents).mockResolvedValue([]);

    const input = tool.parseInput({
      timeMin: "2026-08-02T00:00:00+02:00",
      timeMax: "2026-08-03T00:00:00+02:00",
    });

    await tool.execute(input, { supabase: {} as never, userId: "user-a" });
    await tool.execute(input, { supabase: {} as never, userId: "user-b" });

    expect(vi.mocked(listCalendarEvents).mock.calls[0]?.[0]).toBe("token-a");
    expect(vi.mocked(listCalendarEvents).mock.calls[1]?.[0]).toBe("token-b");
  });

  it("get_calendar_event propage l'erreur de reconnexion si aucune connexion n'existe (jamais silencieux)", async () => {
    const tool = getTool("get_calendar_event")!;
    vi.mocked(ensureFreshAccessToken).mockRejectedValue(
      new GoogleCalendarReconnectRequiredError("aucune connexion enregistrée"),
    );

    await expect(
      tool.execute({ eventId: "evt-1" }, { supabase: {} as never, userId: "user-a" }),
    ).rejects.toThrow(GoogleCalendarReconnectRequiredError);
    expect(getCalendarEvent).not.toHaveBeenCalled();
  });

  it("marque la connexion en erreur et invite à reconnecter sur un 401 de l'API Calendar elle-même", async () => {
    const tool = getTool("get_calendar_event")!;
    vi.mocked(ensureFreshAccessToken).mockResolvedValue("stale-token");
    vi.mocked(getCalendarEvent).mockRejectedValue(new GoogleCalendarApiError(401, "Invalid Credentials"));

    await expect(
      tool.execute({ eventId: "evt-1" }, { supabase: {} as never, userId: "user-a" }),
    ).rejects.toThrow(/reconnecte/i);

    expect(markConnectionError).toHaveBeenCalledWith(expect.anything(), "user-a", expect.any(String));
  });

  it("une erreur Google autre que 401 (ex: 500) n'altère pas le statut de la connexion", async () => {
    const tool = getTool("list_calendar_events")!;
    vi.mocked(ensureFreshAccessToken).mockResolvedValue("token-a");
    vi.mocked(listCalendarEvents).mockRejectedValue(new GoogleCalendarApiError(500, "Backend Error"));

    const input = tool.parseInput({
      timeMin: "2026-08-02T00:00:00+02:00",
      timeMax: "2026-08-03T00:00:00+02:00",
    });

    await expect(
      tool.execute(input, { supabase: {} as never, userId: "user-a" }),
    ).rejects.toBeInstanceOf(GoogleCalendarApiError);
    expect(markConnectionError).not.toHaveBeenCalled();
  });
});

const VALID_UPDATE_INPUT = {
  eventId: "evt-1",
  title: "Dentiste (décalé)",
  allDay: false,
  startDateTime: "2026-08-02T16:00:00+02:00",
  endDateTime: "2026-08-02T17:00:00+02:00",
  timezone: "Europe/Paris",
};

describe("update_calendar_event — schéma d'entrée", () => {
  const tool = getTool("update_calendar_event")!;

  it("est classé external (confirmation toujours obligatoire)", () => {
    expect(tool.riskLevel).toBe("external");
  });

  it("accepte une modification horaire complète et valide", () => {
    expect(() => tool.parseInput(VALID_UPDATE_INPUT)).not.toThrow();
  });

  it("accepte une modification vers un événement journée entière", () => {
    expect(() =>
      tool.parseInput({
        eventId: "evt-1",
        title: "Anniversaire",
        allDay: true,
        startDateTime: "2026-08-09",
        endDateTime: "2026-08-09",
        timezone: "Europe/Paris",
      }),
    ).not.toThrow();
  });

  it("refuse un eventId manquant", () => {
    const withoutEventId: Record<string, unknown> = { ...VALID_UPDATE_INPUT };
    delete withoutEventId.eventId;
    expect(() => tool.parseInput(withoutEventId)).toThrow();
  });

  it("refuse une date sans offset explicite", () => {
    expect(() =>
      tool.parseInput({ ...VALID_UPDATE_INPUT, startDateTime: "2026-08-02T16:00:00" }),
    ).toThrow();
  });

  it("refuse un fuseau horaire invalide", () => {
    expect(() => tool.parseInput({ ...VALID_UPDATE_INPUT, timezone: "+02:00" })).toThrow();
  });

  it("refuse une fin antérieure ou égale au début", () => {
    expect(() =>
      tool.parseInput({
        ...VALID_UPDATE_INPUT,
        startDateTime: "2026-08-02T17:00:00+02:00",
        endDateTime: "2026-08-02T16:00:00+02:00",
      }),
    ).toThrow();
  });

  it("refuse un champ additionnel non prévu", () => {
    expect(() => tool.parseInput({ ...VALID_UPDATE_INPUT, extra: "non prévu" })).toThrow();
  });
});

describe("update_calendar_event — exécution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("appelle updateCalendarEvent avec l'eventId, le token de l'utilisateur et le contenu figé", async () => {
    const tool = getTool("update_calendar_event")!;
    vi.mocked(ensureFreshAccessToken).mockResolvedValue("token-a");
    vi.mocked(updateCalendarEvent).mockResolvedValue({
      id: "evt-1",
      summary: "Dentiste (décalé)",
      start: "2026-08-02T16:00:00+02:00",
      end: "2026-08-02T17:00:00+02:00",
      isAllDay: false,
      location: null,
      description: null,
      attendees: [],
      htmlLink: null,
    });

    const input = tool.parseInput(VALID_UPDATE_INPUT);
    const result = await tool.execute(input, { supabase: {} as never, userId: "user-a" });

    expect(ensureFreshAccessToken).toHaveBeenCalledWith(expect.anything(), "user-a");
    expect(updateCalendarEvent).toHaveBeenCalledWith("token-a", "evt-1", input);
    expect((result as { event: { id: string } }).event.id).toBe("evt-1");
  });

  it("deux utilisateurs différents utilisent chacun leur propre token", async () => {
    const tool = getTool("update_calendar_event")!;
    vi.mocked(ensureFreshAccessToken).mockImplementation(async (_client, userId) =>
      userId === "user-a" ? "token-a" : "token-b",
    );
    vi.mocked(updateCalendarEvent).mockResolvedValue({
      id: "evt-1",
      summary: "Test",
      start: "2026-08-02T16:00:00+02:00",
      end: "2026-08-02T17:00:00+02:00",
      isAllDay: false,
      location: null,
      description: null,
      attendees: [],
      htmlLink: null,
    });

    const input = tool.parseInput(VALID_UPDATE_INPUT);
    await tool.execute(input, { supabase: {} as never, userId: "user-a" });
    await tool.execute(input, { supabase: {} as never, userId: "user-b" });

    expect(vi.mocked(updateCalendarEvent).mock.calls[0]?.[0]).toBe("token-a");
    expect(vi.mocked(updateCalendarEvent).mock.calls[1]?.[0]).toBe("token-b");
  });

  it("marque la connexion en erreur et invite à reconnecter sur un 401", async () => {
    const tool = getTool("update_calendar_event")!;
    vi.mocked(ensureFreshAccessToken).mockResolvedValue("stale-token");
    vi.mocked(updateCalendarEvent).mockRejectedValue(new GoogleCalendarApiError(401, "Invalid Credentials"));

    const input = tool.parseInput(VALID_UPDATE_INPUT);
    await expect(
      tool.execute(input, { supabase: {} as never, userId: "user-a" }),
    ).rejects.toThrow(/reconnecte/i);
    expect(markConnectionError).toHaveBeenCalledWith(expect.anything(), "user-a", expect.any(String));
  });

  it("une erreur Google autre que 401 (ex: 404 événement introuvable) n'affirme jamais un succès", async () => {
    const tool = getTool("update_calendar_event")!;
    vi.mocked(ensureFreshAccessToken).mockResolvedValue("token-a");
    vi.mocked(updateCalendarEvent).mockRejectedValue(new GoogleCalendarApiError(404, "Not Found"));

    const input = tool.parseInput(VALID_UPDATE_INPUT);
    await expect(
      tool.execute(input, { supabase: {} as never, userId: "user-a" }),
    ).rejects.toBeInstanceOf(GoogleCalendarApiError);
    expect(markConnectionError).not.toHaveBeenCalled();
  });
});

describe("delete_calendar_event — schéma d'entrée", () => {
  const tool = getTool("delete_calendar_event")!;

  it("est classé external (confirmation toujours obligatoire)", () => {
    expect(tool.riskLevel).toBe("external");
  });

  it("accepte un eventId non vide", () => {
    expect(() => tool.parseInput({ eventId: "evt-1" })).not.toThrow();
  });

  it("refuse un eventId vide ou absent", () => {
    expect(() => tool.parseInput({ eventId: "" })).toThrow();
    expect(() => tool.parseInput({})).toThrow();
  });

  it("refuse un champ additionnel non prévu", () => {
    expect(() => tool.parseInput({ eventId: "evt-1", title: "non prévu" })).toThrow();
  });
});

describe("delete_calendar_event — exécution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("appelle deleteCalendarEvent avec l'eventId exact et le token de l'utilisateur", async () => {
    const tool = getTool("delete_calendar_event")!;
    vi.mocked(ensureFreshAccessToken).mockResolvedValue("token-a");
    vi.mocked(deleteCalendarEvent).mockResolvedValue(undefined);

    const input = tool.parseInput({ eventId: "evt-1" });
    const result = await tool.execute(input, { supabase: {} as never, userId: "user-a" });

    expect(ensureFreshAccessToken).toHaveBeenCalledWith(expect.anything(), "user-a");
    expect(deleteCalendarEvent).toHaveBeenCalledWith("token-a", "evt-1");
    expect(result).toEqual({ deleted: true, eventId: "evt-1" });
  });

  it("deux utilisateurs différents utilisent chacun leur propre token", async () => {
    const tool = getTool("delete_calendar_event")!;
    vi.mocked(ensureFreshAccessToken).mockImplementation(async (_client, userId) =>
      userId === "user-a" ? "token-a" : "token-b",
    );
    vi.mocked(deleteCalendarEvent).mockResolvedValue(undefined);

    await tool.execute({ eventId: "evt-1" }, { supabase: {} as never, userId: "user-a" });
    await tool.execute({ eventId: "evt-1" }, { supabase: {} as never, userId: "user-b" });

    expect(vi.mocked(deleteCalendarEvent).mock.calls[0]?.[0]).toBe("token-a");
    expect(vi.mocked(deleteCalendarEvent).mock.calls[1]?.[0]).toBe("token-b");
  });

  it("propage l'erreur de reconnexion sans jamais appeler deleteCalendarEvent si aucune connexion n'existe", async () => {
    const tool = getTool("delete_calendar_event")!;
    vi.mocked(ensureFreshAccessToken).mockRejectedValue(
      new GoogleCalendarReconnectRequiredError("aucune connexion enregistrée"),
    );

    await expect(
      tool.execute({ eventId: "evt-1" }, { supabase: {} as never, userId: "user-a" }),
    ).rejects.toThrow(GoogleCalendarReconnectRequiredError);
    expect(deleteCalendarEvent).not.toHaveBeenCalled();
  });

  it("marque la connexion en erreur et invite à reconnecter sur un 401", async () => {
    const tool = getTool("delete_calendar_event")!;
    vi.mocked(ensureFreshAccessToken).mockResolvedValue("stale-token");
    vi.mocked(deleteCalendarEvent).mockRejectedValue(new GoogleCalendarApiError(401, "Invalid Credentials"));

    await expect(
      tool.execute({ eventId: "evt-1" }, { supabase: {} as never, userId: "user-a" }),
    ).rejects.toThrow(/reconnecte/i);
    expect(markConnectionError).toHaveBeenCalledWith(expect.anything(), "user-a", expect.any(String));
  });

  it("une erreur Google autre que 401 n'affirme jamais un succès et n'altère pas le statut", async () => {
    const tool = getTool("delete_calendar_event")!;
    vi.mocked(ensureFreshAccessToken).mockResolvedValue("token-a");
    vi.mocked(deleteCalendarEvent).mockRejectedValue(new GoogleCalendarApiError(404, "Not Found"));

    await expect(
      tool.execute({ eventId: "evt-1" }, { supabase: {} as never, userId: "user-a" }),
    ).rejects.toBeInstanceOf(GoogleCalendarApiError);
    expect(markConnectionError).not.toHaveBeenCalled();
  });
});
