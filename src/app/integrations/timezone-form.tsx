"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

const SUPPORTED_TIMEZONES = Intl.supportedValuesOf("timeZone");

export function TimezoneForm({ currentTimezone }: { currentTimezone: string | null }) {
  const router = useRouter();
  const [value, setValue] = useState(currentTimezone ?? "");
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setIsSaving(true);
    try {
      const response = await fetch("/api/settings/timezone", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ timezone: value }),
      });
      if (!response.ok) {
        const body = (await response.json()) as { error?: string };
        setError(body.error ?? "Fuseau horaire invalide.");
        return;
      }
      router.refresh();
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <form onSubmit={handleSubmit}>
      <label>
        Fuseau horaire :{" "}
        <select value={value} onChange={(event) => setValue(event.target.value)}>
          <option value="" disabled>
            Choisir un fuseau…
          </option>
          {SUPPORTED_TIMEZONES.map((tz) => (
            <option key={tz} value={tz}>
              {tz}
            </option>
          ))}
        </select>
      </label>{" "}
      <button type="submit" disabled={isSaving || !value}>
        Enregistrer
      </button>
      {error ? <p role="alert">{error}</p> : null}
    </form>
  );
}
