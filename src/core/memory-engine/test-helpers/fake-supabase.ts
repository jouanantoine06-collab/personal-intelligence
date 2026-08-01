// Fake minimal, en mémoire, reproduisant exactement les enchaînements utilisés par
// performGatedUpdate / fetchOwnedMemoryItem sur la table memory_items :
//   .from("memory_items").update(payload).eq().eq().eq().select("*").maybeSingle()
//   .from("memory_items").select("*").eq().eq().maybeSingle()
//   .from("memory_items").insert(payload).select("*").single()
// Ne prouve jamais l'atomicité réelle (seuls les tests d'intégration contre un vrai
// Postgres le peuvent) — prouve uniquement que la logique applicative (quelle
// erreur, quel type, quel champ) est correcte.

type Row = Record<string, unknown>;

export function createFakeMemoryItemsClient(initialRows: Row[]) {
  const rows: Row[] = initialRows.map((r) => ({ ...r }));

  function matches(row: Row, filters: Record<string, unknown>): boolean {
    return Object.entries(filters).every(([key, value]) => row[key] === value);
  }

  const client = {
    from(table: string) {
      if (table !== "memory_items") {
        throw new Error(`Fake non supporté pour la table "${table}"`);
      }

      return {
        update(payload: Row) {
          const filters: Record<string, unknown> = {};
          const applyUpdate = () => {
            const index = rows.findIndex((r) => matches(r, filters));
            if (index === -1) return null;
            rows[index] = { ...rows[index], ...payload };
            return { ...rows[index] };
          };
          const builder = {
            eq(column: string, value: unknown) {
              filters[column] = value;
              return builder;
            },
            select() {
              return {
                maybeSingle: async () => ({ data: applyUpdate(), error: null }),
                single: async () => {
                  const data = applyUpdate();
                  return data ? { data, error: null } : { data: null, error: { message: "not found" } };
                },
              };
            },
            // Le vrai client Supabase est "thenable" : un update sans .select()
            // final s'exécute quand même à l'await (utilisé par la supersession
            // best-effort de confirmMemory, qui n'a pas besoin du résultat).
            then(resolve: (value: { data: null; error: null }) => void) {
              applyUpdate();
              resolve({ data: null, error: null });
            },
          };
          return builder;
        },
        select() {
          const filters: Record<string, unknown> = {};
          const builder = {
            eq(column: string, value: unknown) {
              filters[column] = value;
              return builder;
            },
            maybeSingle: async () => {
              const found = rows.find((r) => matches(r, filters));
              return { data: found ? { ...found } : null, error: null };
            },
          };
          return builder;
        },
        insert(payload: Row) {
          return {
            select() {
              return {
                single: async () => {
                  const row = { id: `generated-${rows.length}`, ...payload };
                  rows.push(row);
                  return { data: { ...row }, error: null };
                },
              };
            },
          };
        },
      };
    },
    _rows: rows,
  };

  return client;
}
