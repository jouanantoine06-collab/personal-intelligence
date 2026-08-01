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

const { data, error } = await serviceRole.auth.admin.listUsers({ perPage: 1000 });
if (error) throw error;

const testUsers = data.users.filter(
  (u) =>
    u.email?.startsWith("pi-e2e-") ||
    u.email?.startsWith("pi-concurrency-") ||
    u.email?.startsWith("diag-") ||
    u.email?.includes("example.test") ||
    u.email?.includes("example.invalid"),
);

console.log(`${testUsers.length} utilisateur(s) de test à supprimer :`);
for (const user of testUsers) {
  console.log(` - ${user.email} (${user.id})`);
  const { error: deleteError } = await serviceRole.auth.admin.deleteUser(user.id);
  if (deleteError) console.error(`   échec: ${deleteError.message}`);
}
console.log("Nettoyage terminé.");
