import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

const env = Object.fromEntries(
  readFileSync("C:\\personal-intelligence\\.env.local", "utf8")
    .split(/\r?\n/)
    .filter((l) => l.includes("="))
    .map((l) => {
      const idx = l.indexOf("=");
      return [l.slice(0, idx).trim(), l.slice(idx + 1).trim()];
    }),
);

const serviceRole = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

const emailFilter = process.argv[2];
if (!emailFilter) {
  console.error("Usage: node scripts/check-audit-journal.mjs <fragment-email-ou-user-id>");
  process.exit(1);
}

let userId = emailFilter;
if (emailFilter.includes("@")) {
  const { data: users, error } = await serviceRole.auth.admin.listUsers();
  if (error) throw error;
  const match = users.users.find((u) => u.email === emailFilter);
  if (!match) {
    console.error(`Utilisateur introuvable pour ${emailFilter}`);
    process.exit(1);
  }
  userId = match.id;
}

const { data, error } = await serviceRole
  .from("audit_journal")
  .select("event_type, payload, created_at")
  .eq("user_id", userId)
  .order("created_at", { ascending: true });

if (error) throw error;

console.log(`${data.length} événements journalisés pour l'utilisateur ${userId} :\n`);
for (const row of data) {
  console.log(`${row.created_at} — ${row.event_type} — ${JSON.stringify(row.payload)}`);
}
