import { notFound } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { getMemoryDetail } from "@/core/memory-engine/index";
import { MemoryNotFoundError } from "@/core/memory-engine/errors";
import { MemoryDetailView } from "@/app/memory/[id]/memory-detail-view";

export default async function MemoryDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return null;
  }

  try {
    const detail = await getMemoryDetail(supabase, user.id, id);
    return (
      <main>
        <p>
          <Link href="/memory">← Mémoire</Link>
        </p>
        <MemoryDetailView detail={detail} />
      </main>
    );
  } catch (error) {
    if (error instanceof MemoryNotFoundError) {
      notFound();
    }
    throw error;
  }
}
