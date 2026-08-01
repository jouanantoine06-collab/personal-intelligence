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
  // Le tour est terminé côté serveur (le message est visible) avant de continuer —
  // évite exactement le chevauchement de tours observé lors de la première tentative
  // (navigation avant la fin réelle du tour précédent).
  const replies = await page.$$eval("li", (items) =>
    items.filter((li) => li.textContent?.includes("Assistant")).map((li) => li.textContent ?? ""),
  );
  return replies.at(-1) ?? "";
}

async function run() {
  // NOTE : l'inscription via l'UI publique (signUp) est actuellement bloquée dans ce projet
  // par la limite d'envoi d'emails de Supabase (voir rapport). On crée donc l'utilisateur de
  // test via l'API admin (service_role) — bypass volontaire et documenté, PAS un test de
  // l'inscription publique elle-même, qui reste non vérifiée par ce script.
  const email = `pi-e2e-${Date.now()}@example.com`;
  const password = "TestPassword123!";
  const marker = `E2E-${Date.now()}`;

  const { data: created, error: createError } = await serviceRole.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (createError) throw createError;
  console.log(`Utilisateur de test créé via admin API : ${email} (${created.user.id})`);

  const browser = await chromium.launch();
  const context = await browser.newContext();
  const page = await context.newPage();
  page.on("dialog", (dialog) => dialog.accept());

  // 1. Accès non authentifié → redirection /login
  await page.goto(`${BASE_URL}/`);
  await page.waitForURL(/\/login/);
  check("accès non authentifié à / redirige vers /login", page.url().includes("/login"));

  // 2. Connexion (via UI réelle, utilisateur pré-créé)
  await page.locator('input[name="email"]').fill(email);
  await page.locator('input[name="password"]').fill(password);
  await page.getByRole("button", { name: "Se connecter" }).click();
  await page.waitForURL(BASE_URL + "/", { timeout: 15000 });
  check("connexion via l'UI → redirection vers /", page.url() === BASE_URL + "/");

  // 3. Persistance de session après rafraîchissement
  await page.reload();
  await page.waitForTimeout(500);
  check(
    "session persistante après rafraîchissement (pas de redirection /login)",
    page.url() === BASE_URL + "/",
  );

  // 4. Déconnexion
  await page.getByRole("button", { name: "Se déconnecter" }).click();
  await page.waitForURL(/\/login/, { timeout: 10000 });
  check("déconnexion → redirection /login", page.url().includes("/login"));

  // 5. Accès protégé refusé après déconnexion
  await page.goto(`${BASE_URL}/memory`);
  await page.waitForURL(/\/login/, { timeout: 10000 });
  check("accès à /memory refusé sans session → redirection /login", page.url().includes("/login"));

  // 6. Reconnexion
  await page.locator('input[name="email"]').fill(email);
  await page.locator('input[name="password"]').fill(password);
  await page.getByRole("button", { name: "Se connecter" }).click();
  await page.waitForURL(BASE_URL + "/", { timeout: 15000 });
  check("reconnexion réussie → accès à /", page.url() === BASE_URL + "/");

  // 7. Création d'une conversation
  await page.getByRole("button", { name: "Nouvelle conversation" }).click();
  await page.waitForURL(/\/c\//, { timeout: 10000 });
  check("création de conversation → navigation vers /c/[id]", /\/c\//.test(page.url()));
  const conversationUrl = page.url();

  // 8. Envoi d'un message déclenchant un candidat mémoire (vrai appel Claude)
  const firstReply = await sendMessageAndWaitForReply(
    page,
    `Souviens-toi que ${marker} est ma priorité actuelle.`,
  );
  check("réponse réelle de Claude reçue après le premier message", firstReply.length > 0, firstReply.slice(0, 120));

  // 9. Vérifier la proposition en attente sur /memory
  await page.goto(`${BASE_URL}/memory`);
  await page.waitForSelector(`text=${marker}`, { timeout: 10000 });
  check("la proposition apparaît dans /memory (propositions en attente)", true);

  // 10. Confirmation depuis le chat — on attend la fin RÉELLE du tour avant de continuer
  await page.goto(conversationUrl);
  const confirmReply = await sendMessageAndWaitForReply(page, "Oui, confirme.");
  check(
    "l'assistant confirme la mémorisation après 'Oui, confirme.'",
    confirmReply.length > 0,
    confirmReply.slice(0, 160),
  );

  await page.goto(`${BASE_URL}/memory`);
  await page.waitForTimeout(500);
  let pendingSection = await page.locator("h2:has-text('Propositions en attente')").locator("..").innerText();
  let activeSection = await page.locator("h2:has-text('Souvenirs')").locator("..").innerText();
  check(
    "après confirmation via chat : souvenir actif, plus en attente",
    !pendingSection.includes(marker) && activeSection.includes(marker),
  );

  // 11. Deuxième candidat mémoire, refusé depuis le chat
  const marker2 = `${marker}-REJECT`;
  await page.goto(conversationUrl);
  await sendMessageAndWaitForReply(page, `Retiens que ${marker2} est important.`);
  const rejectReply = await sendMessageAndWaitForReply(page, "Non, laisse tomber.");
  check(
    "l'assistant confirme le refus après 'Non, laisse tomber.'",
    rejectReply.length > 0,
    rejectReply.slice(0, 160),
  );

  await page.goto(`${BASE_URL}/memory`);
  await page.waitForTimeout(500);
  pendingSection = await page.locator("h2:has-text('Propositions en attente')").locator("..").innerText();
  activeSection = await page.locator("h2:has-text('Souvenirs')").locator("..").innerText();
  check(
    "après refus via chat : pas de souvenir actif créé pour le second candidat",
    !activeSection.includes(marker2) && !pendingSection.includes(marker2),
  );

  // 12. Correction d'un souvenir actif + vérification de la supersession
  await page.getByRole("link", { name: new RegExp(marker.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")) }).first().click();
  await page.waitForTimeout(500);
  const correctedContent = `${marker} — CORRIGÉ`;
  await page.locator("article label input").first().fill(correctedContent);
  await page.getByRole("button", { name: "Enregistrer la correction" }).click();
  await page.waitForTimeout(1500);
  const detailAfterCorrection = await page.locator("article").innerText();
  check(
    "correction d'un souvenir actif → nouvelle page affiche 'remplace'",
    detailAfterCorrection.includes(correctedContent) && detailAfterCorrection.includes("remplace"),
  );

  // 13. Suppression
  await page.getByRole("button", { name: "Supprimer" }).click();
  await page.waitForURL(BASE_URL + "/memory", { timeout: 10000 });
  await page.waitForTimeout(500);
  const afterDeleteActiveSection = await page
    .locator("h2:has-text('Souvenirs')")
    .locator("..")
    .innerText();
  check(
    "suppression → le souvenir corrigé n'apparaît plus dans les souvenirs actifs",
    !afterDeleteActiveSection.includes(correctedContent),
  );

  await browser.close();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} vérifications passées.`);
  console.log(`EMAIL_UTILISE=${email}`);
  console.log(`USER_ID=${created.user.id}`);
  console.log(`MARKER_UTILISE=${marker}`);
  if (failed.length > 0) process.exitCode = 1;
}

run().catch((error) => {
  console.error("ERREUR SCRIPT E2E:", error);
  process.exitCode = 1;
});
