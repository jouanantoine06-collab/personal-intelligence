// Client OAuth Google minimal — appels REST directs via fetch, aucune
// dépendance ajoutée (pas de SDK "googleapis" : la surface nécessaire ici
// tient en quatre appels HTTP simples).
//
// Scope unique, strictement nécessaire : lecture + écriture des événements,
// jamais la gestion des calendriers eux-mêmes (auth.uid()/auth.uid() n'a rien
// à voir ici — c'est un scope Google, pas du RLS).
export const GOOGLE_CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.events";

import { requireEnv } from "@/lib/env";

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const REVOKE_ENDPOINT = "https://oauth2.googleapis.com/revoke";

export class GoogleOAuthError extends Error {
  constructor(
    public readonly googleErrorCode: string,
    message: string,
  ) {
    super(message);
    this.name = "GoogleOAuthError";
  }
}

// Ne journalise et ne propage jamais le corps brut de la réponse d'erreur de
// Google tel quel : seulement les deux champs attendus (error/error_description),
// jamais un éventuel écho de token si la forme de la réponse venait à changer.
async function parseGoogleErrorResponse(response: Response): Promise<GoogleOAuthError> {
  let code = "unknown_error";
  let description = `HTTP ${response.status}`;
  try {
    const body = (await response.json()) as { error?: string; error_description?: string };
    if (typeof body.error === "string") code = body.error;
    if (typeof body.error_description === "string") description = body.error_description;
  } catch {
    // Corps non-JSON ou vide : on garde le message par défaut.
  }
  return new GoogleOAuthError(code, description);
}

export function buildGoogleAuthorizationUrl(params: { redirectUri: string; state: string }): string {
  const clientId = requireEnv("GOOGLE_OAUTH_CLIENT_ID");
  const url = new URL(AUTH_ENDPOINT);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", params.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", GOOGLE_CALENDAR_SCOPE);
  url.searchParams.set("access_type", "offline");
  // Force la réémission d'un refresh_token même si l'utilisateur a déjà
  // consenti par le passé (sinon Google ne le renvoie qu'à la toute première
  // autorisation) — nécessaire puisqu'on ne stocke jamais de refresh_token
  // sans savoir qu'on vient d'en recevoir un valide.
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("state", params.state);
  return url.toString();
}

export interface GoogleTokenResponse {
  accessToken: string;
  refreshToken: string | null;
  expiresInSeconds: number;
  grantedScopes: string;
}

function parseTokenResponseBody(body: {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope: string;
}): GoogleTokenResponse {
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token ?? null,
    expiresInSeconds: body.expires_in,
    grantedScopes: body.scope,
  };
}

export async function exchangeCodeForTokens(params: {
  code: string;
  redirectUri: string;
}): Promise<GoogleTokenResponse & { refreshToken: string }> {
  const clientId = requireEnv("GOOGLE_OAUTH_CLIENT_ID");
  const clientSecret = requireEnv("GOOGLE_OAUTH_CLIENT_SECRET");

  const response = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: params.code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: params.redirectUri,
    }),
  });

  if (!response.ok) {
    throw await parseGoogleErrorResponse(response);
  }

  const body = (await response.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
    scope: string;
  };
  const parsed = parseTokenResponseBody(body);

  if (!parsed.refreshToken) {
    // Ne devrait pas arriver avec prompt=consent+access_type=offline sur une
    // première connexion, mais on refuse de stocker une connexion sans moyen
    // de la renouveler plutôt que de découvrir le problème plus tard.
    throw new Error(
      "Google n'a renvoyé aucun refresh_token pour cet échange — reconnexion impossible à stocker.",
    );
  }

  return { ...parsed, refreshToken: parsed.refreshToken };
}

export async function refreshAccessToken(params: {
  refreshToken: string;
}): Promise<GoogleTokenResponse> {
  const clientId = requireEnv("GOOGLE_OAUTH_CLIENT_ID");
  const clientSecret = requireEnv("GOOGLE_OAUTH_CLIENT_SECRET");

  const response = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: params.refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });

  if (!response.ok) {
    throw await parseGoogleErrorResponse(response);
  }

  const body = (await response.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
    scope: string;
  };

  // Google ne renvoie généralement pas de nouveau refresh_token ici — on
  // garde l'ancien (transmis par l'appelant, jamais deviné ici).
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token ?? null,
    expiresInSeconds: body.expires_in,
    grantedScopes: body.scope,
  };
}

export async function revokeGoogleToken(token: string): Promise<void> {
  const response = await fetch(REVOKE_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token }),
  });

  // Google renvoie 200 même si le token était déjà invalide/expiré — on ne
  // traite comme une erreur bloquante que les échecs réseau/HTTP explicites,
  // jamais un simple "déjà révoqué".
  if (!response.ok && response.status !== 400) {
    throw await parseGoogleErrorResponse(response);
  }
}
