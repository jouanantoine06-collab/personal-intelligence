"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export function NewConversationButton() {
  const router = useRouter();
  const [isPending, setIsPending] = useState(false);

  async function handleClick() {
    setIsPending(true);
    try {
      const response = await fetch("/api/conversations", { method: "POST" });
      if (!response.ok) {
        return;
      }
      const { conversation } = (await response.json()) as { conversation: { id: string } };
      router.push(`/c/${conversation.id}`);
    } finally {
      setIsPending(false);
    }
  }

  return (
    <button type="button" onClick={handleClick} disabled={isPending}>
      Nouvelle conversation
    </button>
  );
}
