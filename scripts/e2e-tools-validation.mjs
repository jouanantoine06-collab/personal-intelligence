import { chromium } from "playwright";
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

const BASE_URL = "http://localhost:3000";
const results = [];

function check(label, condition, detail) {
  results.push({ label, ok: !!condition, detail });
  console.log(`${condition ? "PASS" : "FAIL"} — ${label}${detail ? " — " + detail : ""}`);
}

const env = Object.fromEntries(
  readFileSync("C:\\personal-intelligence\\.env.local", "utf8")
    .split(/\r?\n/)
    .filter((l) => l.includes("="))
    .map((l) => {
      const idx = l.indexOf("=");
      return [l.slice(0, idx).trim(), l.slice(idx + 1).trim()];
    }),
);
const serviceRole = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

function countAssistantRepliesInBrowser() {
  return Array.from(document.querySelectorAll("li")).filter((li) =>
    li.textContent?.includes("Assistant"),
  ).length;
}

async function sendMessageAndWaitForReply(page, text, timeout = 45000) {
  const before = await page.evaluate(countAssistantRepliesInBrowser);
  await page.locator('input[type="text"]').fill(text);
  await page.getByRole("button", { name: "Envoyer" }).click();
  await page.waitForFunction(
    (expected) => {
      const count = Array.from(document.querySelectorAll("li")).filter((li) =>
        li.textContent?.includes("Assistant"),
      ).length;
      return count >= expected;
    },
    before + 1,
    { timeout },
  );
  const replies = await page.$$eval("li", (items) =>
    items.filter((li) => li.textContent?.includes("Assistant")).map((li) => li.textContent ?? ""),
  );
  return replies.at(-1) ?? "";
}

async function run() {
  const email = `pi-e2e-tools-${Date.now()}@example.com`;
  const password = "TestPassword123!";
  const marker = `NOTE-${Date.now()}`;

  const { data: created, error: createError } = await serviceRole.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (createError) throw createError;
  console.log(`Utilisateur de test créé : ${email} (${created.user.id})`);

  const browser = await chromium.launch();
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto(`${BASE_URL}/login`);
  await page.locator('input[name="email"]').fill(email);
  await page.locator('input[name="password"]').fill(password);
  await page.getByRole("button", { name: "Se connecter" }).click();
  await page.waitForURL(BASE_URL + "/", { timeout: 15000 });
  check("connexion réussie", page.url() === BASE_URL + "/");

  await page.getByRole("button", { name: "Nouvelle conversation" }).click();
  await page.waitForURL(/\/c\//, { timeout: 10000 });

  // 1. Outil no_risk : jamais de confirmation.
  const listReply1 = await sendMessageAndWaitForReply(page, "Liste mes notes internes.");
  check(
    "list_internal_notes exécuté directement (no_risk, réponse réelle de Claude)",
    listReply1.length > 0,
    listReply1.slice(0, 150),
  );

  // 2. Outil reversible : demande d'autorisation, "once".
  const requestReply = await sendMessageAndWaitForReply(
    page,
    `Note que je dois relire le contrat avant vendredi (référence ${marker}-alpha).`,
  );
  check(
    "demande d'autorisation reçue pour create_internal_note",
    /autoris|confirm|permission/i.test(requestReply),
    requestReply.slice(0, 200),
  );

  const onceReply = await sendMessageAndWaitForReply(page, "Oui, une seule fois.");
  check("autorisation 'once' → note créée (réponse réelle)", onceReply.length > 0, onceReply.slice(0, 150));

  const listReply2 = await sendMessageAndWaitForReply(page, "Liste mes notes internes.");
  check(
    "la note créée via 'once' apparaît dans la liste",
    listReply2.includes(`${marker}-alpha`) || listReply2.toLowerCase().includes(marker.toLowerCase()),
    listReply2.slice(0, 250),
  );

  // 3. Vérifie qu'une seconde demande de création redemande bien une autorisation (once ne persiste pas).
  const requestReply2 = await sendMessageAndWaitForReply(
    page,
    `Note que je dois rappeler le client demain matin (référence ${marker}-beta).`,
  );
  check(
    "'once' ne persiste rien : une nouvelle demande d'autorisation est bien reposée",
    /autoris|confirm|permission/i.test(requestReply2),
    requestReply2.slice(0, 200),
  );

  const alwaysReply = await sendMessageAndWaitForReply(page, "Oui, toujours, pour cette session et au-delà.");
  check("autorisation 'always' accordée (réponse réelle)", alwaysReply.length > 0, alwaysReply.slice(0, 150));

  // 4. Une nouvelle création ne doit PLUS jamais redemander.
  const directReply = await sendMessageAndWaitForReply(
    page,
    `Note que je dois envoyer le compte-rendu de la réunion (référence ${marker}-gamma).`,
  );
  check(
    "après 'always', une nouvelle note est créée sans nouvelle demande d'autorisation",
    !/autoris|confirm|permission/i.test(directReply) && directReply.length > 0,
    directReply.slice(0, 200),
  );

  await browser.close();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} vérifications passées.`);
  console.log(`EMAIL_UTILISE=${email}`);
  console.log(`USER_ID=${created.user.id}`);
  if (failed.length > 0) process.exitCode = 1;
}

run().catch((error) => {
  console.error("ERREUR SCRIPT E2E TOOLS:", error);
  process.exitCode = 1;
});
