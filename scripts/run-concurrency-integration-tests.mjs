import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const env = Object.fromEntries(
  readFileSync("C:\\personal-intelligence\\.env.local", "utf8")
    .split(/\r?\n/)
    .filter((l) => l.includes("="))
    .map((l) => {
      const idx = l.indexOf("=");
      return [l.slice(0, idx).trim(), l.slice(idx + 1).trim()];
    }),
);

const testEnv = {
  ...process.env,
  SUPABASE_TEST_URL: env.NEXT_PUBLIC_SUPABASE_URL,
  SUPABASE_TEST_ANON_KEY: env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  SUPABASE_TEST_SERVICE_ROLE_KEY: env.SUPABASE_SERVICE_ROLE_KEY,
};

const result = spawnSync(
  "npx",
  ["vitest", "run", "src/core/memory-engine/concurrency.integration.test.ts"],
  { cwd: "C:\\personal-intelligence", env: testEnv, stdio: "inherit", shell: true },
);

process.exit(result.status ?? 1);
