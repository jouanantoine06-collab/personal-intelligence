import { NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { listMemoryItems } from "@/core/memory-engine/index";
import { memoryStatusSchema, memoryTypeSchema } from "@/core/memory-engine/schemas";
import { memoryErrorResponse } from "@/lib/api/memory-error-response";

const listQuerySchema = z.object({
  type: memoryTypeSchema.optional(),
  projectId: z.string().uuid().optional(),
  status: memoryStatusSchema.optional(),
  q: z.string().optional(),
});

export async function GET(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Non authentifié." }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const parsed = listQuerySchema.safeParse({
    type: searchParams.get("type") ?? undefined,
    projectId: searchParams.get("projectId") ?? undefined,
    status: searchParams.get("status") ?? undefined,
    q: searchParams.get("q") ?? undefined,
  });

  if (!parsed.success) {
    return NextResponse.json({ error: "Paramètres de filtrage invalides." }, { status: 400 });
  }

  try {
    const items = await listMemoryItems(supabase, {
      userId: user.id,
      ...(parsed.data.type ? { type: parsed.data.type } : {}),
      ...(parsed.data.projectId ? { projectId: parsed.data.projectId } : {}),
      ...(parsed.data.status ? { status: parsed.data.status } : {}),
      ...(parsed.data.q ? { queryText: parsed.data.q } : {}),
    });

    return NextResponse.json({ items });
  } catch (error) {
    return memoryErrorResponse(error);
  }
}
