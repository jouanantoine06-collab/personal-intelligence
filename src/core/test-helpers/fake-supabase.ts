// Fake Supabase générique, multi-tables, en mémoire — reproduit les enchaînements
// utilisés par Permission Gate / Tool Executor / Audit Journal :
//   .from(table).insert(payload)                         (thenable directement)
//   .from(table).insert(payload).select().single()
//   .from(table).select(cols).eq().eq()                  (thenable → tableau)
//   .from(table).select(cols).eq().eq().maybeSingle()
// Ne prouve jamais le comportement réel de Postgres/RLS — seulement la logique
// applicative. Les garanties réelles viennent des tests d'intégration.

type Row = Record<string, unknown>;

export function createFakeSupabase(initialData: Record<string, Row[]> = {}) {
  const tables: Record<string, Row[]> = {};
  for (const [name, rows] of Object.entries(initialData)) {
    tables[name] = rows.map((r) => ({ ...r }));
  }

  function ensureTable(name: string): Row[] {
    tables[name] ??= [];
    return tables[name];
  }

  function matches(row: Row, filters: Record<string, unknown>): boolean {
    return Object.entries(filters).every(([key, value]) => row[key] === value);
  }

  const client = {
    from(table: string) {
      const rows = ensureTable(table);

      return {
        insert(payload: Row | Row[]) {
          const toInsert = Array.isArray(payload) ? payload : [payload];
          const inserted = toInsert.map((p, i) => ({
            id: (p as Row).id ?? `generated-${table}-${rows.length + i}`,
            ...p,
          }));
          rows.push(...inserted);

          return {
            select() {
              return {
                single: async () => ({ data: { ...inserted[0] }, error: null }),
                maybeSingle: async () => ({
                  data: inserted[0] ? { ...inserted[0] } : null,
                  error: null,
                }),
              };
            },
            then(resolve: (value: { data: null; error: null }) => void) {
              resolve({ data: null, error: null });
            },
          };
        },
        select() {
          const filters: Record<string, unknown> = {};
          const builder = {
            eq(column: string, value: unknown) {
              filters[column] = value;
              return builder;
            },
            order() {
              return builder;
            },
            limit() {
              return builder;
            },
            maybeSingle: async () => {
              const found = rows.find((r) => matches(r, filters));
              return { data: found ? { ...found } : null, error: null };
            },
            single: async () => {
              const found = rows.find((r) => matches(r, filters));
              return found
                ? { data: { ...found }, error: null }
                : { data: null, error: { message: "not found" } };
            },
            then(resolve: (value: { data: Row[]; error: null }) => void) {
              const found = rows.filter((r) => matches(r, filters)).map((r) => ({ ...r }));
              resolve({ data: found, error: null });
            },
          };
          return builder;
        },
        update(payload: Row) {
          const filters: Record<string, unknown> = {};
          const builder = {
            eq(column: string, value: unknown) {
              filters[column] = value;
              return builder;
            },
            then(resolve: (value: { data: null; error: null }) => void) {
              for (const row of rows) {
                if (matches(row, filters)) Object.assign(row, payload);
              }
              resolve({ data: null, error: null });
            },
          };
          return builder;
        },
        delete() {
          const filters: Record<string, unknown> = {};
          const builder = {
            eq(column: string, value: unknown) {
              filters[column] = value;
              return builder;
            },
            then(resolve: (value: { data: null; error: null }) => void) {
              const remaining = rows.filter((r) => !matches(r, filters));
              rows.length = 0;
              rows.push(...remaining);
              resolve({ data: null, error: null });
            },
          };
          return builder;
        },
        upsert(payload: Row, options?: { onConflict?: string }) {
          const conflictColumn = options?.onConflict ?? "id";
          const conflictValue = payload[conflictColumn];
          const existing = rows.find((r) => r[conflictColumn] === conflictValue);
          if (existing) {
            Object.assign(existing, payload);
          } else {
            rows.push({ id: `generated-${table}-${rows.length}`, ...payload });
          }
          return {
            then(resolve: (value: { data: null; error: null }) => void) {
              resolve({ data: null, error: null });
            },
          };
        },
      };
    },
    _tables: tables,
  };

  return client;
}
