import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { randomBytes } from "node:crypto";
import {
  decryptToken,
  encryptToken,
  resetTokenCipherKeyCacheForTests,
} from "@/lib/crypto/token-cipher";

const TEST_KEY = randomBytes(32).toString("base64");
const ORIGINAL_KEY = process.env.OAUTH_TOKEN_ENCRYPTION_KEY;

describe("token-cipher (AES-256-GCM)", () => {
  beforeEach(() => {
    process.env.OAUTH_TOKEN_ENCRYPTION_KEY = TEST_KEY;
    resetTokenCipherKeyCacheForTests();
  });

  afterEach(() => {
    process.env.OAUTH_TOKEN_ENCRYPTION_KEY = ORIGINAL_KEY;
    resetTokenCipherKeyCacheForTests();
  });

  it("déchiffre exactement ce qui a été chiffré (round-trip)", () => {
    const plaintext = "ya29.a0Ar-real-looking-access-token";
    const stored = encryptToken(plaintext, "user-1");
    expect(decryptToken(stored, "user-1")).toBe(plaintext);
  });

  it("produit un IV différent à chaque appel (jamais de nonce réutilisé)", () => {
    const a = encryptToken("même-contenu", "user-1");
    const b = encryptToken("même-contenu", "user-1");
    expect(a).not.toBe(b);
  });

  it("stocke un format versionné explicite", () => {
    const stored = encryptToken("secret", "user-1");
    const parts = stored.split(":");
    expect(parts[0]).toBe("v1");
    expect(parts).toHaveLength(4);
  });

  it("échoue si le texte chiffré a été altéré (détection d'intégrité GCM)", () => {
    const stored = encryptToken("secret", "user-1");
    const parts = stored.split(":");
    const tamperedCiphertext = Buffer.from(parts[3] as string, "base64");
    tamperedCiphertext[0] = (tamperedCiphertext[0] ?? 0) ^ 0xff;
    const tampered = [parts[0], parts[1], parts[2], tamperedCiphertext.toString("base64")].join(
      ":",
    );
    expect(() => decryptToken(tampered, "user-1")).toThrow();
  });

  it("échoue si le tag d'authentification a été altéré", () => {
    const stored = encryptToken("secret", "user-1");
    const parts = stored.split(":");
    const tamperedTag = Buffer.from(parts[2] as string, "base64");
    tamperedTag[0] = (tamperedTag[0] ?? 0) ^ 0xff;
    const tampered = [parts[0], parts[1], tamperedTag.toString("base64"), parts[3]].join(":");
    expect(() => decryptToken(tampered, "user-1")).toThrow();
  });

  it("échoue si déchiffré avec un userId différent (AAD lié à l'utilisateur)", () => {
    const stored = encryptToken("secret", "user-1");
    expect(() => decryptToken(stored, "user-2")).toThrow();
  });

  it("échoue sur un format inconnu ou une version non supportée", () => {
    expect(() => decryptToken("not-a-valid-format", "user-1")).toThrow();
    expect(() => decryptToken("v2:aa:bb:cc", "user-1")).toThrow();
  });

  it("lève une erreur claire si la clé d'environnement est absente", () => {
    delete process.env.OAUTH_TOKEN_ENCRYPTION_KEY;
    resetTokenCipherKeyCacheForTests();
    expect(() => encryptToken("secret", "user-1")).toThrow(/OAUTH_TOKEN_ENCRYPTION_KEY/);
  });

  it("lève une erreur claire si la clé n'a pas la bonne longueur", () => {
    process.env.OAUTH_TOKEN_ENCRYPTION_KEY = Buffer.from("trop-courte").toString("base64");
    resetTokenCipherKeyCacheForTests();
    expect(() => encryptToken("secret", "user-1")).toThrow(/32 octets/);
  });
});
