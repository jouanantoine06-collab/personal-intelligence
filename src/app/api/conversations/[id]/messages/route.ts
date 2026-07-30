import { NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { getAIProvider } from "@/core/ai-provider/anthropic-provider";
import { runTurn } from "@/core/orchestrator/index";

const sendMessageSchema = z.object({
  content: z.string().min(1).max(4000),
  device: z.string().default("web"),
  modality: z.string().default("text"),
});

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: conversationId } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Non authentifié." }, { status: 401 });
  }

  const { data, error } = await supabase
    .from("messages")
    .select("*")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: true });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ messages: data });
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: conversationId } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Non authentifié." }, { status: 401 });
  }

  const parsed = sendMessageSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: "Message invalide." }, { status: 400 });
  }

  const { data: conversation, error: conversationError } = await supabase
    .from("conversations")
    .select("id")
    .eq("id", conversationId)
    .maybeSingle();

  if (conversationError) {
    return NextResponse.json({ error: conversationError.message }, { status: 500 });
  }
  if (!conversation) {
    return NextResponse.json({ error: "Conversation introuvable." }, { status: 404 });
  }

  try {
    const result = await runTurn(supabase, getAIProvider(), {
      userId: user.id,
      conversationId,
      userMessageText: parsed.data.content,
      device: parsed.data.device,
      modality: parsed.data.modality,
    });

    return NextResponse.json({ assistantText: result.assistantText });
  } catch {
    return NextResponse.json(
      { error: "Je n'ai pas pu terminer cette action." },
      { status: 500 },
    );
  }
}
