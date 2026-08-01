// Résolution du fuseau horaire IANA de l'utilisateur — jamais un simple
// offset fixe (un offset ne survit pas au changement heure d'été/hiver, un
// identifiant IANA comme "Europe/Paris" oui). Utilisé par le Context Engine
// et par le prompt système pour donner au modèle une date/heure actuelle
// fiable, plutôt que de le laisser deviner.
// La liste réelle de la base IANA telle qu'exposée par le moteur JS — plus
// stricte que "construire Intl.DateTimeFormat sans lever d'erreur", qui
// accepte à tort des offsets fixes comme "+02:00" (spec ECMA-402 récente).
// C'est précisément ce qu'on doit refuser ici.
const IANA_TIMEZONES = new Set(Intl.supportedValuesOf("timeZone"));

export function isValidIanaTimezone(timezone: string): boolean {
  return timezone === "UTC" || IANA_TIMEZONES.has(timezone);
}

// Date/heure courante formatée en ISO 8601 avec l'offset réel de `timezone`
// à cet instant précis (donc correct de part et d'autre d'un changement
// heure d'été/hiver, contrairement à un offset fixe stocké une fois pour
// toutes).
export function formatNowInTimezone(timezone: string, now: Date = new Date()): string {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

  const parts = formatter.formatToParts(now);
  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? "00";

  const year = get("year");
  const month = get("month");
  const day = get("day");
  const minute = get("minute");
  const second = get("second");
  // Certaines implémentations rendent minuit "24" plutôt que "00" en hour12:false.
  const hour = get("hour") === "24" ? "00" : get("hour");

  const asUtc = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
  );
  const offsetMinutesTotal = Math.round((asUtc - now.getTime()) / 60_000);
  const sign = offsetMinutesTotal >= 0 ? "+" : "-";
  const absMinutes = Math.abs(offsetMinutesTotal);
  const offsetHours = String(Math.floor(absMinutes / 60)).padStart(2, "0");
  const offsetRemainderMinutes = String(absMinutes % 60).padStart(2, "0");

  return `${year}-${month}-${day}T${hour}:${minute}:${second}${sign}${offsetHours}:${offsetRemainderMinutes}`;
}
