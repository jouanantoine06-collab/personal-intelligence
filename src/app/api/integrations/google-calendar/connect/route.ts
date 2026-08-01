import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { recordAuditEvent } from "@/core/audit-journal/index";
import { buildGoogleAuthorizationUrl } from "@/core/google-calendar/oauth";
import { requireEnv } from "@/lib/env";
import { STATE_COOKIE_NAME } from "@/core/google-calendar/oauth-state-cookie";

export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Non authentifié." }, { status: 401 });
  }

  const state = randomBytes(32).toString("base64url");
  const redirectUri = `${requireEnv("APP_URL")}/api/integrations/google-calendar/callback`;
  const authorizationUrl = buildGoogleAuthorizationUrl({ redirectUri, state });

  await recordAuditEvent(supabase, {
    userId: user.id,
    turnId: null,
    eventType: "oauth_connect_started",
    payload: {},
  });

  const response = NextResponse.redirect(authorizationUrl);
  response.cookies.set(STATE_COOKIE_NAME, state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 600,
    path: "/",
  });
  return response;
}
