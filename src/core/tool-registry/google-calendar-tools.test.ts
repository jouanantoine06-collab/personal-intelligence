import { describe, it, expect, beforeEach, vi } from "vitest";
import { getTool } from "@/core/tool-registry/index";
import { registerGoogleCalendarTools } from "@/core/tool-registry/google-calendar-tools";
import { GoogleCalendarApiError } from "@/core/google-calendar/api";
import {
  ensureFreshAccessToken,
  GoogleCalendarReconnectRequiredError,
  markConnectionError,
} from "@/core/google-calendar/connections";
import { getCalendarEvent, listCalendarEvents } from "@/core/google-calendar/api";

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
