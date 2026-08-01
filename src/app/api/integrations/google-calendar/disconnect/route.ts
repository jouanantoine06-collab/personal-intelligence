import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceRoleClient } from "@/lib/supabase/service-role";
import { recordAuditEvent } from "@/core/audit-journal/index";
import { revokeAndDeleteConnection } from "@/core/google-calendar/connections";
import { requireEnv } from "@/lib/env";

export async function POST() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Non authentifié." }, { status: 401 });
  }

  const serviceRoleClient = createServiceRoleClient();
  await revokeAndDeleteConnection(serviceRoleClient, user.id);

  await recordAuditEvent(supabase, {
    userId: user.id,
    turnId: null,
    eventType: "oauth_disconnected",
    payload: {},
  });

  return NextResponse.redirect(new URL("/integrations", requireEnv("APP_URL")));
}
