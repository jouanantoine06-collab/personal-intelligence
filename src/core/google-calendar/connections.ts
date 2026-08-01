// Cycle de vie de la connexion Google Calendar d'un utilisateur (V1.3a).
//
// Toutes les fonctions reçoivent le client Supabase PRIVILÉGIÉ
// (src/lib/supabase/service-role.ts), qui contourne RLS pour cette table
// (ADR-0014). C'est pourquoi CHAQUE requête ci-dessous filtre explicitement
// sur user_id : Postgres ne le fait plus pour nous ici, le code doit le
// garantir lui-même.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, GoogleCalendarConnectionStatus } from "@/lib/supabase/database.types";
import { decryptToken, encryptToken } from "@/lib/crypto/token-cipher";
import {
  type GoogleTokenResponse,
  refreshAccessToken,
  revokeGoogleToken,
} from "@/core/google-calendar/oauth";

// Marge de sécurité avant l'expiration réelle : on renouvelle un peu en
// avance plutôt que de risquer un appel Google avec un token expiré entre le
// contrôle et l'utilisation.
const EXPIRY_SAFETY_MARGIN_SECONDS = 60;

export class GoogleCalendarReconnectRequiredError extends Error {
  constructor(reason: string) {
    super(`Reconnexion Google Calendar nécessaire : ${reason}`);
    this.name = "GoogleCalendarReconnectRequiredError";
  }
}

export interface GoogleCalendarConnectionStatusView {
  connected: boolean;
  connectedAt: string | null;
  status: GoogleCalendarConnectionStatus | null;
}

// Projection sans secret, destinée à l'affichage utilisateur (/integrations).
// Ne sélectionne jamais les colonnes de token.
export async function getConnectionStatus(
  supabase: SupabaseClient<Database>,
  userId: string,
): Promise<GoogleCalendarConnectionStatusView> {
  const { data, error } = await supabase
    .from("google_calendar_connections")
    .select("status, connected_at")
    .eq("user_id", userId)
    .maybeSingle();

  if (error) {
    throw new Error(`Lecture du statut de connexion Google Calendar impossible: ${error.message}`);
  }

  if (!data) {
    return { connected: false, connectedAt: null, status: null };
  }

  return { connected: true, connectedAt: data.connected_at, status: data.status };
}

export async function saveConnection(
  supabase: SupabaseClient<Database>,
  userId: string,
  tokens: GoogleTokenResponse & { refreshToken: string },
): Promise<void> {
  const expiresAt = new Date(Date.now() + tokens.expiresInSeconds * 1000).toISOString();

  // onConflict: "user_id" s'appuie sur la contrainte unique posée par la
  // migration — il ne peut donc jamais y avoir plus d'une ligne par
  // utilisateur, pas besoin de filtre supplémentaire ici.
  const { error } = await supabase.from("google_calendar_connections").upsert(
    {
      user_id: userId,
      encrypted_access_token: encryptToken(tokens.accessToken, userId),
      encrypted_refresh_token: encryptToken(tokens.refreshToken, userId),
      token_expires_at: expiresAt,
      granted_scopes: tokens.grantedScopes,
      status: "active",
      last_error: null,
      connected_at: new Date().toISOString(),
    },
    { onConflict: "user_id" },
  );

  if (error) {
    throw new Error(`Écriture de la connexion Google Calendar impossible: ${error.message}`);
  }
}

export async function deleteConnection(
  supabase: SupabaseClient<Database>,
  userId: string,
): Promise<void> {
  const { error } = await supabase
    .from("google_calendar_connections")
    .delete()
    .eq("user_id", userId);

  if (error) {
    throw new Error(`Suppression de la connexion Google Calendar impossible: ${error.message}`);
  }
}

// Révoque le refresh_token côté Google puis supprime la ligne stockée. Si la
// ligne n'existe déjà plus, ne fait rien (déconnexion déjà effective).
export async function revokeAndDeleteConnection(
  supabase: SupabaseClient<Database>,
  userId: string,
): Promise<void> {
  const { data, error } = await supabase
    .from("google_calendar_connections")
    .select("encrypted_refresh_token")
    .eq("user_id", userId)
    .maybeSingle();

  if (error) {
    throw new Error(`Lecture de la connexion Google Calendar impossible: ${error.message}`);
  }

  if (data) {
    const refreshToken = decryptToken(data.encrypted_refresh_token, userId);
    // Révocation "best effort" : si Google renvoie une erreur autre qu'un
    // simple "déjà invalide", on continue quand même la suppression locale —
    // l'utilisateur a demandé à se déconnecter, on ne le bloque pas sur un
    // problème réseau côté Google.
    try {
      await revokeGoogleToken(refreshToken);
    } catch {
      // Erreur volontairement non-bloquante ici ; l'appelant journalise le
      // résultat global de la déconnexion, pas cet échec de révocation isolé.
    }
  }

  await deleteConnection(supabase, userId);
}

async function markConnectionError(
  supabase: SupabaseClient<Database>,
  userId: string,
  message: string,
): Promise<void> {
  const { error } = await supabase
    .from("google_calendar_connections")
    .update({ status: "error", last_error: message })
    .eq("user_id", userId);

  if (error) {
    throw new Error(`Mise à jour du statut d'erreur impossible: ${error.message}`);
  }
}

// Retourne un access_token valide et déchiffré, en renouvelant si besoin.
// Lève GoogleCalendarReconnectRequiredError si aucune connexion n'existe ou
// si le renouvellement échoue (refresh_token révoqué/invalide côté Google) —
// jamais de nouvelle tentative automatique en boucle, jamais d'access_token
// périmé renvoyé à l'appelant.
export async function ensureFreshAccessToken(
  supabase: SupabaseClient<Database>,
  userId: string,
): Promise<string> {
  const { data, error } = await supabase
    .from("google_calendar_connections")
    .select("encrypted_access_token, encrypted_refresh_token, token_expires_at, status")
    .eq("user_id", userId)
    .maybeSingle();

  if (error) {
    throw new Error(`Lecture de la connexion Google Calendar impossible: ${error.message}`);
  }
  if (!data) {
    throw new GoogleCalendarReconnectRequiredError("aucune connexion enregistrée");
  }
  if (data.status === "error") {
    throw new GoogleCalendarReconnectRequiredError("la connexion précédente a échoué");
  }

  const expiresAt = new Date(data.token_expires_at).getTime();
  const stillValid = expiresAt - EXPIRY_SAFETY_MARGIN_SECONDS * 1000 > Date.now();

  if (stillValid) {
    return decryptToken(data.encrypted_access_token, userId);
  }

  const refreshToken = decryptToken(data.encrypted_refresh_token, userId);

  try {
    const refreshed = await refreshAccessToken({ refreshToken });
    const expiresAtIso = new Date(Date.now() + refreshed.expiresInSeconds * 1000).toISOString();

    const { error: updateError } = await supabase
      .from("google_calendar_connections")
      .update({
        encrypted_access_token: encryptToken(refreshed.accessToken, userId),
        // Google ne renvoie pas toujours un nouveau refresh_token : on ne
        // remplace le chiffré existant que si on en a reçu un nouveau.
        ...(refreshed.refreshToken
          ? { encrypted_refresh_token: encryptToken(refreshed.refreshToken, userId) }
          : {}),
        token_expires_at: expiresAtIso,
        last_refreshed_at: new Date().toISOString(),
      })
      .eq("user_id", userId);

    if (updateError) {
      throw new Error(`Écriture du token renouvelé impossible: ${updateError.message}`);
    }

    return refreshed.accessToken;
  } catch (refreshError) {
    const message = refreshError instanceof Error ? refreshError.message : String(refreshError);
    await markConnectionError(supabase, userId, message);
    throw new GoogleCalendarReconnectRequiredError(`renouvellement échoué (${message})`);
  }
}
