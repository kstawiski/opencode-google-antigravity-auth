import { promises as fs } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { createLogger } from "./logger";

const log = createLogger("storage");

export type ModelFamily = "claude" | "gemini-flash" | "gemini-pro";
export type AccountTier = "free" | "paid";
export type FailureReason = "rate-limit" | "auth-error" | "server-error" | "network-error" | "unknown";

const ACCOUNTS_CACHE_TTL_MS = (() => {
  const raw = process.env.ANTIGRAVITY_ACCOUNTS_CACHE_TTL_MS;
  if (!raw) return 1000;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 1000;
})();

let accountsCache: { value: AccountStorage | null; loadedAt: number } | null = null;
let accountsLoadPending: Promise<AccountStorage | null> | null = null;

export function resetAccountsCache(): void {
  accountsCache = null;
  accountsLoadPending = null;
}

export interface RateLimitState {
  claude?: number;
  "gemini-flash"?: number;
  "gemini-pro"?: number;
}

// V1: Original format with single isRateLimited flag
export interface AccountMetadataV1 {
  email?: string;
  refreshToken: string;
  projectId?: string;
  managedProjectId?: string;
  addedAt: number;
  lastUsed: number;
  lastSwitchReason?: "rate-limit" | "initial" | "rotation";
  isRateLimited?: boolean;
  rateLimitResetTime?: number;
}

export interface AccountStorageV1 {
  version: 1;
  accounts: AccountMetadataV1[];
  activeIndex: number;
}

// V2: Added per-model rate limits with single "gemini" key
export interface RateLimitStateV2 {
  claude?: number;
  gemini?: number;
}

export interface AccountMetadataV2 {
  email?: string;
  refreshToken: string;
  projectId?: string;
  managedProjectId?: string;
  addedAt: number;
  lastUsed: number;
  lastSwitchReason?: "rate-limit" | "initial" | "rotation";
  rateLimitResetTimes?: RateLimitStateV2;
}

export interface AccountStorageV2 {
  version: 2;
  accounts: AccountMetadataV2[];
  activeIndex: number;
}

// V3: Split gemini into gemini-flash and gemini-pro, added tier
export interface AccountMetadataV3 {
  email?: string;
  tier?: AccountTier;
  refreshToken: string;
  projectId?: string;
  managedProjectId?: string;
  addedAt: number;
  lastUsed: number;
  lastSwitchReason?: "rate-limit" | "initial" | "rotation";
  rateLimitResetTimes?: RateLimitState;
}

export interface AccountStorageV3 {
  version: 3;
  accounts: AccountMetadataV3[];
  activeIndex: number;
}

// V4: Added health metrics for intelligent account selection
export interface AccountHealthMetrics {
  successCount: number;
  failureCount: number;
  consecutiveFailures: number;
  lastFailureAt?: number;
  lastFailureReason?: FailureReason;
  lastSuccessAt?: number;
  // Per-family consecutive failures for escalating backoff
  familyConsecutiveFailures?: {
    claude?: number;
    "gemini-flash"?: number;
    "gemini-pro"?: number;
  };
}

export interface AccountMetadata {
  email?: string;
  tier?: AccountTier;
  refreshToken: string;
  projectId?: string;
  managedProjectId?: string;
  addedAt: number;
  lastUsed: number;
  lastSwitchReason?: "rate-limit" | "initial" | "rotation";
  rateLimitResetTimes?: RateLimitState;
  // V4 additions
  health?: AccountHealthMetrics;
}

export interface AccountStorage {
  version: 4;
  accounts: AccountMetadata[];
  activeIndex: number;
}

type AnyAccountStorage = AccountStorageV1 | AccountStorageV2 | AccountStorageV3 | AccountStorage;

function getDataDir(): string {
  const platform = process.platform;

  if (platform === "win32") {
    return join(process.env.APPDATA || join(homedir(), "AppData", "Roaming"), "opencode");
  }

  const xdgData = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
  return join(xdgData, "opencode");
}

export function getStoragePath(): string {
  return join(getDataDir(), "antigravity-accounts.json");
}

function migrateV1ToV2(v1: AccountStorageV1): AccountStorageV2 {
  return {
    version: 2,
    accounts: v1.accounts.map((acc) => {
      const rateLimitResetTimes: RateLimitStateV2 = {};
      if (acc.isRateLimited && acc.rateLimitResetTime) {
        rateLimitResetTimes.claude = acc.rateLimitResetTime;
        rateLimitResetTimes.gemini = acc.rateLimitResetTime;
      }
      return {
        email: acc.email,
        refreshToken: acc.refreshToken,
        projectId: acc.projectId,
        managedProjectId: acc.managedProjectId,
        addedAt: acc.addedAt,
        lastUsed: acc.lastUsed,
        lastSwitchReason: acc.lastSwitchReason,
        rateLimitResetTimes: Object.keys(rateLimitResetTimes).length > 0 ? rateLimitResetTimes : undefined,
      };
    }),
    activeIndex: v1.activeIndex,
  };
}

function migrateV2ToV3(v2: AccountStorageV2): AccountStorageV3 {
  return {
    version: 3,
    accounts: v2.accounts.map((acc) => {
      const rateLimitResetTimes: RateLimitState = {};
      if (acc.rateLimitResetTimes) {
        if (acc.rateLimitResetTimes.claude !== undefined) {
          rateLimitResetTimes.claude = acc.rateLimitResetTimes.claude;
        }
        if (acc.rateLimitResetTimes.gemini !== undefined) {
          rateLimitResetTimes["gemini-flash"] = acc.rateLimitResetTimes.gemini;
          rateLimitResetTimes["gemini-pro"] = acc.rateLimitResetTimes.gemini;
        }
      }
      return {
        email: acc.email,
        refreshToken: acc.refreshToken,
        projectId: acc.projectId,
        managedProjectId: acc.managedProjectId,
        addedAt: acc.addedAt,
        lastUsed: acc.lastUsed,
        lastSwitchReason: acc.lastSwitchReason,
        rateLimitResetTimes: Object.keys(rateLimitResetTimes).length > 0 ? rateLimitResetTimes : undefined,
      };
    }),
    activeIndex: v2.activeIndex,
  };
}

function migrateV3ToV4(v3: AccountStorageV3): AccountStorage {
  return {
    version: 4,
    accounts: v3.accounts.map((acc) => ({
      email: acc.email,
      tier: acc.tier,
      refreshToken: acc.refreshToken,
      projectId: acc.projectId,
      managedProjectId: acc.managedProjectId,
      addedAt: acc.addedAt,
      lastUsed: acc.lastUsed,
      lastSwitchReason: acc.lastSwitchReason,
      rateLimitResetTimes: acc.rateLimitResetTimes,
      // Initialize health metrics with defaults
      health: {
        successCount: 0,
        failureCount: 0,
        consecutiveFailures: 0,
      },
    })),
    activeIndex: v3.activeIndex,
  };
}

export async function loadAccounts(): Promise<AccountStorage | null> {
  if (accountsCache && Date.now() - accountsCache.loadedAt < ACCOUNTS_CACHE_TTL_MS) {
    return accountsCache.value;
  }

  if (accountsLoadPending) {
    return accountsLoadPending;
  }

  const loadPromise = (async (): Promise<AccountStorage | null> => {
    try {
      const path = getStoragePath();
      const content = await fs.readFile(path, "utf-8");
      const data = JSON.parse(content) as AnyAccountStorage;

      if (!Array.isArray((data as { accounts?: unknown }).accounts)) {
        log.warn("Invalid storage format, ignoring");
        accountsCache = { value: null, loadedAt: Date.now() };
        return null;
      }

      let storage: AccountStorage;

      if ((data as { version?: unknown }).version === 1) {
        log.info("Migrating account storage from v1 to v4");
        const v2 = migrateV1ToV2(data as AccountStorageV1);
        const v3 = migrateV2ToV3(v2);
        storage = migrateV3ToV4(v3);
        await saveAccounts(storage);
      } else if ((data as { version?: unknown }).version === 2) {
        log.info("Migrating account storage from v2 to v4");
        const v3 = migrateV2ToV3(data as AccountStorageV2);
        storage = migrateV3ToV4(v3);
        await saveAccounts(storage);
      } else if ((data as { version?: unknown }).version === 3) {
        log.info("Migrating account storage from v3 to v4");
        storage = migrateV3ToV4(data as AccountStorageV3);
        await saveAccounts(storage);
      } else if ((data as { version?: unknown }).version === 4) {
        storage = data as AccountStorage;
      } else {
        log.warn("Unknown storage version, ignoring", { version: (data as { version?: unknown }).version });
        accountsCache = { value: null, loadedAt: Date.now() };
        return null;
      }

      if (typeof storage.activeIndex !== "number" || !Number.isInteger(storage.activeIndex)) {
        storage.activeIndex = 0;
      }

      if (storage.activeIndex < 0 || storage.activeIndex >= storage.accounts.length) {
        storage.activeIndex = 0;
      }

      accountsCache = { value: storage, loadedAt: Date.now() };
      return storage;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        accountsCache = { value: null, loadedAt: Date.now() };
        return null;
      }
      log.error("Failed to load account storage", { error: String(error) });
      accountsCache = { value: null, loadedAt: Date.now() };
      return null;
    } finally {
      accountsLoadPending = null;
    }
  })();

  accountsLoadPending = loadPromise;
  return loadPromise;
}

export async function saveAccounts(storage: AccountStorage): Promise<void> {
  try {
    const path = getStoragePath();

    await fs.mkdir(dirname(path), { recursive: true });

    const content = JSON.stringify(storage, null, 2);
    await fs.writeFile(path, content, "utf-8");

    accountsCache = { value: storage, loadedAt: Date.now() };
  } catch (error) {
    log.error("Failed to save account storage", { error: String(error) });
    throw error;
  }
}

export function migrateFromRefreshString(
  accountsData: Array<{ refreshToken: string; projectId?: string; managedProjectId?: string }>,
  emails?: Array<string | undefined>,
): AccountStorage {
  const now = Date.now();

  return {
    version: 4,
    accounts: accountsData.map((acc, index) => ({
      email: emails?.[index],
      refreshToken: acc.refreshToken,
      projectId: acc.projectId,
      managedProjectId: acc.managedProjectId,
      addedAt: now,
      lastUsed: index === 0 ? now : 0,
      health: {
        successCount: 0,
        failureCount: 0,
        consecutiveFailures: 0,
      },
    })),
    activeIndex: 0,
  };
}

/**
 * Computes a health score for an account based on its metrics.
 * Score ranges from 0 (unhealthy) to 100 (healthy).
 *
 * Factors considered:
 * - Success rate (weighted heavily)
 * - Consecutive failures (penalized exponentially)
 * - Recency of last failure (recent failures penalized more)
 */
export function computeHealthScore(health: AccountHealthMetrics | undefined): number {
  if (!health) {
    return 50; // Default neutral score for accounts without health data
  }

  const { successCount, failureCount, consecutiveFailures, lastFailureAt, lastSuccessAt } = health;
  const totalRequests = successCount + failureCount;

  // Start with base score
  let score = 100;

  // Factor 1: Success rate (40% weight)
  if (totalRequests > 0) {
    const successRate = successCount / totalRequests;
    score -= (1 - successRate) * 40;
  }

  // Factor 2: Consecutive failures penalty (exponential, 30% weight)
  // Each consecutive failure reduces score more severely
  if (consecutiveFailures > 0) {
    const consecutivePenalty = Math.min(30, consecutiveFailures * 5 * Math.pow(1.5, consecutiveFailures - 1));
    score -= consecutivePenalty;
  }

  // Factor 3: Recency of failure (20% weight)
  // Failures in the last 5 minutes are penalized more
  if (lastFailureAt) {
    const timeSinceFailure = Date.now() - lastFailureAt;
    const fiveMinutes = 5 * 60 * 1000;
    const oneHour = 60 * 60 * 1000;

    if (timeSinceFailure < fiveMinutes) {
      score -= 20; // Recent failure
    } else if (timeSinceFailure < oneHour) {
      score -= 10; // Somewhat recent failure
    }
  }

  // Factor 4: Recent success bonus (10% weight)
  if (lastSuccessAt) {
    const timeSinceSuccess = Date.now() - lastSuccessAt;
    const fiveMinutes = 5 * 60 * 1000;

    if (timeSinceSuccess < fiveMinutes) {
      score += 10; // Recent success is a good sign
    }
  }

  return Math.max(0, Math.min(100, score));
}

/**
 * Computes the escalating backoff duration based on consecutive failures.
 * Uses Antigravity-Manager style escalation: 60s → 2m → 5m → 15m → 30m → 1h → 2h (max)
 */
export function computeEscalatingBackoffMs(consecutiveFailures: number): number {
  const BACKOFF_STEPS = [
    60 * 1000,       // 60s
    2 * 60 * 1000,   // 2m
    5 * 60 * 1000,   // 5m
    15 * 60 * 1000,  // 15m
    30 * 60 * 1000,  // 30m
    60 * 60 * 1000,  // 1h
    2 * 60 * 60 * 1000, // 2h (max)
  ];

  const index = Math.min(Math.max(0, consecutiveFailures - 1), BACKOFF_STEPS.length - 1);
  return BACKOFF_STEPS[index] ?? BACKOFF_STEPS[BACKOFF_STEPS.length - 1]!;
}
