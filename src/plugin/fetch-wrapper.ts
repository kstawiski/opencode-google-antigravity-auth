import type { PluginContext, GetAuth, ProjectContextResult } from "./types";
import { CODE_ASSIST_ENDPOINT_FALLBACKS, ANTIGRAVITY_PROVIDER_ID } from "../constants";
import { isOAuthAuth, accessTokenExpired, parseRefreshParts } from "./auth";
import { AccountManager, type ModelFamily } from "./accounts";
import { loadAccounts } from "./storage";
import { refreshAccessToken } from "./token";
import { ensureProjectContext } from "./project";
import { isGenerativeLanguageRequest, prepareAntigravityRequest, transformAntigravityResponse } from "./request";
import { getSessionId } from "./request-helpers";
import { startAntigravityDebugRequest } from "./debug";
import { createLogger, printAntigravityConsole } from "./logger";

const log = createLogger("fetch-wrapper");

const RATE_LIMIT_BACKOFF_BASE_MS = 1000;
const RATE_LIMIT_BACKOFF_MAX_MS = 60 * 60 * 1000;
const RATE_LIMIT_SERVER_RETRY_MAX_MS = 24 * 60 * 60 * 1000;

interface RateLimitDelay {
  attempt: number;
  serverRetryAfterMs: number | null;
  delayMs: number;
}

/**
 * Adds ±20% random jitter to a delay value to prevent thundering herd.
 * This helps distribute retry attempts across time when multiple clients
 * are rate-limited simultaneously.
 */
export function addJitter(delayMs: number, jitterPercent: number = 0.2): number {
  const jitterRange = delayMs * jitterPercent;
  const jitter = (Math.random() * 2 - 1) * jitterRange; // Random value between -jitterRange and +jitterRange
  return Math.max(0, Math.floor(delayMs + jitter));
}

export function computeExponentialBackoffMs(
  attempt: number,
  baseMs: number = RATE_LIMIT_BACKOFF_BASE_MS,
  maxMs: number = RATE_LIMIT_BACKOFF_MAX_MS,
  withJitter: boolean = true,
): number {
  const safeAttempt = Math.max(1, Math.floor(attempt));
  const multiplier = 2 ** (safeAttempt - 1);
  const backoff = Math.min(maxMs, Math.max(0, Math.floor(baseMs * multiplier)));
  return withJitter ? addJitter(backoff) : backoff;
}

function toUrlStr(value: RequestInfo | URL): string {
  if (value instanceof URL) {
    return value.toString();
  }
  if (typeof value === "string") {
    return value;
  }
  return (value as Request).url ?? value.toString();
}

function extractModelFromUrl(urlString: string): string | null {
  const match = urlString.match(/\/models\/([^:\/?]+)(?::\w+)?/);
  return match?.[1] ?? null;
}

function getModelFamilyFromUrl(urlString: string): ModelFamily {
  const model = extractModelFromUrl(urlString);
  if (model && model.includes("claude")) {
    return "claude";
  }
  if (model && model.includes("flash")) {
    return "gemini-flash";
  }
  return "gemini-pro";
}

export function sleep(ms: number, signal?: AbortSignal | null): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new Error("Aborted"));
      return;
    }

    const timeout = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);

    const onAbort = () => {
      cleanup();
      reject(signal?.reason instanceof Error ? signal.reason : new Error("Aborted"));
    };

    const cleanup = () => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
    };

    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function sleepWithBackoff(totalMs: number, signal?: AbortSignal | null): Promise<void> {
  const stepsMs = [3000, 5000, 10000, 20000, 30000];
  let remainingMs = Math.max(0, totalMs);
  let stepIndex = 0;

  while (remainingMs > 0) {
    const stepMs = stepsMs[stepIndex] ?? stepsMs[stepsMs.length - 1] ?? 30000;
    const waitMs = Math.min(remainingMs, stepMs);
    await sleep(waitMs, signal);
    remainingMs -= waitMs;
    stepIndex++;
  }
}

export function overrideEndpointForRequest(request: RequestInfo | URL, endpoint: string): RequestInfo | URL {
  const replaceBase = (url: string) => url.replace(/^https:\/\/[^\/]+/, endpoint);

  if (typeof request === "string") {
    return replaceBase(request);
  }

  if (request instanceof URL) {
    return replaceBase(request.toString());
  }

  if (request instanceof Request) {
    const newUrl = replaceBase(request.url);
    if (newUrl === request.url) {
      return request;
    }
    return new Request(newUrl, request);
  }

  return request;
}

function parseRetryAfterMs(response: Response): number | null {
  const retryAfterMsHeader = response.headers.get("retry-after-ms");
  const retryAfterSecondsHeader = response.headers.get("retry-after");

  if (retryAfterMsHeader) {
    const parsed = parseInt(retryAfterMsHeader, 10);
    if (!Number.isNaN(parsed) && parsed >= 0) {
      return Math.min(parsed, RATE_LIMIT_SERVER_RETRY_MAX_MS);
    }
  }

  if (retryAfterSecondsHeader) {
    const parsed = parseInt(retryAfterSecondsHeader, 10);
    if (!Number.isNaN(parsed) && parsed >= 0) {
      return Math.min(parsed * 1000, RATE_LIMIT_SERVER_RETRY_MAX_MS);
    }
  }

  return null;
}

function parseDurationLikeToMs(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }

  const matches = [...trimmed.matchAll(/(\d+(?:\.\d+)?)(ms|s|m|h)/g)];
  if (matches.length === 0) {
    return null;
  }

  let totalMs = 0;
  for (const match of matches) {
    const value = match[1];
    const unit = match[2];
    if (!value || !unit) continue;

    const parsed = Number.parseFloat(value);
    if (!Number.isFinite(parsed) || parsed < 0) continue;

    switch (unit) {
      case "ms":
        totalMs += parsed;
        break;
      case "s":
        totalMs += parsed * 1000;
        break;
      case "m":
        totalMs += parsed * 60 * 1000;
        break;
      case "h":
        totalMs += parsed * 60 * 60 * 1000;
        break;
    }
  }

  if (!Number.isFinite(totalMs) || totalMs <= 0) {
    return null;
  }

  return Math.min(Math.floor(totalMs), RATE_LIMIT_SERVER_RETRY_MAX_MS);
}

function formatWaitTimeMs(ms: number): string {
  const totalSeconds = Math.max(1, Math.ceil(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return minutes > 0 ? `${hours}h${minutes}m` : `${hours}h`;
  }
  if (minutes > 0) {
    return seconds > 0 ? `${minutes}m${seconds}s` : `${minutes}m`;
  }
  return `${seconds}s`;
}

type RateLimitBodyInfo = {
  retryDelayMs: number | null;
  message?: string;
};

function extractRateLimitBodyInfo(body: unknown): RateLimitBodyInfo {
  if (!body || typeof body !== "object") {
    return { retryDelayMs: null };
  }

  const error = (body as { error?: unknown }).error;
  if (!error || typeof error !== "object") {
    return { retryDelayMs: null };
  }

  const message = typeof (error as { message?: unknown }).message === "string" ? String((error as any).message) : undefined;

  const details = (error as { details?: unknown }).details;
  if (Array.isArray(details)) {
    for (const detail of details) {
      if (!detail || typeof detail !== "object") continue;
      const type = (detail as { "@type"?: unknown })["@type"];
      if (typeof type === "string" && type.includes("google.rpc.RetryInfo")) {
        const retryDelay = (detail as { retryDelay?: unknown }).retryDelay;
        if (typeof retryDelay === "string") {
          const retryDelayMs = parseDurationLikeToMs(retryDelay);
          if (retryDelayMs !== null) {
            return { retryDelayMs, message };
          }
        }
      }
    }

    for (const detail of details) {
      if (!detail || typeof detail !== "object") continue;
      const metadata = (detail as { metadata?: unknown }).metadata;
      if (!metadata || typeof metadata !== "object") continue;
      const quotaResetDelay = (metadata as { quotaResetDelay?: unknown }).quotaResetDelay;
      if (typeof quotaResetDelay === "string") {
        const quotaResetDelayMs = parseDurationLikeToMs(quotaResetDelay);
        if (quotaResetDelayMs !== null) {
          return { retryDelayMs: quotaResetDelayMs, message };
        }
      }
    }
  }

  if (message) {
    const afterMatch = message.match(/reset after\s+([0-9hms\.]+)/i);
    const rawDuration = afterMatch?.[1];
    if (rawDuration) {
      const parsed = parseDurationLikeToMs(rawDuration);
      if (parsed !== null) {
        return { retryDelayMs: parsed, message };
      }
    }
  }

  return { retryDelayMs: null, message };
}

function parseRateLimitInfoFromBodyText(bodyText: string): RateLimitBodyInfo {
  try {
    const direct = JSON.parse(bodyText) as unknown;
    return extractRateLimitBodyInfo(direct);
  } catch {
    // Not JSON, may be SSE.
  }

  const lines = bodyText.split("\n");
  for (const line of lines) {
    if (!line.startsWith("data:")) {
      continue;
    }
    const jsonText = line.slice(5).trim();
    if (!jsonText) {
      continue;
    }
    try {
      const parsed = JSON.parse(jsonText) as unknown;
      const info = extractRateLimitBodyInfo(parsed);
      if (info.retryDelayMs !== null || info.message) {
        return info;
      }
    } catch {
      continue;
    }
  }

  return { retryDelayMs: null };
}

async function extractRetryAfterFromBodyMs(response: Response): Promise<RateLimitBodyInfo> {
  try {
    const text = await response.clone().text();
    return parseRateLimitInfoFromBodyText(text);
  } catch {
    return { retryDelayMs: null };
  }
}

interface AttemptInfo {
  resolvedUrl: string;
  method?: string;
  headers?: HeadersInit;
  body?: BodyInit | null;
  streaming: boolean;
  requestedModel?: string;
}

/**
 * Error types that trigger different handling strategies.
 * Based on Antigravity-Manager patterns.
 */
export type ErrorType = "rate-limit" | "auth-expired" | "forbidden" | "server-error" | "network";

/**
 * Backoff strategies per error type (inspired by Antigravity-Manager).
 * - auth-expired: Fixed short delay (token refresh usually quick)
 * - forbidden: Fixed medium delay (may need account switch)
 * - rate-limit: Exponential with jitter
 * - server-error: Exponential with jitter, shorter max
 * - network: Exponential with jitter
 */
export const ERROR_BACKOFF_CONFIG: Record<ErrorType, { baseMs: number; maxMs: number; fixed?: boolean }> = {
  "auth-expired": { baseMs: 200, maxMs: 1000, fixed: true },
  "forbidden": { baseMs: 500, maxMs: 5000, fixed: true },
  "rate-limit": { baseMs: RATE_LIMIT_BACKOFF_BASE_MS, maxMs: RATE_LIMIT_BACKOFF_MAX_MS },
  "server-error": { baseMs: 1000, maxMs: 30000 },
  "network": { baseMs: 1000, maxMs: 60000 },
};

export function computeErrorBackoffMs(errorType: ErrorType, attempt: number): number {
  const config = ERROR_BACKOFF_CONFIG[errorType];
  if (config.fixed) {
    return addJitter(config.baseMs);
  }
  return computeExponentialBackoffMs(attempt, config.baseMs, config.maxMs, true);
}

interface EndpointLoopResult {
  type: "success" | "rate-limit" | "retry-soon" | "all-failed" | "auth-error" | "forbidden-error";
  response?: Response;
  error?: Error;
  retryAfterMs?: number;
  attemptInfo?: AttemptInfo;
  errorType?: ErrorType;
}

async function handleRateLimit(
  response: Response,
  account: ReturnType<AccountManager["getCurrentOrNextForFamily"]> & {},
  accountManager: AccountManager,
  accountCount: number,
  streaming: boolean,
  client: PluginContext["client"],
  debugContext: ReturnType<typeof startAntigravityDebugRequest>,
  requestedModel: string | undefined,
  abortSignal: AbortSignal | undefined,
  getRateLimitDelay: (accountIndex: number, serverRetryAfterMs: number | null) => RateLimitDelay,
  family: ModelFamily,
): Promise<EndpointLoopResult> {
  const retryAfterHeaderMs = parseRetryAfterMs(response);
  const bodyInfo = await extractRetryAfterFromBodyMs(response);
  const retryAfterBodyMs = bodyInfo.retryDelayMs;
  const serverRetryAfterMs = retryAfterBodyMs ?? retryAfterHeaderMs;

  const { attempt, delayMs, serverRetryAfterMs: appliedServerRetryMs } = getRateLimitDelay(account.index, serverRetryAfterMs);
  const retryAfterMs = delayMs;
  const waitTimeSec = Math.max(1, Math.ceil(retryAfterMs / 1000));

  const retrySource = retryAfterBodyMs !== null ? "body" : retryAfterHeaderMs !== null ? "header" : "backoff";

  printAntigravityConsole(
    "error",
    `Rate limited (429). Retrying after ${formatWaitTimeMs(retryAfterMs)} (attempt ${attempt}, source=${retrySource})${appliedServerRetryMs !== null ? `; server retry=${formatWaitTimeMs(appliedServerRetryMs)}` : ""}.`,
  );

  if (bodyInfo.message) {
    printAntigravityConsole("error", `429 message: ${bodyInfo.message.slice(0, 500)}`);
  }

  if (accountCount === 1) {
    try {
      await transformAntigravityResponse(response, streaming, client, debugContext, requestedModel, getSessionId());
    } catch {}

    try {
      await client.tui.showToast({
        body: {
          message: `Antigravity Rate Limited. Retrying in ${formatWaitTimeMs(retryAfterMs)} (attempt ${attempt})...`,
          variant: "warning",
        },
      });
    } catch {}

    accountManager.markRateLimited(account, retryAfterMs, family);

    log.info(`Account ${account.index + 1}/${accountCount} rate-limited`, {
      fromAccountIndex: account.index,
      fromAccountEmail: account.email,
      accountCount,
      retryAfterMs,
      retryAfterHeaderMs,
      retryAfterBodyMs,
      serverRetryAfterMs: appliedServerRetryMs,
      retrySource,
      errorMessage: bodyInfo.message ? bodyInfo.message.slice(0, 200) : undefined,
      attempt,
      reason: "rate-limit",
    });

    try {
      await accountManager.save();
    } catch (error) {
      log.warn("Failed to save rate limit state", {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    return { type: "rate-limit", retryAfterMs };
  }

  const switchThresholdMs = 5000;

  if (retryAfterMs <= switchThresholdMs) {
    log.info("Rate-limited briefly; retrying same account", {
      accountIndex: account.index,
      accountEmail: account.email,
      accountCount,
      retryAfterMs,
      retryAfterHeaderMs,
      retryAfterBodyMs,
      serverRetryAfterMs: appliedServerRetryMs,
      retrySource,
      errorMessage: bodyInfo.message ? bodyInfo.message.slice(0, 200) : undefined,
      attempt,
      switchThresholdMs,
    });

    try {
      await client.tui.showToast({
        body: {
          message: `Rate limited. Retrying in ${formatWaitTimeMs(retryAfterMs)} (attempt ${attempt})...`,
          variant: "warning",
        },
      });
    } catch {}

    await sleepWithBackoff(retryAfterMs, abortSignal);
    return { type: "retry-soon" };
  }

  accountManager.markRateLimited(account, retryAfterMs, family);
  accountManager.recordRateLimit(account);

  log.info(`Account ${account.index + 1}/${accountCount} rate-limited, switching...`, {
    fromAccountIndex: account.index,
    fromAccountEmail: account.email,
    accountCount,
    retryAfterMs,
    retryAfterHeaderMs,
    retryAfterBodyMs,
    serverRetryAfterMs: appliedServerRetryMs,
    retrySource,
    errorMessage: bodyInfo.message ? bodyInfo.message.slice(0, 200) : undefined,
    attempt,
    reason: "rate-limit",
    totalRateLimits: account.totalRateLimits,
  });

  try {
    await client.tui.showToast({
      body: {
        message: `Rate limited on ${account.email || `Account ${account.index + 1}`} (retry in ${formatWaitTimeMs(retryAfterMs)}). Switching...`,
        variant: "warning",
      },
    });
  } catch {}

  try {
    await accountManager.save();
  } catch (error) {
    log.warn("Failed to save rate limit state", {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return { type: "rate-limit", retryAfterMs };
}

async function handleServerError(
  response: Response,
  account: ReturnType<AccountManager["getCurrentOrNextForFamily"]> & {},
  accountManager: AccountManager,
  accountCount: number,
  client: PluginContext["client"],
  family: ModelFamily,
): Promise<EndpointLoopResult> {
  const retryAfterMs = computeErrorBackoffMs("server-error", 1);

  // For 500 errors, we use a fixed short retry rather than the heavy defaults
  accountManager.markRateLimited(account, retryAfterMs, family);

  log.warn(`Account ${account.index + 1}/${accountCount} received ${response.status} error on all endpoints`, {
    fromAccountIndex: account.index,
    fromAccountEmail: account.email,
    accountCount,
    status: response.status,
    retryAfterMs,
    reason: "server-error",
  });

  if (accountCount > 1) {
    await client.tui.showToast({
      body: {
        message: `Server error on ${account.email || `Account ${account.index + 1}`}. Switching...`,
        variant: "warning",
      },
    });
  }

  try {
    await accountManager.save();
  } catch (error) {
    log.warn("Failed to save rate limit state", {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return { type: "rate-limit", retryAfterMs, errorType: "server-error" };
}

/**
 * Handle 401 Unauthorized errors - authentication has expired or is invalid.
 * This triggers an immediate account switch to try another account's credentials.
 * Based on Antigravity-Manager's automatic rotation on auth failures.
 */
async function handleAuthError(
  response: Response,
  account: ReturnType<AccountManager["getCurrentOrNextForFamily"]> & {},
  accountManager: AccountManager,
  accountCount: number,
  client: PluginContext["client"],
  family: ModelFamily,
): Promise<EndpointLoopResult> {
  const retryAfterMs = computeErrorBackoffMs("auth-expired", 1);

  // Mark account as rate-limited briefly to force switch
  accountManager.markRateLimited(account, retryAfterMs, family);

  // Also invalidate access token to force refresh on next attempt
  account.access = undefined;
  account.expires = undefined;

  log.warn(`Account ${account.index + 1}/${accountCount} received 401 auth error`, {
    fromAccountIndex: account.index,
    fromAccountEmail: account.email,
    accountCount,
    status: response.status,
    retryAfterMs,
    reason: "auth-expired",
  });

  if (accountCount > 1) {
    try {
      await client.tui.showToast({
        body: {
          message: `Auth expired on ${account.email || `Account ${account.index + 1}`}. Switching...`,
          variant: "warning",
        },
      });
    } catch {}
  } else {
    try {
      await client.tui.showToast({
        body: {
          message: `Auth expired. Refreshing token...`,
          variant: "warning",
        },
      });
    } catch {}
  }

  try {
    await accountManager.save();
  } catch (error) {
    log.warn("Failed to save account state after auth error", {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return { type: "auth-error", retryAfterMs, errorType: "auth-expired" };
}

/**
 * Handle 403 Forbidden errors - account may be blocked or quota exhausted.
 * This forces bypass of session locks and switches to next available account.
 * Based on Antigravity-Manager's forced bypass pattern.
 */
async function handleForbiddenError(
  response: Response,
  account: ReturnType<AccountManager["getCurrentOrNextForFamily"]> & {},
  accountManager: AccountManager,
  accountCount: number,
  client: PluginContext["client"],
  family: ModelFamily,
): Promise<EndpointLoopResult> {
  // Check if this is a quota-related 403 by parsing the body
  let isQuotaError = false;
  try {
    const text = await response.clone().text();
    isQuotaError = text.toLowerCase().includes("quota") || text.toLowerCase().includes("limit");
  } catch {}

  // For quota errors, use longer backoff; for other 403s, use shorter
  const retryAfterMs = isQuotaError
    ? computeErrorBackoffMs("rate-limit", 1)
    : computeErrorBackoffMs("forbidden", 1);

  // Mark all model families as rate-limited for this account (global sync pattern)
  // This implements "one endpoint throttled, all endpoints avoid" from Antigravity-Manager
  if (isQuotaError) {
    accountManager.markGlobalRateLimited(account, retryAfterMs);
    accountManager.recordRateLimit(account);
  } else {
    accountManager.markRateLimited(account, retryAfterMs, family);
  }

  log.warn(`Account ${account.index + 1}/${accountCount} received 403 forbidden error`, {
    fromAccountIndex: account.index,
    fromAccountEmail: account.email,
    accountCount,
    status: response.status,
    retryAfterMs,
    isQuotaError,
    reason: "forbidden",
    globalSync: isQuotaError,
  });

  if (accountCount > 1) {
    try {
      await client.tui.showToast({
        body: {
          message: `Forbidden on ${account.email || `Account ${account.index + 1}`}${isQuotaError ? " (quota)" : ""}. Switching...`,
          variant: "warning",
        },
      });
    } catch {}
  } else {
    try {
      await client.tui.showToast({
        body: {
          message: `Access forbidden${isQuotaError ? " (quota exhausted)" : ""}. Retrying in ${formatWaitTimeMs(retryAfterMs)}...`,
          variant: "error",
        },
      });
    } catch {}
  }

  try {
    await accountManager.save();
  } catch (error) {
    log.warn("Failed to save account state after forbidden error", {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return { type: "forbidden-error", retryAfterMs, errorType: "forbidden" };
}

async function tryEndpointFallbacks(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  accessToken: string,
  projectContext: ProjectContextResult,
  account: ReturnType<AccountManager["getCurrentOrNextForFamily"]> & {},
  accountManager: AccountManager,
  accountCount: number,
  client: PluginContext["client"],
  abortSignal: AbortSignal | undefined,
  getRateLimitDelay: (accountIndex: number, serverRetryAfterMs: number | null) => RateLimitDelay,
  family: ModelFamily,
): Promise<EndpointLoopResult> {
  let lastError: Error | null = null;
  let lastResponse: Response | null = null;
  let lastAttemptInfo: AttemptInfo | null = null;

  const normalizedInput: RequestInfo = input instanceof URL ? input.toString() : input;

  for (let i = 0; i < CODE_ASSIST_ENDPOINT_FALLBACKS.length; i++) {
    const currentEndpoint = CODE_ASSIST_ENDPOINT_FALLBACKS[i];
    if (!currentEndpoint) continue;

    try {
      const { request, init: transformedInit, streaming, requestedModel } = await prepareAntigravityRequest(
        normalizedInput,
        init,
        accessToken,
        projectContext.effectiveProjectId,
      );

      const finalUrl = overrideEndpointForRequest(request, currentEndpoint);

      const originalUrl = toUrlStr(input);
      const resolvedUrl = toUrlStr(finalUrl);
      lastAttemptInfo = {
        resolvedUrl,
        method: transformedInit.method,
        headers: transformedInit.headers,
        body: transformedInit.body,
        streaming,
        requestedModel,
      };

      const debugContext = startAntigravityDebugRequest({
        originalUrl,
        resolvedUrl,
        method: transformedInit.method,
        headers: transformedInit.headers,
        body: transformedInit.body,
        streaming,
        projectId: projectContext.effectiveProjectId,
        sessionId: getSessionId(),
      });

      const response = await fetch(finalUrl, transformedInit);

      if (response.status === 429) {
        return handleRateLimit(
          response,
          account,
          accountManager,
          accountCount,
          streaming,
          client,
          debugContext,
          requestedModel,
          abortSignal,
          getRateLimitDelay,
          family,
        );
      }

      // Handle 401 Unauthorized - auth expired, force token refresh or account switch
      if (response.status === 401) {
        // Don't retry other endpoints for auth errors - switch account immediately
        return handleAuthError(response, account, accountManager, accountCount, client, family);
      }

      // Handle 403 Forbidden after trying all endpoints
      if (response.status === 403 && i === CODE_ASSIST_ENDPOINT_FALLBACKS.length - 1) {
        return handleForbiddenError(response, account, accountManager, accountCount, client, family);
      }

      if (response.status >= 500 && i === CODE_ASSIST_ENDPOINT_FALLBACKS.length - 1) {
        return handleServerError(response, account, accountManager, accountCount, client, family);
      }

      const shouldRetryEndpoint = response.status === 403 || response.status === 404 || response.status >= 500;

      if (shouldRetryEndpoint && i < CODE_ASSIST_ENDPOINT_FALLBACKS.length - 1) {
        lastResponse = response;
        continue;
      }

      return { type: "success", response, attemptInfo: lastAttemptInfo };
    } catch (error) {
      if (i < CODE_ASSIST_ENDPOINT_FALLBACKS.length - 1) {
        lastError = error instanceof Error ? error : new Error(String(error));
        continue;
      }
      throw error;
    }
  }

  if (lastResponse) {
    return { type: "all-failed", response: lastResponse, attemptInfo: lastAttemptInfo ?? undefined };
  }

  return { type: "all-failed", error: lastError ?? new Error("All endpoints failed") };
}

export function createAntigravityFetch(
  getAuth: GetAuth,
  client: PluginContext["client"],
): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
  const rateLimitStateByAccount = new Map<number, { consecutive429: number; lastAt: number }>();

  const getRateLimitDelay = (accountIndex: number, serverRetryAfterMs: number | null): RateLimitDelay => {
    const now = Date.now();
    const previous = rateLimitStateByAccount.get(accountIndex);
    const attempt = (previous?.consecutive429 ?? 0) + 1;
    const backoffMs = computeExponentialBackoffMs(attempt);
    const delayMs = serverRetryAfterMs !== null ? Math.max(serverRetryAfterMs, backoffMs) : backoffMs;

    rateLimitStateByAccount.set(accountIndex, { consecutive429: attempt, lastAt: now });

    return { attempt, serverRetryAfterMs, delayMs };
  };

  const resetRateLimitState = (accountIndex: number): void => {
    rateLimitStateByAccount.delete(accountIndex);
  };

  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const normalizedInput: RequestInfo = input instanceof URL ? input.toString() : input;

    if (!isGenerativeLanguageRequest(normalizedInput)) {
      return fetch(input, init);
    }

    const latestAuth = await getAuth();
    if (!isOAuthAuth(latestAuth)) {
      return fetch(input, init);
    }

    const urlString = toUrlStr(normalizedInput);
    const family = getModelFamilyFromUrl(urlString);

    const storedAccounts = await loadAccounts();
    const accountManager = new AccountManager(latestAuth, storedAccounts);
    const accountCount = accountManager.getAccountCount();

    const resolveProjectContext = async (authRecord: typeof latestAuth): Promise<ProjectContextResult> => {
      return ensureProjectContext(authRecord, client);
    };

    const abortSignal = init?.signal ?? undefined;

    while (true) {
      const previousAccount = accountManager.getCurrentAccount();
      const account = accountManager.getCurrentOrNextForFamily(family);

      if (!account) {
        const waitTimeMs = accountManager.getMinWaitTimeForFamily(family) || 60000;
        const waitTimeSec = Math.ceil(waitTimeMs / 1000);
        const waitTimeHuman = formatWaitTimeMs(waitTimeMs);

        log.info(`All ${accountCount} account(s) are rate-limited for ${family}, waiting...`, {
          accountCount,
          waitTimeSec,
          waitTimeHuman,
          family,
        });

        printAntigravityConsole(
          "error",
          `All ${accountCount} account(s) are rate-limited for ${family}. Retrying after ${waitTimeHuman}...`,
        );

        try {
          await client.tui.showToast({
            body: {
              message: `Antigravity Rate Limited (${family}). Retrying after ${waitTimeHuman}...`,
              variant: "warning",
            },
          });
        } catch {}

        await sleepWithBackoff(waitTimeMs, abortSignal);
        continue;
      }

      const isSwitch = !previousAccount || previousAccount.index !== account.index;

      if (isSwitch) {
        const wasRateLimited = previousAccount
          ? (previousAccount.rateLimitResetTimes[family] ?? 0) > Date.now()
          : false;
        const switchReason = previousAccount ? (wasRateLimited ? "rate-limit" : "rotation") : "initial";
        accountManager.markSwitched(account, switchReason);

        log.info(
          `Using account ${account.index + 1}/${accountCount}${account.email ? ` (${account.email})` : ""} for ${family}`,
          {
            accountIndex: account.index,
            accountEmail: account.email,
            accountCount,
            reason: switchReason,
            family,
          },
        );

        try {
          await accountManager.save();
        } catch (error) {
          log.warn("Failed to save account switch state", {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      let authRecord = accountManager.accountToAuth(account);

      if (accessTokenExpired(authRecord)) {
        const refreshed = await refreshAccessToken(authRecord, client);
        if (!refreshed) continue;
        authRecord = refreshed;
        const parts = parseRefreshParts(refreshed.refresh);
        accountManager.updateAccount(account, refreshed.access!, refreshed.expires!, parts);

        try {
          await accountManager.save();
        } catch (error) {
          log.warn("Failed to save account state after token refresh", {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      const accessToken = authRecord.access;
      if (!accessToken) continue;

      const projectContext = await resolveProjectContext(authRecord);

      const result = await tryEndpointFallbacks(
        input,
        init,
        accessToken,
        projectContext,
        account,
        accountManager,
        accountCount,
        client,
        abortSignal,
        getRateLimitDelay,
        family,
      );

      if (result.type === "retry-soon") {
        continue;
      }

      if (result.type === "rate-limit") {
        if (accountCount === 1) {
          const waitMs = result.retryAfterMs || accountManager.getMinWaitTimeForFamily(family) || 1000;
          log.info("Single account rate-limited, retrying after backoff", { waitMs, waitSec: Math.ceil(waitMs / 1000), family });
          await sleepWithBackoff(waitMs, abortSignal);
        }
        continue;
      }

      // Handle auth errors - retry immediately with fresh token or different account
      if (result.type === "auth-error") {
        if (accountCount === 1) {
          // For single account, brief delay then retry (token will be refreshed)
          const waitMs = result.retryAfterMs || computeErrorBackoffMs("auth-expired", 1);
          log.info("Single account auth error, refreshing token and retrying", { waitMs, family });
          await sleep(waitMs, abortSignal);
        }
        // For multi-account, just continue to switch account immediately
        continue;
      }

      // Handle forbidden errors - switch account or wait
      if (result.type === "forbidden-error") {
        if (accountCount === 1) {
          const waitMs = result.retryAfterMs || computeErrorBackoffMs("forbidden", 1);
          log.info("Single account forbidden error, waiting before retry", { waitMs, family });
          await sleepWithBackoff(waitMs, abortSignal);
        }
        continue;
      }

      if (result.type === "success" && result.response) {
        resetRateLimitState(account.index);

        // Record successful request for quota tracking
        accountManager.recordSuccess(account, family);

        try {
          await client.auth.set({
            path: { id: ANTIGRAVITY_PROVIDER_ID },
            body: accountManager.toAuthDetails(),
          });
          await accountManager.save();
        } catch (saveError) {
          log.error("Failed to save updated auth", {
            error: saveError instanceof Error ? saveError.message : String(saveError),
          });
          await client.tui.showToast({
            body: { message: "Failed to save updated auth", variant: "error" },
          });
        }

        const { streaming, requestedModel } = result.attemptInfo ?? { streaming: false, requestedModel: undefined };
        const debugContext = startAntigravityDebugRequest({
          originalUrl: toUrlStr(input),
          resolvedUrl: result.attemptInfo?.resolvedUrl ?? toUrlStr(input),
          method: result.attemptInfo?.method,
          headers: result.attemptInfo?.headers,
          body: result.attemptInfo?.body,
          streaming,
          projectId: projectContext.effectiveProjectId,
          sessionId: getSessionId(),
        });

        return transformAntigravityResponse(result.response, streaming, client, debugContext, requestedModel, getSessionId());
      }

      if (result.type === "all-failed") {
        if (result.response && result.attemptInfo) {
          const debugContext = startAntigravityDebugRequest({
            originalUrl: toUrlStr(input),
            resolvedUrl: result.attemptInfo.resolvedUrl,
            method: result.attemptInfo.method,
            headers: result.attemptInfo.headers,
            body: result.attemptInfo.body,
            streaming: result.attemptInfo.streaming,
            projectId: projectContext.effectiveProjectId,
            sessionId: getSessionId(),
          });

          return transformAntigravityResponse(
            result.response,
            result.attemptInfo.streaming,
            client,
            debugContext,
            result.attemptInfo.requestedModel,
            getSessionId(),
          );
        }

        throw result.error || new Error("All Antigravity endpoints failed");
      }
    }
  };
}
