import {
  ANTIGRAVITY_CLIENT_ID,
  ANTIGRAVITY_CLIENT_SECRET,
  ANTIGRAVITY_PROVIDER_ID
} from "../constants";
import { formatRefreshParts, parseRefreshParts } from "./auth";
import { storeCachedAuth } from "./cache";
import { invalidateProjectContextCache } from "./project";
import { printAntigravityConsole, createLogger } from "./logger";
import type { OAuthAuthDetails, PluginClient, RefreshParts } from "./types";

const log = createLogger("token");

interface OAuthErrorPayload {
  error?:
  | string
  | {
    code?: string;
    status?: string;
    message?: string;
  };
  error_description?: string;
}

/**
 * Parses OAuth error payloads returned by Google token endpoints, tolerating varied shapes.
 */
function parseOAuthErrorPayload(text: string | undefined): { code?: string; description?: string } {
  if (!text) {
    return {};
  }

  try {
    const payload = JSON.parse(text) as OAuthErrorPayload;
    if (!payload || typeof payload !== "object") {
      return { description: text };
    }

    let code: string | undefined;
    if (typeof payload.error === "string") {
      code = payload.error;
    } else if (payload.error && typeof payload.error === "object") {
      code = payload.error.status ?? payload.error.code;
      if (!payload.error_description && payload.error.message) {
        return { code, description: payload.error.message };
      }
    }

    const description = payload.error_description;
    if (description) {
      return { code, description };
    }

    if (payload.error && typeof payload.error === "object" && payload.error.message) {
      return { code, description: payload.error.message };
    }

    return { code };
  } catch {
    return { description: text };
  }
}

/**
 * Refreshes an Antigravity OAuth access token, updates persisted credentials, and handles revocation.
 */
export async function refreshAccessToken(
  auth: OAuthAuthDetails,
  client: PluginClient,
): Promise<OAuthAuthDetails | undefined> {
  const parts = parseRefreshParts(auth.refresh);
  if (!parts.refreshToken) {
    return undefined;
  }

  try {
    const response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: parts.refreshToken,
        client_id: ANTIGRAVITY_CLIENT_ID,
        client_secret: ANTIGRAVITY_CLIENT_SECRET,
      }),
    });

    if (!response.ok) {
      let errorText: string | undefined;
      try {
        errorText = await response.text();
      } catch {
        errorText = undefined;
      }

      const { code, description } = parseOAuthErrorPayload(errorText);
      const details = [code, description ?? errorText].filter(Boolean).join(": ");
      const baseMessage = `Antigravity token refresh failed (${response.status} ${response.statusText})`;
      printAntigravityConsole(
        "warn",
        `[OAuth] ${details ? `${baseMessage} - ${details}` : baseMessage}`,
      );

      if (code === "invalid_grant") {
        printAntigravityConsole(
          "warn",
          "[OAuth] Google revoked the stored refresh token. Run `opencode auth login` and reauthenticate the Google provider.",
        );
        invalidateProjectContextCache(auth.refresh);
        try {
          const clearedAuth: OAuthAuthDetails = {
            type: "oauth",
            refresh: formatRefreshParts({
              refreshToken: "",
              projectId: parts.projectId,
              managedProjectId: parts.managedProjectId,
            }),
            access: "",
            expires: 0,
          };
          await client.auth.set({
            path: { id: ANTIGRAVITY_PROVIDER_ID },
            body: clearedAuth,
          });
        } catch (storeError) {
          printAntigravityConsole("error", "Failed to clear stored Antigravity OAuth credentials", storeError);
        }
      }

      return undefined;
    }

    const payload = (await response.json()) as {
      access_token: string;
      expires_in: number;
      refresh_token?: string;
    };

    const refreshedParts: RefreshParts = {
      refreshToken: payload.refresh_token ?? parts.refreshToken,
      projectId: parts.projectId,
      managedProjectId: parts.managedProjectId,
    };

    const updatedAuth: OAuthAuthDetails = {
      ...auth,
      access: payload.access_token,
      expires: Date.now() + payload.expires_in * 1000,
      refresh: formatRefreshParts(refreshedParts),
    };

    storeCachedAuth(updatedAuth);
    invalidateProjectContextCache(auth.refresh);

    // NOTE: We don't save to client.auth.set here because it would overwrite
    // the multi-account refresh string with just this single account.
    // The caller (plugin.ts) handles saving via accountManager.toAuthDetails()
    // which properly preserves all accounts.

    return updatedAuth;
  } catch (error) {
    printAntigravityConsole(
      "error",
      "Failed to refresh Antigravity access token due to an unexpected error",
      error,
    );
    return undefined;
  }
}

/**
 * Result of validating a single account's token.
 */
export interface TokenValidationResult {
  index: number;
  valid: boolean;
  auth?: OAuthAuthDetails;
  error?: string;
  durationMs: number;
}

/**
 * Concurrently validates multiple account tokens.
 * Uses a semaphore to limit concurrent requests and prevent overwhelming the OAuth server.
 *
 * This optimization from Antigravity-Manager significantly reduces the time
 * to validate multiple accounts (e.g., 10 accounts from ~30s to ~6s).
 *
 * @param accounts Array of accounts to validate
 * @param client Plugin client for auth updates
 * @param maxConcurrent Maximum concurrent validation requests (default: 5)
 * @returns Array of validation results for each account
 */
export async function validateAccountsConcurrently(
  accounts: Array<{ index: number; auth: OAuthAuthDetails }>,
  client: PluginClient,
  maxConcurrent: number = 5,
): Promise<TokenValidationResult[]> {
  if (accounts.length === 0) {
    return [];
  }

  const startTime = Date.now();
  log.info(`Starting concurrent validation of ${accounts.length} accounts (max concurrent: ${maxConcurrent})`);

  // Semaphore for limiting concurrent requests
  let activeCount = 0;
  const queue: Array<() => void> = [];

  const acquire = (): Promise<void> => {
    if (activeCount < maxConcurrent) {
      activeCount++;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      queue.push(resolve);
    });
  };

  const release = (): void => {
    const next = queue.shift();
    if (next) {
      next();
    } else {
      activeCount--;
    }
  };

  // Validate all accounts concurrently with semaphore
  const results = await Promise.all(
    accounts.map(async ({ index, auth }): Promise<TokenValidationResult> => {
      const accountStartTime = Date.now();

      await acquire();
      try {
        const refreshed = await refreshAccessToken(auth, client);
        const durationMs = Date.now() - accountStartTime;

        if (refreshed) {
          log.info(`Account ${index + 1} validated successfully in ${durationMs}ms`);
          return {
            index,
            valid: true,
            auth: refreshed,
            durationMs,
          };
        } else {
          log.warn(`Account ${index + 1} validation failed in ${durationMs}ms`);
          return {
            index,
            valid: false,
            error: "Token refresh failed",
            durationMs,
          };
        }
      } catch (error) {
        const durationMs = Date.now() - accountStartTime;
        const errorMsg = error instanceof Error ? error.message : String(error);
        log.error(`Account ${index + 1} validation error in ${durationMs}ms: ${errorMsg}`);
        return {
          index,
          valid: false,
          error: errorMsg,
          durationMs,
        };
      } finally {
        release();
      }
    })
  );

  const totalDuration = Date.now() - startTime;
  const validCount = results.filter((r) => r.valid).length;
  log.info(
    `Concurrent validation complete: ${validCount}/${accounts.length} valid in ${totalDuration}ms ` +
    `(avg ${Math.round(totalDuration / accounts.length)}ms per account)`
  );

  return results;
}

/**
 * Validates a single account token and returns a simple validity check.
 * This is a lightweight check that can be used to verify an account before use.
 */
export async function isTokenValid(auth: OAuthAuthDetails): Promise<boolean> {
  const parts = parseRefreshParts(auth.refresh);
  if (!parts.refreshToken) {
    return false;
  }

  // Check if access token is still valid (with 5 minute buffer)
  if (auth.access && auth.expires && auth.expires > Date.now() + 5 * 60 * 1000) {
    return true;
  }

  // Try to refresh the token to validate it
  try {
    const response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: parts.refreshToken,
        client_id: ANTIGRAVITY_CLIENT_ID,
        client_secret: ANTIGRAVITY_CLIENT_SECRET,
      }),
    });

    return response.ok;
  } catch {
    return false;
  }
}
