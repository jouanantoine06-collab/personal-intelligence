import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { rejectMemory } from "@/core/memory-engine/index";
import { clearPendingConfirmation } from "@/core/context-engine/index";
import { recordAuditEvent } from "@/core/audit-journal/index";
import { memoryErrorResponse } from "@/lib/api/memory-error-response";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Non authentifié." }, { status: 401 });
  }

  try {
    await rejectMemory(supabase, user.id, id);
    await clearPendingConfirmation(supabase, user.id, id);
    await recordAuditEvent(supabase, {
      userId: user.id,
      turnId: null,
      eventType: "memory_rejected",
      payload: { memoryItemId: id, source: "memory_ui" },
    });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return memoryErrorResponse(error);
  }
}
