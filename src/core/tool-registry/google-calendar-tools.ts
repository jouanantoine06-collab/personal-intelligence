// Outils Google Calendar en lecture (V1.3b) : list_calendar_events et
// get_calendar_event, tous deux "no_risk" (jamais de confirmation). La
// création (create_calendar_event) reste hors périmètre — V1.3c.
//
// Ces outils utilisent le client Supabase PRIVILÉGIÉ (ADR-0014), jamais le
// client de session reçu dans ToolExecutionContext : ils n'en ont pas besoin
// pour accéder à google_calendar_connections, qui refuse RLS à ce dernier.
import { z } from "zod";
import { registerTool, type ToolDefinition } from "@/core/tool-registry/index";
import { createServiceRoleClient } from "@/lib/supabase/service-role";
import {
  ensureFreshAccessToken,
  markConnectionError,
} from "@/core/google-calendar/connections";
import {
  type CalendarEventDetail,
  type CalendarEventSummary,
  getCalendarEvent,
  GoogleCalendarApiError,
  listCalendarEvents,
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

export function registerGoogleCalendarTools(): void {
  registerTool(listCalendarEventsTool as ToolDefinition);
  registerTool(getCalendarEventTool as ToolDefinition);
}
