import type { OAuthAuthDetails, RefreshParts } from "./types";
import {
  parseMultiAccountRefresh,
  formatMultiAccountRefresh,
  parseRefreshParts,
  formatRefreshParts,
} from "./auth";
import { saveAccounts, type AccountStorage, type RateLimitState, type ModelFamily, type AccountTier, type QuotaUsage, QUOTA_RESET_INTERVAL_MS } from "./storage";

export type { ModelFamily, AccountTier, QuotaUsage } from "./storage";

export interface ManagedAccount {
  index: number;
  parts: RefreshParts;
  access?: string;
  expires?: number;
  rateLimitResetTimes: RateLimitState;
  lastUsed: number;
  email?: string;
  tier?: AccountTier;
  lastSwitchReason?: "rate-limit" | "initial" | "rotation";
  /** Quota usage tracking for smart account recommendation */
  quotaUsage: QuotaUsage;
  /** Count of consecutive successful requests (resets on error) */
  consecutiveSuccesses: number;
  /** Count of total rate limits encountered */
  totalRateLimits: number;
}

function isRateLimitedForFamily(account: ManagedAccount, family: ModelFamily): boolean {
  const resetTime = account.rateLimitResetTimes[family];
  return resetTime !== undefined && Date.now() < resetTime;
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
        lastUsed: acc.lastUsed,
        email: acc.email,
        tier: acc.tier,
        lastSwitchReason: acc.lastSwitchReason,
        quotaUsage: acc.quotaUsage ?? {},
        consecutiveSuccesses: acc.consecutiveSuccesses ?? 0,
        totalRateLimits: acc.totalRateLimits ?? 0,
      }));
    } else {
      const multiAccount = parseMultiAccountRefresh(auth.refresh);

      this.currentAccountIndex = 0;
      this.currentIndex = 0;

      if (multiAccount.accounts.length > 0) {
        this.accounts = multiAccount.accounts.map((parts, index) => ({
          index,
          parts,
          access: index === 0 ? auth.access : undefined,
          expires: index === 0 ? auth.expires : undefined,
          rateLimitResetTimes: {},
          lastUsed: 0,
          quotaUsage: {},
          consecutiveSuccesses: 0,
          totalRateLimits: 0,
        }));
      } else {
        this.accounts.push({
          index: 0,
          parts: parseRefreshParts(auth.refresh),
          access: auth.access,
          expires: auth.expires,
          rateLimitResetTimes: {},
          lastUsed: 0,
          quotaUsage: {},
          consecutiveSuccesses: 0,
          totalRateLimits: 0,
        });
      }
    }
  }

  async save(): Promise<void> {
    const storage: AccountStorage = {
      version: 3,
      accounts: this.accounts.map((acc) => ({
        email: acc.email,
        tier: acc.tier,
        refreshToken: acc.parts.refreshToken,
        projectId: acc.parts.projectId,
        managedProjectId: acc.parts.managedProjectId,
        addedAt: acc.lastUsed || Date.now(),
        lastUsed: acc.lastUsed,
        lastSwitchReason: acc.lastSwitchReason,
        rateLimitResetTimes: acc.rateLimitResetTimes,
        quotaUsage: acc.quotaUsage,
        consecutiveSuccesses: acc.consecutiveSuccesses,
        totalRateLimits: acc.totalRateLimits,
      })),
      activeIndex: Math.max(0, this.currentAccountIndex),
    };

    await saveAccounts(storage);
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
  }

  getAccountCount(): number {
    return this.accounts.length;
  }

  getCurrentOrNextForFamily(family: ModelFamily): ManagedAccount | null {
    this.accounts.forEach(clearExpiredRateLimits);

    const current = this.getCurrentAccount();
    if (current) {
      if (!isRateLimitedForFamily(current, family)) {
        const betterTierAvailable =
          current.tier !== "paid" &&
          this.accounts.some((a) => a.tier === "paid" && !isRateLimitedForFamily(a, family));

        if (!betterTierAvailable) {
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

  getNextForFamily(family: ModelFamily): ManagedAccount | null {
    const available = this.accounts.filter((a) => !isRateLimitedForFamily(a, family));

    if (available.length === 0) {
      return null;
    }

    // Prioritize paid accounts
    const paidAvailable = available.filter((a) => a.tier === "paid");
    const pool = paidAvailable.length > 0 ? paidAvailable : available;

    const account = pool[this.currentIndex % pool.length];
    if (!account) {
      return null;
    }

    this.currentIndex++;
    account.lastUsed = Date.now();
    return account;
  }

  markRateLimited(account: ManagedAccount, retryAfterMs: number, family: ModelFamily): void {
    account.rateLimitResetTimes[family] = Date.now() + retryAfterMs;
  }

  updateAccount(account: ManagedAccount, access: string, expires: number, parts?: RefreshParts): void {
    account.access = access;
    account.expires = expires;
    if (parts) {
      account.parts = parts;
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
      lastUsed: 0,
      email,
      tier,
      quotaUsage: {},
      consecutiveSuccesses: 0,
      totalRateLimits: 0,
    });
  }

  removeAccount(index: number): boolean {
    if (index < 0 || index >= this.accounts.length) {
      return false;
    }
    this.accounts.splice(index, 1);
    this.accounts.forEach((acc, idx) => (acc.index = idx));
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

  /**
   * Record a successful request for quota tracking.
   * Resets quota counter if the reset interval has passed.
   */
  recordSuccess(account: ManagedAccount, family: ModelFamily): void {
    const now = Date.now();
    const usage = account.quotaUsage[family];

    if (!usage || now - usage.lastReset >= QUOTA_RESET_INTERVAL_MS) {
      // Reset quota window
      account.quotaUsage[family] = { requests: 1, lastReset: now };
    } else {
      // Increment within current window
      account.quotaUsage[family] = { requests: usage.requests + 1, lastReset: usage.lastReset };
    }

    account.consecutiveSuccesses++;
    account.lastUsed = now;
  }

  /**
   * Record a rate limit event for tracking.
   */
  recordRateLimit(account: ManagedAccount): void {
    account.totalRateLimits++;
    account.consecutiveSuccesses = 0;
  }

  /**
   * Get the quota usage ratio for an account and model family.
   * Returns a value between 0 (no usage) and 1 (high usage).
   * Higher values indicate more quota has been consumed.
   */
  getQuotaUsageRatio(account: ManagedAccount, family: ModelFamily): number {
    const now = Date.now();
    const usage = account.quotaUsage[family];

    if (!usage || now - usage.lastReset >= QUOTA_RESET_INTERVAL_MS) {
      return 0; // Quota has reset
    }

    // Estimate quota usage based on requests made
    // Typical quotas are 15-60 requests per minute depending on tier
    const estimatedQuota = account.tier === "paid" ? 60 : 15;
    return Math.min(1, usage.requests / estimatedQuota);
  }

  /**
   * Smart account recommendation based on quota analysis.
   * Returns the account with the lowest quota usage ratio.
   * Implements the smart recommendation algorithm from Antigravity-Manager.
   */
  getRecommendedAccount(family: ModelFamily): ManagedAccount | null {
    this.accounts.forEach(clearExpiredRateLimits);

    const available = this.accounts.filter((a) => !isRateLimitedForFamily(a, family));
    if (available.length === 0) {
      return null;
    }

    // Separate by tier
    const paidAccounts = available.filter((a) => a.tier === "paid");
    const freeAccounts = available.filter((a) => a.tier !== "paid");

    // Prioritize paid accounts first (Antigravity-Manager pattern: ULTRA > PRO > FREE)
    const pool = paidAccounts.length > 0 ? paidAccounts : freeAccounts;

    // Sort by quota usage ratio (lowest first = most quota remaining)
    const sorted = pool.sort((a, b) => {
      const ratioA = this.getQuotaUsageRatio(a, family);
      const ratioB = this.getQuotaUsageRatio(b, family);
      return ratioA - ratioB;
    });

    return sorted[0] ?? null;
  }

  /**
   * Get account statistics for smart recommendation display.
   * Returns info about each account's quota status.
   */
  getAccountStats(family: ModelFamily): Array<{
    index: number;
    email?: string;
    tier?: AccountTier;
    quotaUsageRatio: number;
    isRateLimited: boolean;
    consecutiveSuccesses: number;
    totalRateLimits: number;
  }> {
    this.accounts.forEach(clearExpiredRateLimits);

    return this.accounts.map((account) => ({
      index: account.index,
      email: account.email,
      tier: account.tier,
      quotaUsageRatio: this.getQuotaUsageRatio(account, family),
      isRateLimited: isRateLimitedForFamily(account, family),
      consecutiveSuccesses: account.consecutiveSuccesses,
      totalRateLimits: account.totalRateLimits,
    }));
  }

  /**
   * Global rate limit synchronization - mark all model families as rate limited.
   * Used when quota is exhausted (403 quota errors).
   */
  markGlobalRateLimited(account: ManagedAccount, retryAfterMs: number): void {
    const families: ModelFamily[] = ["claude", "gemini-flash", "gemini-pro"];
    for (const family of families) {
      account.rateLimitResetTimes[family] = Date.now() + retryAfterMs;
    }
  }
}
