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

const patterns = process.argv.slice(2);
if (patterns.length === 0) {
  console.error("Usage: node scripts/run-integration-tests.mjs <fichier-ou-pattern> [...]");
  process.exit(1);
}

const result = spawnSync("npx", ["vitest", "run", ...patterns], {
  cwd: "C:\\personal-intelligence",
  env: testEnv,
  stdio: "inherit",
  shell: true,
});

process.exit(result.status ?? 1);
