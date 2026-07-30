import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { listMemoryItems } from "@/core/memory-engine/index";
import { MemoryDashboard } from "@/app/memory/memory-dashboard";

export default async function MemoryPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return null;
  }

  const [activeItems, pendingItems, projects] = await Promise.all([
    listMemoryItems(supabase, { userId: user.id, status: "active" }),
    listMemoryItems(supabase, { userId: user.id, status: "proposed" }),
    listMemoryItems(supabase, { userId: user.id, status: "active", type: "projet" }),
  ]);

  return (
    <main>
      <p>
        <Link href="/">← Conversations</Link>
      </p>
      <h1>Ma mémoire</h1>
      <MemoryDashboard
        initialActiveItems={activeItems}
        initialPendingItems={pendingItems}
        availableProjects={projects.map((p) => ({ id: p.id, label: p.content }))}
      />
    </main>
  );
}
