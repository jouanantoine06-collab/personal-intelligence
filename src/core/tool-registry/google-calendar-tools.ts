// Outils Google Calendar : list_calendar_events / get_calendar_event
// (V1.3b, "no_risk", jamais de confirmation) et create_calendar_event
// (V1.3c, "external" — confirmation toujours obligatoire, via le mécanisme
// générique déjà existant depuis V1.1/V1.2 : aucun changement de Permission
// Gate ni de Tool Executor n'est nécessaire, "external" y est déjà traité
// exactement comme "reversible").
//
// Ces outils utilisent le client Supabase PRIVILÉGIÉ (ADR-0014), jamais le
// client de session reçu dans ToolExecutionContext : ils n'en ont pas besoin
// pour accéder à google_calendar_connections, qui refuse RLS à ce dernier.
import { z } from "zod";
import { registerTool, type ToolDefinition } from "@/core/tool-registry/index";
import { createServiceRoleClient } from "@/lib/supabase/service-role";
import { isValidIanaTimezone } from "@/lib/timezone";
import {
  ensureFreshAccessToken,
  markConnectionError,
} from "@/core/google-calendar/connections";
import {
  type CalendarEventDetail,
  type CalendarEventSummary,
  createCalendarEvent,
  deleteCalendarEvent,
  getCalendarEvent,
  GoogleCalendarApiError,
  listCalendarEvents,
  updateCalendarEvent,
} from "@/core/google-calendar/api";

// ISO 8601 avec offset explicite obligatoire (jamais "Z" implicite par
// défaut, jamais une expression relative) — c'est le schéma, pas le modèle,
// qui refuse toute entrée non conforme.
const isoDateTimeWithOffset = z.string().datetime({ offset: true });

async function withGoogleCalendarErrorHandling<T>(
  userId: string,
  fn: (accessToken: string) => Promise<T>,
): Promise<T> {
  const serviceRoleClient = createServiceRoleClient();
  const accessToken = await ensureFreshAccessToken(serviceRoleClient, userId);

  try {
    return await fn(accessToken);
  } catch (err) {
    if (err instanceof GoogleCalendarApiError && err.status === 401) {
      await markConnectionError(
        serviceRoleClient,
        userId,
        "Google a rejeté le token (401) lors d'un appel Calendar.",
      );
      throw new Error(
        "La connexion Google Calendar n'est plus valide : reconnecte-la via la page Intégrations.",
      );
    }
    throw err;
  }
}

const listEventsInputSchema = z
  .object({
    timeMin: isoDateTimeWithOffset,
    timeMax: isoDateTimeWithOffset,
    maxResults: z.number().int().min(1).max(50).optional(),
  })
  .strict();

const listCalendarEventsTool: ToolDefinition<
  z.infer<typeof listEventsInputSchema>,
  { events: CalendarEventSummary[] }
> = {
  name: "list_calendar_events",
  description:
    "Liste les événements du Google Calendar de l'utilisateur entre deux instants ABSOLUS (ISO 8601 avec offset explicite, jamais une expression relative comme 'demain'). Lecture seule, jamais de confirmation nécessaire.",
  riskLevel: "no_risk",
  requiredPermission: "list_calendar_events",
  aiInputSchema: {
    type: "object",
    properties: {
      timeMin: {
        type: "string",
        description: "Début de la plage, ISO 8601 avec offset explicite (ex: 2026-08-02T00:00:00+02:00).",
      },
      timeMax: {
        type: "string",
        description: "Fin de la plage, ISO 8601 avec offset explicite.",
      },
      maxResults: {
        type: "number",
        description: "Nombre maximum d'événements à retourner (défaut 25).",
      },
    },
    required: ["timeMin", "timeMax"],
    additionalProperties: false,
  },
  parseInput: (raw) => listEventsInputSchema.parse(raw),
  async execute(input, { userId }) {
    const events = await withGoogleCalendarErrorHandling(userId, (accessToken) =>
      listCalendarEvents(accessToken, input),
    );
    return { events };
  },
};

const getEventInputSchema = z
  .object({
    eventId: z.string().min(1),
  })
  .strict();

const getCalendarEventTool: ToolDefinition<
  z.infer<typeof getEventInputSchema>,
  { event: CalendarEventDetail }
> = {
  name: "get_calendar_event",
  description:
    "Récupère le détail complet d'un événement précis du Google Calendar de l'utilisateur, via son identifiant exact (obtenu au préalable via list_calendar_events). Lecture seule, jamais de confirmation nécessaire.",
  riskLevel: "no_risk",
  requiredPermission: "get_calendar_event",
  aiInputSchema: {
    type: "object",
    properties: {
      eventId: { type: "string", description: "Identifiant exact de l'événement." },
    },
    required: ["eventId"],
    additionalProperties: false,
  },
  parseInput: (raw) => getEventInputSchema.parse(raw),
  async execute(input, { userId }) {
    const event = await withGoogleCalendarErrorHandling(userId, (accessToken) =>
      getCalendarEvent(accessToken, input.eventId),
    );
    return { event };
  },
};

// Date seule (jour entier), jamais un horodatage — évite qu'un événement
// journée entière transporte une heure/offset qui n'a pas de sens pour lui.
const dateOnly = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Format attendu : YYYY-MM-DD (jour entier, sans heure).");

const ianaTimezoneSchema = z
  .string()
  .refine(isValidIanaTimezone, { message: "Fuseau horaire IANA invalide (ex: Europe/Paris)." });

const commonCreateEventFields = {
  title: z.string().min(1).max(200),
  timezone: ianaTimezoneSchema,
  location: z.string().max(500).optional(),
  description: z.string().max(2000).optional(),
};

// Partagé entre create_calendar_event et update_calendar_event : un
// événement horaire exige un ISO 8601 avec offset explicite pour chaque
// borne ; un événement journée entière exige une date seule. endDateTime y
// est TOUJOURS inclusif (le dernier jour réel) — la conversion vers la
// convention exclusive de Google se fait uniquement dans api.ts, jamais
// imposée à l'appelant.
function rejectOutOfOrderEventTimes(
  data: { allDay: boolean; startDateTime: string; endDateTime: string },
  ctx: z.RefinementCtx,
): void {
  const outOfOrder = data.allDay
    ? data.endDateTime < data.startDateTime
    : new Date(data.endDateTime).getTime() <= new Date(data.startDateTime).getTime();

  if (outOfOrder) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: data.allDay
        ? "endDateTime (dernier jour inclus) ne peut pas précéder startDateTime."
        : "endDateTime doit être strictement postérieur à startDateTime.",
      path: ["endDateTime"],
    });
  }
}

const createEventInputSchema = z
  .discriminatedUnion("allDay", [
    z
      .object({
        allDay: z.literal(false),
        startDateTime: isoDateTimeWithOffset,
        endDateTime: isoDateTimeWithOffset,
        ...commonCreateEventFields,
      })
      .strict(),
    z
      .object({
        allDay: z.literal(true),
        startDateTime: dateOnly,
        endDateTime: dateOnly,
        ...commonCreateEventFields,
      })
      .strict(),
  ])
  .superRefine(rejectOutOfOrderEventTimes);

const createCalendarEventTool: ToolDefinition<
  z.infer<typeof createEventInputSchema>,
  { event: CalendarEventDetail }
> = {
  name: "create_calendar_event",
  description:
    "Crée un nouvel événement dans le Google Calendar de l'utilisateur. Action à RISQUE EXTERNE : une confirmation explicite de l'utilisateur est TOUJOURS exigée avant exécution (une fois / session / toujours) — n'appelle cet outil qu'après avoir présenté un résumé clair (titre, date, heure de début, heure de fin ou durée, fuseau horaire, lieu éventuel) et obtenu une confirmation explicite. N'invente jamais une date, une heure ou une durée manquante ou ambiguë : demande une clarification honnête plutôt que de deviner.",
  riskLevel: "external",
  requiredPermission: "create_calendar_event",
  aiInputSchema: {
    type: "object",
    properties: {
      title: { type: "string", description: "Titre de l'événement." },
      allDay: {
        type: "boolean",
        description: "true pour un événement journée entière, false pour un événement avec horaires précis.",
      },
      startDateTime: {
        type: "string",
        description:
          "Si allDay=false : ISO 8601 avec offset explicite (ex: 2026-08-02T15:00:00+02:00). Si allDay=true : date seule YYYY-MM-DD (premier jour).",
      },
      endDateTime: {
        type: "string",
        description:
          "Si allDay=false : ISO 8601 avec offset explicite, strictement après startDateTime. Si allDay=true : date seule YYYY-MM-DD, DERNIER JOUR INCLUS (un événement d'un seul jour a startDateTime = endDateTime).",
      },
      timezone: {
        type: "string",
        description: "Identifiant de fuseau horaire IANA (ex: Europe/Paris) — jamais un simple offset.",
      },
      location: { type: "string", description: "Lieu (optionnel)." },
      description: { type: "string", description: "Description (optionnelle)." },
    },
    required: ["title", "allDay", "startDateTime", "endDateTime", "timezone"],
    additionalProperties: false,
  },
  parseInput: (raw) => createEventInputSchema.parse(raw),
  async execute(input, { userId }) {
    const event = await withGoogleCalendarErrorHandling(userId, (accessToken) =>
      createCalendarEvent(accessToken, input),
    );
    return { event };
  },
};

// Remplacement complet du contenu pertinent, jamais un patch partiel : le
// modèle doit toujours fournir l'état final complet souhaité (en réutilisant
// les valeurs actuelles obtenues via get_calendar_event pour tout champ non
// concerné par la modification) — jamais une valeur que le code devrait
// deviner ou fusionner avec l'existant.
const updateEventInputSchema = z
  .discriminatedUnion("allDay", [
    z
      .object({
        eventId: z.string().min(1),
        allDay: z.literal(false),
        startDateTime: isoDateTimeWithOffset,
        endDateTime: isoDateTimeWithOffset,
        ...commonCreateEventFields,
      })
      .strict(),
    z
      .object({
        eventId: z.string().min(1),
        allDay: z.literal(true),
        startDateTime: dateOnly,
        endDateTime: dateOnly,
        ...commonCreateEventFields,
      })
      .strict(),
  ])
  .superRefine(rejectOutOfOrderEventTimes);

const updateCalendarEventTool: ToolDefinition<
  z.infer<typeof updateEventInputSchema>,
  { event: CalendarEventDetail }
> = {
  name: "update_calendar_event",
  description:
    "Modifie un événement existant du Google Calendar de l'utilisateur, identifié par son eventId exact (obtenu via list_calendar_events/get_calendar_event). Action à RISQUE EXTERNE : confirmation explicite TOUJOURS exigée. Fournis TOUJOURS l'état final complet souhaité (titre, horaires, fuseau, lieu, description) — pour un champ que l'utilisateur ne veut pas changer, reprends sa valeur actuelle (récupérée au préalable via get_calendar_event), ne laisse jamais un champ vide en espérant qu'il soit conservé. Avant de demander confirmation, présente un résumé AVANT / APRÈS clair. N'invente jamais une valeur manquante ou ambiguë : demande une clarification.",
  riskLevel: "external",
  requiredPermission: "update_calendar_event",
  aiInputSchema: {
    type: "object",
    properties: {
      eventId: { type: "string", description: "Identifiant exact de l'événement à modifier." },
      title: { type: "string", description: "Titre final souhaité de l'événement." },
      allDay: { type: "boolean", description: "true pour journée entière, false pour horaire précis." },
      startDateTime: {
        type: "string",
        description:
          "Si allDay=false : ISO 8601 avec offset explicite. Si allDay=true : date seule YYYY-MM-DD (premier jour).",
      },
      endDateTime: {
        type: "string",
        description:
          "Si allDay=false : ISO 8601 avec offset explicite, après startDateTime. Si allDay=true : date seule YYYY-MM-DD, DERNIER JOUR INCLUS.",
      },
      timezone: { type: "string", description: "Identifiant de fuseau horaire IANA (ex: Europe/Paris)." },
      location: { type: "string", description: "Lieu (optionnel)." },
      description: { type: "string", description: "Description (optionnelle)." },
    },
    required: ["eventId", "title", "allDay", "startDateTime", "endDateTime", "timezone"],
    additionalProperties: false,
  },
  parseInput: (raw) => updateEventInputSchema.parse(raw),
  async execute(input, { userId }) {
    const event = await withGoogleCalendarErrorHandling(userId, (accessToken) =>
      updateCalendarEvent(accessToken, input.eventId, input),
    );
    return { event };
  },
};

const deleteEventInputSchema = z
  .object({
    eventId: z.string().min(1),
  })
  .strict();

const deleteCalendarEventTool: ToolDefinition<
  z.infer<typeof deleteEventInputSchema>,
  { deleted: true; eventId: string }
> = {
  name: "delete_calendar_event",
  description:
    "Supprime définitivement un événement du Google Calendar de l'utilisateur, identifié par son eventId exact. Action à RISQUE EXTERNE : confirmation explicite TOUJOURS exigée. N'appelle JAMAIS cet outil sur une référence vague (\"le rendez-vous de vendredi\") sans avoir d'abord résolu l'eventId exact via list_calendar_events/get_calendar_event, et présente TOUJOURS le titre et la date/heure exacts de l'événement dans le résumé avant de demander confirmation — l'utilisateur ne doit jamais confirmer une suppression à l'aveugle.",
  riskLevel: "external",
  requiredPermission: "delete_calendar_event",
  aiInputSchema: {
    type: "object",
    properties: {
      eventId: { type: "string", description: "Identifiant exact de l'événement à supprimer." },
    },
    required: ["eventId"],
    additionalProperties: false,
  },
  parseInput: (raw) => deleteEventInputSchema.parse(raw),
  async execute(input, { userId }) {
    await withGoogleCalendarErrorHandling(userId, (accessToken) =>
      deleteCalendarEvent(accessToken, input.eventId),
    );
    return { deleted: true, eventId: input.eventId };
  },
};

export function registerGoogleCalendarTools(): void {
  registerTool(listCalendarEventsTool as ToolDefinition);
  registerTool(getCalendarEventTool as ToolDefinition);
  registerTool(createCalendarEventTool as ToolDefinition);
  registerTool(updateCalendarEventTool as ToolDefinition);
  registerTool(deleteCalendarEventTool as ToolDefinition);
}
