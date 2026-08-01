// Client Supabase PRIVILÉGIÉ — contourne RLS entièrement (clé service-role).
//
// N'utiliser QUE pour la table google_calendar_connections (ADR-0014) : c'est
// la seule table de ce projet sans policy RLS pour `authenticated`/`anon`, donc
// la seule qui a besoin de ce client. Partout ailleurs dans l'application, le
// client scopé à la session (src/lib/supabase/server.ts) reste la seule source
// de vérité pour l'isolation utilisateur.
//
// Puisque RLS ne protège plus rien ici, CHAQUE requête faite avec ce client
// doit filtrer explicitement sur user_id — rien ne le fera à sa place.
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";

export function createServiceRoleClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) {
    throw new Error(
      "NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY requis pour le client privilégié.",
    );
  }

  return createClient<Database>(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
