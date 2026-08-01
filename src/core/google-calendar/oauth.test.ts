import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  buildGoogleAuthorizationUrl,
  exchangeCodeForTokens,
  GoogleOAuthError,
  refreshAccessToken,
  revokeGoogleToken,
} from "@/core/google-calendar/oauth";

const ORIGINAL_ENV = { ...process.env };

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("Google OAuth — construction de l'URL de consentement", () => {
  beforeEach(() => {
    process.env.GOOGLE_OAUTH_CLIENT_ID = "test-client-id";
  });
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("inclut le scope minimal, access_type=offline, prompt=consent et le state fourni", () => {
    const url = new URL(
      buildGoogleAuthorizationUrl({ redirectUri: "https://app.example/callback", state: "abc123" }),
    );
    expect(url.searchParams.get("client_id")).toBe("test-client-id");
    expect(url.searchParams.get("redirect_uri")).toBe("https://app.example/callback");
    expect(url.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/calendar.events");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.searchParams.get("state")).toBe("abc123");
    expect(url.searchParams.get("response_type")).toBe("code");
  });

  it("ne demande jamais un scope plus large que calendar.events", () => {
    const url = new URL(
      buildGoogleAuthorizationUrl({ redirectUri: "https://app.example/callback", state: "x" }),
    );
    expect(url.searchParams.get("scope")).not.toMatch(/\bcalendar\b(?!\.events)/);
  });
});

describe("Google OAuth — échange du code contre des tokens", () => {
  beforeEach(() => {
    process.env.GOOGLE_OAUTH_CLIENT_ID = "test-client-id";
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = "test-client-secret";
  });
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.unstubAllGlobals();
  });

  it("retourne les tokens quand Google répond avec un refresh_token", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(200, {
          access_token: "access-abc",
          refresh_token: "refresh-xyz",
          expires_in: 3600,
          scope: "https://www.googleapis.com/auth/calendar.events",
        }),
      ),
    );

    const tokens = await exchangeCodeForTokens({
      code: "auth-code",
      redirectUri: "https://app.example/callback",
    });

    expect(tokens).toEqual({
      accessToken: "access-abc",
      refreshToken: "refresh-xyz",
      expiresInSeconds: 3600,
      grantedScopes: "https://www.googleapis.com/auth/calendar.events",
    });
  });

  it("refuse une réponse sans refresh_token plutôt que de stocker une connexion non renouvelable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(200, {
          access_token: "access-abc",
          expires_in: 3600,
          scope: "https://www.googleapis.com/auth/calendar.events",
        }),
      ),
    );

    await expect(
      exchangeCodeForTokens({ code: "auth-code", redirectUri: "https://app.example/callback" }),
    ).rejects.toThrow(/refresh_token/);
  });

  it("lève GoogleOAuthError avec le code d'erreur Google en cas d'échec", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(400, { error: "invalid_grant", error_description: "Code déjà utilisé" }),
      ),
    );

    await expect(
      exchangeCodeForTokens({ code: "auth-code", redirectUri: "https://app.example/callback" }),
    ).rejects.toMatchObject({ googleErrorCode: "invalid_grant" });
  });
});

describe("Google OAuth — renouvellement du token", () => {
  beforeEach(() => {
    process.env.GOOGLE_OAUTH_CLIENT_ID = "test-client-id";
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = "test-client-secret";
  });
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.unstubAllGlobals();
  });

  it("renouvelle l'access_token sans exiger un nouveau refresh_token", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(200, {
          access_token: "new-access",
          expires_in: 3600,
          scope: "https://www.googleapis.com/auth/calendar.events",
        }),
      ),
    );

    const result = await refreshAccessToken({ refreshToken: "refresh-xyz" });
    expect(result.accessToken).toBe("new-access");
    expect(result.refreshToken).toBeNull();
  });

  it("propage une erreur explicite si le refresh_token est invalide/révoqué", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(400, { error: "invalid_grant", error_description: "Token has been revoked" }),
      ),
    );

    await expect(refreshAccessToken({ refreshToken: "revoked" })).rejects.toMatchObject({
      googleErrorCode: "invalid_grant",
    });
  });
});

describe("Google OAuth — révocation", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("ne lève pas d'erreur si Google confirme la révocation (200)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 200 })));
    await expect(revokeGoogleToken("some-token")).resolves.toBeUndefined();
  });

  it("ne lève pas d'erreur si le token était déjà invalide (400)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 400 })));
    await expect(revokeGoogleToken("already-invalid")).resolves.toBeUndefined();
  });

  it("lève une erreur sur un échec serveur inattendu (500)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 500 })));
    await expect(revokeGoogleToken("some-token")).rejects.toThrow();
  });
});

describe("Google OAuth — erreurs réseau", () => {
  it("GoogleOAuthError est bien une instance d'Error avec un nom distinct", () => {
    const err = new GoogleOAuthError("invalid_grant", "test");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("GoogleOAuthError");
  });
});
