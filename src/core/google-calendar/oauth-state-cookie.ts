// Nom du cookie httpOnly portant le "state" anti-CSRF entre /connect et
// /callback. Séparé des fichiers route.ts : Next.js n'autorise que des
// exports spécifiques (GET/POST/...) depuis un Route Handler.
export const STATE_COOKIE_NAME = "google_oauth_state";
