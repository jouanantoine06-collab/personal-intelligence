import { NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import {
  correctActiveMemory,
  deleteActiveMemory,
  editProposedMemory,
  fetchOwnedMemoryItem,
  getMemoryDetail,
} from "@/core/memory-engine/index";
import { memoryErrorResponse } from "@/lib/api/memory-error-response";
import { recordAuditEvent } from "@/core/audit-journal/index";
import { resolveCorrectionAction } from "@/core/memory-engine/errors";

const editSchema = z.object({
  content: z.string().min(1).max(2000),
  structuredContent: z.record(z.string(), z.unknown()),
});

export async function GET(
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
    const detail = await getMemoryDetail(supabase, user.id, id);
    return NextResponse.json({ detail });
  } catch (error) {
    return memoryErrorResponse(error);
  }
}

export async function PATCH(
  request: Request,
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

  const parsed = editSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: "Contenu invalide." }, { status: 400 });
  }

  try {
    const current = await fetchOwnedMemoryItem(supabase, user.id, id);
    const action = resolveCorrectionAction(current.status);

    if (action === "edit_proposed") {
      const item = await editProposedMemory(supabase, user.id, id, parsed.data);
      await recordAuditEvent(supabase, {
        userId: user.id,
        turnId: null,
        eventType: "memory_proposal_edited",
        payload: { memoryItemId: id },
      });
      return NextResponse.json({ item });
    }

    if (action === "correct_active") {
      const { memoryItem, supersededId } = await correctActiveMemory(supabase, {
        userId: user.id,
        memoryItemId: id,
        content: parsed.data.content,
        structuredContent: parsed.data.structuredContent,
      });
      await recordAuditEvent(supabase, {
        userId: user.id,
        turnId: null,
        eventType: "memory_corrected",
        payload: { newMemoryItemId: memoryItem.id, supersededId },
      });
      return NextResponse.json({ item: memoryItem });
    }

    return NextResponse.json(
      { error: `Ce souvenir (statut "${current.status}") ne peut plus être modifié.` },
      { status: 409 },
    );
  } catch (error) {
    return memoryErrorResponse(error);
  }
}

export async function DELETE(
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
    await deleteActiveMemory(supabase, user.id, id);
    await recordAuditEvent(supabase, {
      userId: user.id,
      turnId: null,
      eventType: "memory_deleted",
      payload: { memoryItemId: id },
    });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return memoryErrorResponse(error);
  }
}
