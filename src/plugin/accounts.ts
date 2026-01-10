import type { OAuthAuthDetails, RefreshParts } from "./types";
import {
  parseMultiAccountRefresh,
  formatMultiAccountRefresh,
  parseRefreshParts,
  formatRefreshParts,
} from "./auth";
import {
  saveAccounts,
  computeHealthScore,
  computeEscalatingBackoffMs,
  type AccountStorage,
  type RateLimitState,
  type ModelFamily,
  type AccountTier,
  type AccountHealthMetrics,
  type FailureReason,
} from "./storage";

export type { ModelFamily, AccountTier, FailureReason } from "./storage";

export interface ManagedAccount {
  index: number;
  parts: RefreshParts;
  access?: string;
  expires?: number;
  rateLimitResetTimes: RateLimitState;
  addedAt: number;
  lastUsed: number;
  email?: string;
  tier?: AccountTier;
  lastSwitchReason?: "rate-limit" | "initial" | "rotation";
  // V4: Health metrics for intelligent account selection
  health: AccountHealthMetrics;
}

function isRateLimitedForFamily(account: ManagedAccount, family: ModelFamily): boolean {
  const resetTime = account.rateLimitResetTimes[family];
  return resetTime !== undefined && Date.now() < resetTime;
}

function getDefaultHealthMetrics(): AccountHealthMetrics {
  return {
    successCount: 0,
    failureCount: 0,
    consecutiveFailures: 0,
  };
}

/**
 * Gets the account's computed health score (0-100).
 */
function getAccountHealthScore(account: ManagedAccount): number {
  return computeHealthScore(account.health);
}

function clearExpiredRateLimits(account: ManagedAccount): void {
  const now = Date.now();
  if (account.rateLimitResetTimes.claude !== undefined && now >= account.rateLimitResetTimes.claude) {
    delete account.rateLimitResetTimes.claude;
  }
  if (account.rateLimitResetTimes["gemini-flash"] !== undefined && now >= account.rateLimitResetTimes["gemini-flash"]) {
    delete account.rateLimitResetTimes["gemini-flash"];
  }
  if (account.rateLimitResetTimes["gemini-pro"] !== undefined && now >= account.rateLimitResetTimes["gemini-pro"]) {
    delete account.rateLimitResetTimes["gemini-pro"];
  }
}

/**
 * Manages multiple OAuth accounts with automatic rotation and rate limit handling.
 */
export class AccountManager {
  private accounts: ManagedAccount[] = [];
  private currentIndex = 0;
  private currentAccountIndex = -1;
  private storageDirty = false;
  private authDirty = false;

  constructor(auth: OAuthAuthDetails, storedAccounts?: AccountStorage | null) {
    if (storedAccounts && storedAccounts.accounts.length > 0) {
      const activeIndex =
        typeof storedAccounts.activeIndex === "number" &&
        storedAccounts.activeIndex >= 0 &&
        storedAccounts.activeIndex < storedAccounts.accounts.length
          ? storedAccounts.activeIndex
          : 0;

      this.currentAccountIndex = activeIndex;
      this.currentIndex = activeIndex;

      this.accounts = storedAccounts.accounts.map((acc, index) => ({
        index,
        parts: {
          refreshToken: acc.refreshToken,
          projectId: acc.projectId,
          managedProjectId: acc.managedProjectId,
        },
        access: index === activeIndex ? auth.access : undefined,
        expires: index === activeIndex ? auth.expires : undefined,
        rateLimitResetTimes: acc.rateLimitResetTimes ?? {},
        addedAt: acc.addedAt,
        lastUsed: acc.lastUsed,
        email: acc.email,
        tier: acc.tier,
        lastSwitchReason: acc.lastSwitchReason,
        health: acc.health ?? getDefaultHealthMetrics(),
      }));
    } else {
      const multiAccount = parseMultiAccountRefresh(auth.refresh);

      this.currentAccountIndex = 0;
      this.currentIndex = 0;

      if (multiAccount.accounts.length > 0) {
        const now = Date.now();
        this.accounts = multiAccount.accounts.map((parts, index) => ({
          index,
          parts,
          access: index === 0 ? auth.access : undefined,
          expires: index === 0 ? auth.expires : undefined,
          rateLimitResetTimes: {},
          addedAt: now,
          lastUsed: 0,
          health: getDefaultHealthMetrics(),
        }));
      } else {
        this.accounts.push({
          index: 0,
          parts: parseRefreshParts(auth.refresh),
          access: auth.access,
          expires: auth.expires,
          rateLimitResetTimes: {},
          addedAt: Date.now(),
          lastUsed: 0,
          health: getDefaultHealthMetrics(),
        });
      }
    }
  }

  async save(): Promise<void> {
    const storage: AccountStorage = {
      version: 4,
      accounts: this.accounts.map((acc) => ({
        email: acc.email,
        tier: acc.tier,
        refreshToken: acc.parts.refreshToken,
        projectId: acc.parts.projectId,
        managedProjectId: acc.parts.managedProjectId,
        addedAt: acc.addedAt,
        lastUsed: acc.lastUsed,
        lastSwitchReason: acc.lastSwitchReason,
        rateLimitResetTimes: acc.rateLimitResetTimes,
        health: acc.health,
      })),
      activeIndex: Math.max(0, this.currentAccountIndex),
    };

    await saveAccounts(storage);
    this.storageDirty = false;
  }

  isStorageDirty(): boolean {
    return this.storageDirty;
  }

  isAuthDirty(): boolean {
    return this.authDirty;
  }

  markAuthSaved(): void {
    this.authDirty = false;
  }

  getCurrentAccount(): ManagedAccount | null {
    if (this.currentAccountIndex >= 0 && this.currentAccountIndex < this.accounts.length) {
      return this.accounts[this.currentAccountIndex] ?? null;
    }
    return null;
  }

  markSwitched(account: ManagedAccount, reason: "rate-limit" | "initial" | "rotation"): void {
    account.lastSwitchReason = reason;
    this.currentAccountIndex = account.index;
    this.storageDirty = true;
    this.authDirty = true;
  }

  getAccountCount(): number {
    return this.accounts.length;
  }

  getCurrentOrNextForFamily(family: ModelFamily): ManagedAccount | null {
    this.accounts.forEach(clearExpiredRateLimits);

    const current = this.getCurrentAccount();
    if (current) {
      if (!isRateLimitedForFamily(current, family)) {
        const currentHealthScore = getAccountHealthScore(current);

        // Check if there's a better account available (paid tier or higher health score)
        const betterAccountAvailable = this.accounts.some((a) => {
          if (a.index === current.index) return false;
          if (isRateLimitedForFamily(a, family)) return false;

          // Paid accounts always have priority over free accounts
          if (a.tier === "paid" && current.tier !== "paid") return true;

          // If same tier, prefer significantly healthier accounts (>20 score difference)
          const otherHealthScore = getAccountHealthScore(a);
          return otherHealthScore - currentHealthScore > 20;
        });

        if (!betterAccountAvailable) {
          current.lastUsed = Date.now();
          return current;
        }
      }
    }

    const next = this.getNextForFamily(family);
    if (next) {
      this.currentAccountIndex = next.index;
    }
    return next;
  }

  /**
   * Gets the best available account for a model family using intelligent selection.
   * Prioritization order:
   * 1. Paid accounts over free accounts
   * 2. Higher health score (based on success/failure history)
   * 3. Fewer consecutive failures
   */
  getNextForFamily(family: ModelFamily): ManagedAccount | null {
    const available = this.accounts.filter((a) => !isRateLimitedForFamily(a, family));

    if (available.length === 0) {
      return null;
    }

    // Sort by: 1) Paid tier first, 2) Health score (descending), 3) Consecutive failures (ascending)
    const sorted = [...available].sort((a, b) => {
      // Paid accounts first
      if (a.tier === "paid" && b.tier !== "paid") return -1;
      if (b.tier === "paid" && a.tier !== "paid") return 1;

      // Then by health score (higher is better)
      const healthA = getAccountHealthScore(a);
      const healthB = getAccountHealthScore(b);
      if (healthA !== healthB) return healthB - healthA;

      // Finally by consecutive failures (fewer is better)
      return a.health.consecutiveFailures - b.health.consecutiveFailures;
    });

    const account = sorted[0];
    if (!account) {
      return null;
    }

    this.currentIndex++;
    account.lastUsed = Date.now();
    return account;
  }

  /**
   * Gets the recommended account based on health score, tier, and rate limit status.
   * Returns the best account along with its health score.
   */
  getRecommendedAccount(family: ModelFamily): { account: ManagedAccount; healthScore: number } | null {
    this.accounts.forEach(clearExpiredRateLimits);

    const available = this.accounts.filter((a) => !isRateLimitedForFamily(a, family));
    if (available.length === 0) {
      return null;
    }

    const scored = available.map((a) => ({
      account: a,
      healthScore: getAccountHealthScore(a),
    }));

    // Sort by paid tier first, then by health score
    scored.sort((a, b) => {
      if (a.account.tier === "paid" && b.account.tier !== "paid") return -1;
      if (b.account.tier === "paid" && a.account.tier !== "paid") return 1;
      return b.healthScore - a.healthScore;
    });

    return scored[0] ?? null;
  }

  markRateLimited(account: ManagedAccount, retryAfterMs: number, family: ModelFamily): void {
    account.rateLimitResetTimes[family] = Date.now() + retryAfterMs;

    // Update health metrics for rate limiting
    this.recordFailure(account, "rate-limit", family);
  }

  /**
   * Records a successful request for an account.
   * Resets consecutive failures and updates success count.
   */
  recordSuccess(account: ManagedAccount, family?: ModelFamily): void {
    account.health.successCount++;
    account.health.consecutiveFailures = 0;
    account.health.lastSuccessAt = Date.now();

    // Reset family-specific consecutive failures
    if (family && account.health.familyConsecutiveFailures) {
      delete account.health.familyConsecutiveFailures[family];
    }

    this.storageDirty = true;
  }

  /**
   * Records a failure for an account.
   * Increments failure count and consecutive failures.
   */
  recordFailure(account: ManagedAccount, reason: FailureReason, family?: ModelFamily): void {
    account.health.failureCount++;
    account.health.consecutiveFailures++;
    account.health.lastFailureAt = Date.now();
    account.health.lastFailureReason = reason;

    // Track per-family consecutive failures for escalating backoff
    if (family) {
      if (!account.health.familyConsecutiveFailures) {
        account.health.familyConsecutiveFailures = {};
      }
      account.health.familyConsecutiveFailures[family] =
        (account.health.familyConsecutiveFailures[family] ?? 0) + 1;
    }

    this.storageDirty = true;
  }

  /**
   * Gets the escalating backoff duration based on consecutive failures for a family.
   * Uses Antigravity-Manager style escalation: 60s → 2m → 5m → 15m → 30m → 1h → 2h (max)
   */
  getEscalatingBackoffMs(account: ManagedAccount, family: ModelFamily): number {
    const familyFailures = account.health.familyConsecutiveFailures?.[family] ?? 0;
    const overallFailures = account.health.consecutiveFailures;

    // Use the higher of family-specific or overall consecutive failures
    const consecutiveFailures = Math.max(familyFailures, overallFailures);

    return computeEscalatingBackoffMs(consecutiveFailures);
  }

  /**
   * Gets the health score for an account (0-100).
   */
  getHealthScore(account: ManagedAccount): number {
    return getAccountHealthScore(account);
  }

  /**
   * Resets health metrics for an account (useful after successful re-authentication).
   */
  resetHealth(account: ManagedAccount): void {
    account.health = getDefaultHealthMetrics();
    this.storageDirty = true;
  }

  updateAccount(account: ManagedAccount, access: string, expires: number, parts?: RefreshParts): void {
    account.access = access;
    account.expires = expires;
    if (account.index === this.currentAccountIndex) {
      this.authDirty = true;
    }
    this.storageDirty = true;
    if (parts) {
      account.parts = parts;
      this.authDirty = true;
    }
  }

  toAuthDetails(): OAuthAuthDetails {
    const current = this.getCurrentAccount() || this.accounts[0];
    if (!current) {
      throw new Error("No accounts available");
    }

    return {
      type: "oauth",
      refresh: formatMultiAccountRefresh({ accounts: this.accounts.map((acc) => acc.parts) }),
      access: current.access || "",
      expires: current.expires || 0,
    };
  }

  addAccount(parts: RefreshParts, access?: string, expires?: number, email?: string, tier?: AccountTier): void {
    this.accounts.push({
      index: this.accounts.length,
      parts,
      access,
      expires,
      rateLimitResetTimes: {},
      addedAt: Date.now(),
      lastUsed: 0,
      email,
      tier,
      health: getDefaultHealthMetrics(),
    });
    this.storageDirty = true;
    this.authDirty = true;
  }

  removeAccount(index: number): boolean {
    if (index < 0 || index >= this.accounts.length) {
      return false;
    }
    this.accounts.splice(index, 1);
    this.accounts.forEach((acc, idx) => (acc.index = idx));
    if (this.currentAccountIndex >= this.accounts.length) {
      this.currentAccountIndex = this.accounts.length - 1;
    }
    this.storageDirty = true;
    this.authDirty = true;
    return true;
  }

  getAccounts(): ManagedAccount[] {
    return [...this.accounts];
  }

  accountToAuth(account: ManagedAccount): OAuthAuthDetails {
    return {
      type: "oauth",
      refresh: formatRefreshParts(account.parts),
      access: account.access ?? "",
      expires: account.expires ?? 0,
    };
  }

  getMinWaitTimeForFamily(family: ModelFamily): number {
    const available = this.accounts.filter((a) => {
      clearExpiredRateLimits(a);
      return !isRateLimitedForFamily(a, family);
    });
    if (available.length > 0) {
      return 0;
    }

    const waitTimes = this.accounts
      .map((a) => a.rateLimitResetTimes[family])
      .filter((t): t is number => t !== undefined)
      .map((t) => Math.max(0, t - Date.now()));

    return waitTimes.length > 0 ? Math.min(...waitTimes) : 0;
  }
}
