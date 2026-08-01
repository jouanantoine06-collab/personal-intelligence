import { NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { getContextState, upsertContextState } from "@/core/context-engine/index";
import { isValidIanaTimezone } from "@/lib/timezone";

const bodySchema = z.object({ timezone: z.string().min(1) });

export async function POST(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Non authentifié." }, { status: 401 });
  }

  const parsed = bodySchema.safeParse(await request.json());
  if (!parsed.success || !isValidIanaTimezone(parsed.data.timezone)) {
    return NextResponse.json(
      { error: "Fuseau horaire invalide. Utilise un identifiant IANA (ex: Europe/Paris)." },
      { status: 400 },
    );
  }

  const contextState = await getContextState(supabase, user.id);
  contextState.timezone = parsed.data.timezone;
  await upsertContextState(supabase, contextState);

  return NextResponse.json({ timezone: parsed.data.timezone });
}
