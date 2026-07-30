import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { signOut } from "@/app/login/actions";
import { NewConversationButton } from "@/app/new-conversation-button";

export default async function Home() {
  const supabase = await createClient();
  const { data: conversations, error } = await supabase
    .from("conversations")
    .select("*")
    .order("updated_at", { ascending: false });

  return (
    <main>
      <h1>Personal Intelligence OS</h1>
      <form action={signOut}>
        <button type="submit">Se déconnecter</button>
      </form>
      <p>
        <Link href="/memory">Ma mémoire</Link>
      </p>
      <NewConversationButton />
      {error ? <p role="alert">Impossible de charger les conversations.</p> : null}
      <ul>
        {(conversations ?? []).map((conversation) => (
          <li key={conversation.id}>
            <Link href={`/c/${conversation.id}`}>
              {conversation.title ?? `Conversation du ${new Date(conversation.created_at).toLocaleString("fr-FR")}`}
            </Link>
          </li>
        ))}
      </ul>
      {(conversations ?? []).length === 0 ? <p>Aucune conversation pour le moment.</p> : null}
    </main>
  );
}
