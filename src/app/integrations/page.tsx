import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { createServiceRoleClient } from "@/lib/supabase/service-role";
import { getConnectionStatus } from "@/core/google-calendar/connections";
import { getContextState } from "@/core/context-engine/index";
import { TimezoneForm } from "@/app/integrations/timezone-form";

export default async function IntegrationsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return null;
  }

  const { status: callbackStatus } = await searchParams;
  const serviceRoleClient = createServiceRoleClient();
  const [connection, contextState] = await Promise.all([
    getConnectionStatus(serviceRoleClient, user.id),
    getContextState(supabase, user.id),
  ]);

  return (
    <main>
      <p>
        <Link href="/">← Conversations</Link>
      </p>
      <h1>Intégrations</h1>

      {callbackStatus === "connected" ? <p role="status">Compte Google connecté avec succès.</p> : null}
      {callbackStatus === "error" ? (
        <p role="alert">La connexion à Google a échoué. Réessaie, ou contacte le support si ça persiste.</p>
      ) : null}

      <h2>Google Calendar</h2>
      {connection.connected && connection.status === "active" ? (
        <>
          <p>
            Connecté depuis le {new Date(connection.connectedAt as string).toLocaleString("fr-FR")}.
          </p>
          <form action="/api/integrations/google-calendar/disconnect" method="post">
            <button type="submit">Déconnecter Google Calendar</button>
          </form>
        </>
      ) : connection.connected && connection.status === "error" ? (
        <>
          <p role="alert">
            La connexion précédente ne fonctionne plus (jeton révoqué ou expiré). Reconnecte ton compte.
          </p>
          <a href="/api/integrations/google-calendar/connect">Reconnecter Google Calendar</a>
        </>
      ) : (
        <a href="/api/integrations/google-calendar/connect">Connecter Google Calendar</a>
      )}

      <h2>Fuseau horaire</h2>
      <p>
        {contextState.timezone
          ? `Fuseau actuel : ${contextState.timezone}.`
          : "Aucun fuseau horaire configuré — tant qu'il ne l'est pas, l'assistant ne devinera jamais une date ou une heure relative et te demandera de le configurer ici."}
      </p>
      <TimezoneForm currentTimezone={contextState.timezone} />
    </main>
  );
}
