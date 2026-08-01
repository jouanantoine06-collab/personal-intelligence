import { type NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceRoleClient } from "@/lib/supabase/service-role";
import { recordAuditEvent } from "@/core/audit-journal/index";
import { exchangeCodeForTokens, GoogleOAuthError } from "@/core/google-calendar/oauth";
import { saveConnection } from "@/core/google-calendar/connections";
import { requireEnv } from "@/lib/env";
import { STATE_COOKIE_NAME } from "@/core/google-calendar/oauth-state-cookie";

function redirectToIntegrations(status: "connected" | "error"): NextResponse {
  const url = new URL("/integrations", requireEnv("APP_URL"));
  url.searchParams.set("status", status);
  const response = NextResponse.redirect(url);
  response.cookies.delete(STATE_COOKIE_NAME);
  return response;
}

export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.redirect(new URL("/login", requireEnv("APP_URL")));
  }

  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const cookieState = request.cookies.get(STATE_COOKIE_NAME)?.value;

  if (!code || !state || !cookieState || state !== cookieState) {
    await recordAuditEvent(supabase, {
      userId: user.id,
      turnId: null,
      eventType: "oauth_connection_error",
      payload: { reason: "state_mismatch_or_missing_code" },
    });
    return redirectToIntegrations("error");
  }

  const redirectUri = `${requireEnv("APP_URL")}/api/integrations/google-calendar/callback`;

  try {
    const tokens = await exchangeCodeForTokens({ code, redirectUri });
    const serviceRoleClient = createServiceRoleClient();
    await saveConnection(serviceRoleClient, user.id, tokens);

    await recordAuditEvent(supabase, {
      userId: user.id,
      turnId: null,
      eventType: "oauth_connected",
      payload: { scopes: tokens.grantedScopes },
    });

    return redirectToIntegrations("connected");
  } catch (err) {
    const reason =
      err instanceof GoogleOAuthError
        ? `${err.googleErrorCode}: ${err.message}`
        : err instanceof Error
          ? err.message
          : String(err);

    await recordAuditEvent(supabase, {
      userId: user.id,
      turnId: null,
      eventType: "oauth_connection_error",
      payload: { reason },
    });

    return redirectToIntegrations("error");
  }
}
