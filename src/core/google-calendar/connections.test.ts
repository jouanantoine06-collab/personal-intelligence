import { describe, it, expect, beforeEach, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { createFakeSupabase } from "@/core/test-helpers/fake-supabase";
import { decryptToken, resetTokenCipherKeyCacheForTests } from "@/lib/crypto/token-cipher";
import {
  deleteConnection,
  ensureFreshAccessToken,
  getConnectionStatus,
  GoogleCalendarReconnectRequiredError,
  revokeAndDeleteConnection,
  saveConnection,
} from "@/core/google-calendar/connections";
import { refreshAccessToken, revokeGoogleToken } from "@/core/google-calendar/oauth";

vi.mock("@/core/google-calendar/oauth", async () => {
  const actual = await vi.importActual<typeof import("@/core/google-calendar/oauth")>(
    "@/core/google-calendar/oauth",
  );
  return {
    ...actual,
    refreshAccessToken: vi.fn(),
    revokeGoogleToken: vi.fn(),
  };
});

const TEST_KEY = randomBytes(32).toString("base64");
const USER_ID = "user-1";

function futureIso(secondsFromNow: number): string {
  return new Date(Date.now() + secondsFromNow * 1000).toISOString();
}

describe("google-calendar connections", () => {
  beforeEach(() => {
    process.env.OAUTH_TOKEN_ENCRYPTION_KEY = TEST_KEY;
    resetTokenCipherKeyCacheForTests();
    vi.clearAllMocks();
  });

  describe("getConnectionStatus", () => {
    it("indique non-connecté quand aucune ligne n'existe", async () => {
      const supabase = createFakeSupabase({ google_calendar_connections: [] }) as never;
      const status = await getConnectionStatus(supabase, USER_ID);
      expect(status).toEqual({ connected: false, connectedAt: null, status: null });
    });

    it("indique connecté avec le statut réel quand une ligne existe", async () => {
      const supabase = createFakeSupabase({
        google_calendar_connections: [
          {
            user_id: USER_ID,
            status: "active",
            connected_at: "2026-01-01T00:00:00.000Z",
            encrypted_access_token: "should-not-matter",
          },
        ],
      }) as never;
      const status = await getConnectionStatus(supabase, USER_ID);
      expect(status).toEqual({
        connected: true,
        connectedAt: "2026-01-01T00:00:00.000Z",
        status: "active",
      });
    });
  });

  describe("saveConnection", () => {
    it("chiffre les tokens avant de les stocker", async () => {
      const supabase = createFakeSupabase({ google_calendar_connections: [] }) as never;

      await saveConnection(supabase, USER_ID, {
        accessToken: "plain-access",
        refreshToken: "plain-refresh",
        expiresInSeconds: 3600,
        grantedScopes: "https://www.googleapis.com/auth/calendar.events",
      });

      interface StoredConnectionRow {
        encrypted_access_token: string;
        encrypted_refresh_token: string;
        status: string;
      }
      const table = (supabase as unknown as { _tables: Record<string, StoredConnectionRow[]> })
        ._tables.google_calendar_connections;
      const typedRow = table?.[0];
      if (!typedRow) throw new Error("Ligne attendue après saveConnection");

      expect(typedRow.encrypted_access_token).not.toBe("plain-access");
      expect(typedRow.encrypted_refresh_token).not.toBe("plain-refresh");
      expect(decryptToken(typedRow.encrypted_access_token, USER_ID)).toBe("plain-access");
      expect(decryptToken(typedRow.encrypted_refresh_token, USER_ID)).toBe("plain-refresh");
      expect(typedRow.status).toBe("active");
    });
  });

  describe("deleteConnection", () => {
    it("supprime la ligne de l'utilisateur", async () => {
      const supabase = createFakeSupabase({
        google_calendar_connections: [{ user_id: USER_ID, status: "active" }],
      }) as never;

      await deleteConnection(supabase, USER_ID);

      const status = await getConnectionStatus(supabase, USER_ID);
      expect(status.connected).toBe(false);
    });
  });

  describe("ensureFreshAccessToken", () => {
    it("lève GoogleCalendarReconnectRequiredError si aucune connexion n'existe", async () => {
      const supabase = createFakeSupabase({ google_calendar_connections: [] }) as never;
      await expect(ensureFreshAccessToken(supabase, USER_ID)).rejects.toThrow(
        GoogleCalendarReconnectRequiredError,
      );
    });

    it("lève GoogleCalendarReconnectRequiredError sans appel réseau si le statut est 'error'", async () => {
      const supabase = createFakeSupabase({
        google_calendar_connections: [
          {
            user_id: USER_ID,
            status: "error",
            encrypted_access_token: "x",
            encrypted_refresh_token: "y",
            token_expires_at: futureIso(3600),
          },
        ],
      }) as never;

      await expect(ensureFreshAccessToken(supabase, USER_ID)).rejects.toThrow(
        GoogleCalendarReconnectRequiredError,
      );
      expect(refreshAccessToken).not.toHaveBeenCalled();
    });

    it("retourne l'access_token déchiffré sans renouveler s'il est encore valide", async () => {
      const supabase = createFakeSupabase({ google_calendar_connections: [] }) as never;
      await saveConnection(supabase, USER_ID, {
        accessToken: "still-valid",
        refreshToken: "refresh-token",
        expiresInSeconds: 3600,
        grantedScopes: "scope",
      });

      const token = await ensureFreshAccessToken(supabase, USER_ID);
      expect(token).toBe("still-valid");
      expect(refreshAccessToken).not.toHaveBeenCalled();
    });

    it("renouvelle l'access_token quand il est expiré et met à jour la ligne stockée", async () => {
      const supabase = createFakeSupabase({ google_calendar_connections: [] }) as never;
      await saveConnection(supabase, USER_ID, {
        accessToken: "expired-access",
        refreshToken: "refresh-token",
        expiresInSeconds: -10, // déjà expiré
        grantedScopes: "scope",
      });

      vi.mocked(refreshAccessToken).mockResolvedValue({
        accessToken: "renewed-access",
        refreshToken: null,
        expiresInSeconds: 3600,
        grantedScopes: "scope",
      });

      const token = await ensureFreshAccessToken(supabase, USER_ID);
      expect(token).toBe("renewed-access");
      expect(refreshAccessToken).toHaveBeenCalledWith({ refreshToken: "refresh-token" });

      // Un second appel immédiat ne redéclenche pas de renouvellement.
      vi.mocked(refreshAccessToken).mockClear();
      const secondToken = await ensureFreshAccessToken(supabase, USER_ID);
      expect(secondToken).toBe("renewed-access");
      expect(refreshAccessToken).not.toHaveBeenCalled();
    });

    it("marque la connexion en erreur et refuse de réessayer si le renouvellement échoue", async () => {
      const supabase = createFakeSupabase({ google_calendar_connections: [] }) as never;
      await saveConnection(supabase, USER_ID, {
        accessToken: "expired-access",
        refreshToken: "revoked-refresh",
        expiresInSeconds: -10,
        grantedScopes: "scope",
      });

      vi.mocked(refreshAccessToken).mockRejectedValue(new Error("invalid_grant: revoked"));

      await expect(ensureFreshAccessToken(supabase, USER_ID)).rejects.toThrow(
        GoogleCalendarReconnectRequiredError,
      );

      const status = await getConnectionStatus(supabase, USER_ID);
      expect(status.status).toBe("error");

      // Pas de nouvelle tentative automatique : un appel suivant échoue tout
      // de suite, sans repasser par refreshAccessToken.
      vi.mocked(refreshAccessToken).mockClear();
      await expect(ensureFreshAccessToken(supabase, USER_ID)).rejects.toThrow(
        GoogleCalendarReconnectRequiredError,
      );
      expect(refreshAccessToken).not.toHaveBeenCalled();
    });
  });

  describe("revokeAndDeleteConnection", () => {
    it("ne fait rien si aucune connexion n'existe", async () => {
      const supabase = createFakeSupabase({ google_calendar_connections: [] }) as never;
      await expect(revokeAndDeleteConnection(supabase, USER_ID)).resolves.toBeUndefined();
      expect(revokeGoogleToken).not.toHaveBeenCalled();
    });

    it("révoque le refresh_token déchiffré puis supprime la ligne", async () => {
      const supabase = createFakeSupabase({ google_calendar_connections: [] }) as never;
      await saveConnection(supabase, USER_ID, {
        accessToken: "access",
        refreshToken: "refresh-to-revoke",
        expiresInSeconds: 3600,
        grantedScopes: "scope",
      });
      vi.mocked(revokeGoogleToken).mockResolvedValue(undefined);

      await revokeAndDeleteConnection(supabase, USER_ID);

      expect(revokeGoogleToken).toHaveBeenCalledWith("refresh-to-revoke");
      const status = await getConnectionStatus(supabase, USER_ID);
      expect(status.connected).toBe(false);
    });

    it("supprime quand même la ligne si la révocation Google échoue", async () => {
      const supabase = createFakeSupabase({ google_calendar_connections: [] }) as never;
      await saveConnection(supabase, USER_ID, {
        accessToken: "access",
        refreshToken: "refresh-to-revoke",
        expiresInSeconds: 3600,
        grantedScopes: "scope",
      });
      vi.mocked(revokeGoogleToken).mockRejectedValue(new Error("network error"));

      await revokeAndDeleteConnection(supabase, USER_ID);

      const status = await getConnectionStatus(supabase, USER_ID);
      expect(status.connected).toBe(false);
    });
  });
});
