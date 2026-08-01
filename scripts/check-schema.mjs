import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

const env = Object.fromEntries(
  readFileSync("C:\\personal-intelligence\\.env.local", "utf8")
    .split("\n")
    .filter((l) => l.includes("="))
    .map((l) => {
      const idx = l.indexOf("=");
      return [l.slice(0, idx).trim(), l.slice(idx + 1).trim()];
    }),
);

const supabase = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

const results = [];

async function check(label, fn) {
  try {
    await fn();
    results.push({ label, ok: true });
  } catch (e) {
    results.push({ label, ok: false, error: e.message ?? String(e) });
  }
}

for (const table of [
  "conversations",
  "messages",
  "memory_items",
  "context_state",
  "audit_journal",
  "tool_permissions",
  "internal_notes",
]) {
  await check(`table ${table} existe`, async () => {
    const { error } = await supabase.from(table).select("*").limit(0);
    if (error) throw new Error(error.message);
  });
}

await check("messages.turn_id existe (migration 0002)", async () => {
  const { error } = await supabase.from("messages").select("turn_id").limit(0);
  if (error) throw new Error(error.message);
});

await check("memory_items.embedding existe (extension vector présente)", async () => {
  const { error } = await supabase.from("memory_items").select("embedding").limit(0);
  if (error) throw new Error(error.message);
});

await check("memory_items: toutes les colonnes attendues existent", async () => {
  const cols = [
    "id", "user_id", "type", "content", "structured_content", "source_type",
    "source_turn_id", "event_date", "last_confirmed_at", "confidence", "importance",
    "sensitivity", "retention_policy", "status", "supersedes_id", "project_id",
    "related_person_ids", "created_at", "deleted_at",
  ];
  const { error } = await supabase.from("memory_items").select(cols.join(",")).limit(0);
  if (error) throw new Error(error.message);
});

await check("context_state: colonnes attendues existent", async () => {
  const cols = [
    "user_id", "active_project_id", "active_task", "confidence",
    "recent_entities", "pending_confirmations", "last_device", "last_modality", "updated_at",
  ];
  const { error } = await supabase.from("context_state").select(cols.join(",")).limit(0);
  if (error) throw new Error(error.message);
});

await check("audit_journal: colonnes attendues existent", async () => {
  const { error } = await supabase
    .from("audit_journal")
    .select("id,user_id,turn_id,event_type,payload,created_at")
    .limit(0);
  if (error) throw new Error(error.message);
});

await check("tool_permissions: colonnes attendues existent", async () => {
  const { error } = await supabase
    .from("tool_permissions")
    .select("id,user_id,tool_name,scope,conversation_id,granted_at")
    .limit(0);
  if (error) throw new Error(error.message);
});

await check("internal_notes: colonnes attendues existent", async () => {
  const { error } = await supabase
    .from("internal_notes")
    .select("id,user_id,content,created_at")
    .limit(0);
  if (error) throw new Error(error.message);
});

// RLS activée : avec la clé anon (pas de session), toute lecture doit renvoyer 0 ligne,
// jamais les données d'un autre utilisateur.
const anonClient = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
await check("RLS active sur memory_items (lecture anonyme = 0 ligne)", async () => {
  const { data, error } = await anonClient.from("memory_items").select("*");
  if (error) throw new Error(error.message);
  if ((data ?? []).length !== 0) throw new Error(`RLS ne bloque pas : ${data.length} lignes visibles sans session`);
});

for (const r of results) {
  console.log(`${r.ok ? "PASS" : "FAIL"} — ${r.label}${r.ok ? "" : " — " + r.error}`);
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} vérifications passées.`);
if (failed.length > 0) process.exit(1);
