import { describe, it, expect } from "vitest";
import { formatNowInTimezone, isValidIanaTimezone } from "@/lib/timezone";

describe("isValidIanaTimezone", () => {
  it("accepte des identifiants IANA valides", () => {
    expect(isValidIanaTimezone("Europe/Paris")).toBe(true);
    expect(isValidIanaTimezone("America/New_York")).toBe(true);
    expect(isValidIanaTimezone("Asia/Tokyo")).toBe(true);
    expect(isValidIanaTimezone("UTC")).toBe(true);
  });

  it("refuse un offset fixe plutôt qu'un identifiant IANA", () => {
    expect(isValidIanaTimezone("+02:00")).toBe(false);
    expect(isValidIanaTimezone("GMT+2")).toBe(false);
  });

  it("refuse une chaîne invalide ou vide", () => {
    expect(isValidIanaTimezone("")).toBe(false);
    expect(isValidIanaTimezone("Not/AZone")).toBe(false);
    expect(isValidIanaTimezone("n'importe quoi")).toBe(false);
  });
});

describe("formatNowInTimezone — heure d'été / heure d'hiver", () => {
  it("applique +01:00 pour Europe/Paris en hiver (heure d'hiver, pas de DST)", () => {
    const winter = new Date("2026-01-15T12:00:00Z");
    const formatted = formatNowInTimezone("Europe/Paris", winter);
    expect(formatted).toBe("2026-01-15T13:00:00+01:00");
  });

  it("applique +02:00 pour Europe/Paris en été (heure d'été, DST active)", () => {
    const summer = new Date("2026-07-15T12:00:00Z");
    const formatted = formatNowInTimezone("Europe/Paris", summer);
    expect(formatted).toBe("2026-07-15T14:00:00+02:00");
  });

  it("gère correctement le changement d'heure lui-même (transition de printemps)", () => {
    // Passage heure d'été en France en 2026 : nuit du 29 mars, 2h -> 3h.
    const beforeTransition = new Date("2026-03-29T00:30:00Z"); // 01:30 CET (+01:00)
    const afterTransition = new Date("2026-03-29T01:30:00Z"); // 03:30 CEST (+02:00)

    expect(formatNowInTimezone("Europe/Paris", beforeTransition)).toBe(
      "2026-03-29T01:30:00+01:00",
    );
    expect(formatNowInTimezone("Europe/Paris", afterTransition)).toBe(
      "2026-03-29T03:30:00+02:00",
    );
  });

  it("gère un fuseau sans changement d'heure (UTC)", () => {
    expect(formatNowInTimezone("UTC", new Date("2026-07-15T12:00:00Z"))).toBe(
      "2026-07-15T12:00:00+00:00",
    );
  });

  it("gère un fuseau à offset négatif (America/New_York)", () => {
    const summer = new Date("2026-07-15T12:00:00Z"); // EDT = UTC-4 en été
    expect(formatNowInTimezone("America/New_York", summer)).toBe(
      "2026-07-15T08:00:00-04:00",
    );
  });

  it("le résultat est toujours acceptable par un schéma ISO 8601 avec offset explicite", () => {
    const formatted = formatNowInTimezone("Asia/Tokyo", new Date("2026-07-15T12:00:00Z"));
    expect(formatted).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
  });
});
