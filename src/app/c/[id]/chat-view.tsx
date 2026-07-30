"use client";

import { useState } from "react";
import Link from "next/link";
import type { MessageRole } from "@/lib/supabase/database.types";

interface DisplayMessage {
  id: string;
  role: MessageRole;
  content: string;
}

export function ChatView({
  conversationId,
  initialMessages,
}: {
  conversationId: string;
  initialMessages: DisplayMessage[];
}) {
  const [messages, setMessages] = useState<DisplayMessage[]>(initialMessages);
  const [input, setInput] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const content = input.trim();
    if (!content || isSending) {
      return;
    }

    setError(null);
    setIsSending(true);
    setInput("");
    setMessages((current) => [
      ...current,
      { id: `optimistic-${current.length}`, role: "user", content },
    ]);

    try {
      const response = await fetch(`/api/conversations/${conversationId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content, device: "web", modality: "text" }),
      });

      if (!response.ok) {
        const body = (await response.json()) as { error?: string };
        setError(body.error ?? "Je n'ai pas pu terminer cette action.");
        return;
      }

      const { assistantText } = (await response.json()) as { assistantText: string };
      setMessages((current) => [
        ...current,
        { id: `assistant-${current.length}`, role: "assistant", content: assistantText },
      ]);
    } catch {
      setError("Je n'ai pas pu terminer cette action.");
    } finally {
      setIsSending(false);
    }
  }

  return (
    <main>
      <Link href="/">← Conversations</Link>
      <ul>
        {messages.map((message) => (
          <li key={message.id}>
            <strong>{message.role === "user" ? "Toi" : "Assistant"} : </strong>
            {message.content}
          </li>
        ))}
      </ul>
      {error ? <p role="alert">{error}</p> : null}
      <form onSubmit={handleSubmit}>
        <input
          type="text"
          value={input}
          onChange={(event) => setInput(event.target.value)}
          disabled={isSending}
          placeholder="Écris un message..."
        />
        <button type="submit" disabled={isSending}>
          Envoyer
        </button>
      </form>
    </main>
  );
}
