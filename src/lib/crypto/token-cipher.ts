// Chiffrement des tokens OAuth avant stockage (V1.3a). AES-256-GCM via le
// module natif "crypto" de Node — jamais du code cryptographique artisanal,
// jamais de dépendance tierce. Uniquement utilisé côté serveur (Node.js
// runtime, jamais le middleware Edge).
//
// Format stocké, versionné explicitement pour permettre une évolution future
// sans ambiguïté sur d'anciennes valeurs : "v1:<iv b64>:<tag b64>:<ciphertext b64>".
// L'IV (12 octets) est aléatoire à chaque appel, jamais réutilisé. Le userId
// est lié cryptographiquement au chiffrement (AAD, non chiffré lui-même) :
// un déchiffrement avec un userId différent de celui utilisé au chiffrement
// échoue explicitement, plutôt que de renvoyer un token qui semble valide.

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH_BYTES = 12;
const KEY_LENGTH_BYTES = 32;
const FORMAT_VERSION = "v1";

let cachedKey: Buffer | null = null;

function loadKey(): Buffer {
  if (cachedKey) return cachedKey;

  const raw = process.env.OAUTH_TOKEN_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error(
      "OAUTH_TOKEN_ENCRYPTION_KEY manquante : impossible de chiffrer/déchiffrer les tokens OAuth.",
    );
  }

  const key = Buffer.from(raw, "base64");
  if (key.length !== KEY_LENGTH_BYTES) {
    throw new Error(
      `OAUTH_TOKEN_ENCRYPTION_KEY invalide : attendu ${KEY_LENGTH_BYTES} octets une fois décodée en base64, obtenu ${key.length}.`,
    );
  }

  cachedKey = key;
  return key;
}

// Réservé aux tests : force le rechargement de la clé (utile si la variable
// d'environnement change entre deux cas de test dans le même process).
export function resetTokenCipherKeyCacheForTests(): void {
  cachedKey = null;
}

export function encryptToken(plaintext: string, userId: string): string {
  const key = loadKey();
  const iv = randomBytes(IV_LENGTH_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  cipher.setAAD(Buffer.from(userId, "utf8"));

  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return [
    FORMAT_VERSION,
    iv.toString("base64"),
    authTag.toString("base64"),
    ciphertext.toString("base64"),
  ].join(":");
}

export function decryptToken(stored: string, userId: string): string {
  const parts = stored.split(":");
  if (parts.length !== 4 || parts[0] !== FORMAT_VERSION) {
    throw new Error("Format de token chiffré invalide ou version non supportée.");
  }
  const [, ivB64, tagB64, ciphertextB64] = parts;

  const key = loadKey();
  const iv = Buffer.from(ivB64 as string, "base64");
  const authTag = Buffer.from(tagB64 as string, "base64");
  const ciphertext = Buffer.from(ciphertextB64 as string, "base64");

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAAD(Buffer.from(userId, "utf8"));
  decipher.setAuthTag(authTag);

  // Lève une erreur si le tag ne correspond pas (altération) ou si l'AAD
  // (userId) diffère de celui utilisé au chiffrement — jamais de résultat
  // partiel ou silencieusement incorrect.
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString("utf8");
}
