import { describe, it, expect, beforeEach } from "bun:test";
import { AccountManager } from "./accounts";
import { computeExponentialBackoffMs, addJitter, computeErrorBackoffMs, ERROR_BACKOFF_CONFIG } from "./fetch-wrapper";

describe("Optimization Features", () => {
  describe("Jitter in Exponential Backoff", () => {
    it("should add jitter within ±20% range", () => {
      const baseDelay = 1000;
      const results = new Set<number>();

      // Run multiple times to verify randomness
      for (let i = 0; i < 100; i++) {
        const result = addJitter(baseDelay);
        results.add(result);
        // Should be within ±20% of base
        expect(result).toBeGreaterThanOrEqual(800);
        expect(result).toBeLessThanOrEqual(1200);
      }

      // Should have multiple different values due to randomness
      expect(results.size).toBeGreaterThan(1);
    });

    it("should handle zero delay", () => {
      const result = addJitter(0);
      expect(result).toBe(0);
    });

    it("should apply jitter by default in computeExponentialBackoffMs", () => {
      const results = new Set<number>();

      // Run multiple times to verify randomness
      for (let i = 0; i < 20; i++) {
        const result = computeExponentialBackoffMs(1);
        results.add(result);
      }

      // Should have multiple different values due to jitter
      expect(results.size).toBeGreaterThan(1);
    });

    it("should allow disabling jitter", () => {
      const results = new Set<number>();

      for (let i = 0; i < 10; i++) {
        const result = computeExponentialBackoffMs(1, 1000, 60000, false);
        results.add(result);
      }

      // Should always be the same value without jitter
      expect(results.size).toBe(1);
      expect([...results][0]).toBe(1000);
    });
  });

  describe("Error-Specific Backoff Strategies", () => {
    it("should have shorter fixed delay for auth errors", () => {
      const config = ERROR_BACKOFF_CONFIG["auth-expired"];
      expect(config.fixed).toBe(true);
      expect(config.baseMs).toBe(200);
    });

    it("should have medium fixed delay for forbidden errors", () => {
      const config = ERROR_BACKOFF_CONFIG["forbidden"];
      expect(config.fixed).toBe(true);
      expect(config.baseMs).toBe(500);
    });

    it("should use exponential backoff for rate limits", () => {
      const config = ERROR_BACKOFF_CONFIG["rate-limit"];
      expect(config.fixed).toBeFalsy();
    });

    it("should use exponential backoff for server errors with shorter max", () => {
      const config = ERROR_BACKOFF_CONFIG["server-error"];
      expect(config.fixed).toBeFalsy();
      expect(config.maxMs).toBeLessThan(ERROR_BACKOFF_CONFIG["rate-limit"].maxMs);
    });

    it("should compute correct backoff for fixed error types", () => {
      // Auth expired should return value near 200ms (with jitter)
      const authBackoff = computeErrorBackoffMs("auth-expired", 1);
      expect(authBackoff).toBeGreaterThanOrEqual(160);
      expect(authBackoff).toBeLessThanOrEqual(240);

      // Forbidden should return value near 500ms (with jitter)
      const forbiddenBackoff = computeErrorBackoffMs("forbidden", 1);
      expect(forbiddenBackoff).toBeGreaterThanOrEqual(400);
      expect(forbiddenBackoff).toBeLessThanOrEqual(600);
    });
  });

  describe("Quota Tracking", () => {
    const mockAuth = {
      type: "oauth" as const,
      refresh: "1//refresh_token_1",
      access: "access_token_1",
      expires: 3600,
    };

    let manager: AccountManager;

    beforeEach(() => {
      manager = new AccountManager(mockAuth);
    });

    it("should record successful requests", () => {
      const account = manager.getAccounts()[0]!;

      manager.recordSuccess(account, "gemini-pro");

      expect(account.consecutiveSuccesses).toBe(1);
      expect(account.quotaUsage["gemini-pro"]).toBeDefined();
      expect(account.quotaUsage["gemini-pro"]!.requests).toBe(1);
    });

    it("should track consecutive successes", () => {
      const account = manager.getAccounts()[0]!;

      manager.recordSuccess(account, "gemini-pro");
      manager.recordSuccess(account, "gemini-pro");
      manager.recordSuccess(account, "gemini-pro");

      expect(account.consecutiveSuccesses).toBe(3);
      expect(account.quotaUsage["gemini-pro"]!.requests).toBe(3);
    });

    it("should reset consecutive successes on rate limit", () => {
      const account = manager.getAccounts()[0]!;

      manager.recordSuccess(account, "gemini-pro");
      manager.recordSuccess(account, "gemini-pro");
      expect(account.consecutiveSuccesses).toBe(2);

      manager.recordRateLimit(account);
      expect(account.consecutiveSuccesses).toBe(0);
      expect(account.totalRateLimits).toBe(1);
    });

    it("should calculate quota usage ratio correctly", () => {
      const account = manager.getAccounts()[0]!;
      account.tier = "free"; // Free tier has estimated 15 requests/min

      // Fresh account should have 0 usage
      expect(manager.getQuotaUsageRatio(account, "gemini-pro")).toBe(0);

      // Add 7 requests (about half the estimated quota)
      for (let i = 0; i < 7; i++) {
        manager.recordSuccess(account, "gemini-pro");
      }

      // Should be around 46.7% (7/15)
      const ratio = manager.getQuotaUsageRatio(account, "gemini-pro");
      expect(ratio).toBeGreaterThan(0.4);
      expect(ratio).toBeLessThan(0.5);
    });
  });

  describe("Smart Account Recommendation", () => {
    const mockAuth = {
      type: "oauth" as const,
      refresh: "1//refresh_token_1",
      access: "access_token_1",
      expires: 3600,
    };

    it("should recommend account with lowest quota usage", () => {
      const manager = new AccountManager(mockAuth);

      // Add second account
      manager.addAccount(
        { refreshToken: "refresh_2", projectId: "proj_2" },
        "access_2",
        3600,
        "user2@example.com",
        "free"
      );

      const accounts = manager.getAccounts();
      accounts[0]!.tier = "free";

      // Use quota on first account
      for (let i = 0; i < 10; i++) {
        manager.recordSuccess(accounts[0]!, "gemini-pro");
      }

      // Second account should be recommended (less usage)
      const recommended = manager.getRecommendedAccount("gemini-pro");
      expect(recommended?.index).toBe(1);
    });

    it("should prioritize paid accounts over free", () => {
      const manager = new AccountManager(mockAuth);
      const accounts = manager.getAccounts();
      accounts[0]!.tier = "free";

      // Add paid account
      manager.addAccount(
        { refreshToken: "refresh_2", projectId: "proj_2" },
        "access_2",
        3600,
        "paid@example.com",
        "paid"
      );

      // Should recommend paid account even if it has more usage
      const paid = manager.getAccounts()[1]!;
      for (let i = 0; i < 5; i++) {
        manager.recordSuccess(paid, "gemini-pro");
      }

      const recommended = manager.getRecommendedAccount("gemini-pro");
      expect(recommended?.tier).toBe("paid");
    });

    it("should return null when all accounts are rate limited", () => {
      const manager = new AccountManager(mockAuth);
      const account = manager.getAccounts()[0]!;

      manager.markRateLimited(account, 60000, "gemini-pro");

      const recommended = manager.getRecommendedAccount("gemini-pro");
      expect(recommended).toBeNull();
    });
  });

  describe("Global Rate Limit Synchronization", () => {
    const mockAuth = {
      type: "oauth" as const,
      refresh: "1//refresh_token_1",
      access: "access_token_1",
      expires: 3600,
    };

    it("should mark all model families as rate limited", () => {
      const manager = new AccountManager(mockAuth);
      const account = manager.getAccounts()[0]!;

      manager.markGlobalRateLimited(account, 60000);

      const now = Date.now();
      expect(account.rateLimitResetTimes.claude).toBeGreaterThan(now);
      expect(account.rateLimitResetTimes["gemini-flash"]).toBeGreaterThan(now);
      expect(account.rateLimitResetTimes["gemini-pro"]).toBeGreaterThan(now);
    });

    it("should make account unavailable for all model families", () => {
      const manager = new AccountManager(mockAuth);
      const account = manager.getAccounts()[0]!;

      manager.markGlobalRateLimited(account, 60000);

      expect(manager.getCurrentOrNextForFamily("claude")).toBeNull();
      expect(manager.getCurrentOrNextForFamily("gemini-flash")).toBeNull();
      expect(manager.getCurrentOrNextForFamily("gemini-pro")).toBeNull();
    });
  });

  describe("Account Statistics", () => {
    const mockAuth = {
      type: "oauth" as const,
      refresh: "1//refresh_token_1",
      access: "access_token_1",
      expires: 3600,
    };

    it("should return accurate statistics for accounts", () => {
      const manager = new AccountManager(mockAuth);

      // Add second account
      manager.addAccount(
        { refreshToken: "refresh_2", projectId: "proj_2" },
        "access_2",
        3600,
        "user2@example.com",
        "paid"
      );

      const accounts = manager.getAccounts();
      accounts[0]!.tier = "free";
      accounts[0]!.email = "user1@example.com";

      // Add usage to first account
      for (let i = 0; i < 5; i++) {
        manager.recordSuccess(accounts[0]!, "gemini-pro");
      }

      // Rate limit second account
      manager.markRateLimited(accounts[1]!, 60000, "gemini-pro");
      manager.recordRateLimit(accounts[1]!);

      const stats = manager.getAccountStats("gemini-pro");

      expect(stats).toHaveLength(2);
      expect(stats[0]!.email).toBe("user1@example.com");
      expect(stats[0]!.tier).toBe("free");
      expect(stats[0]!.quotaUsageRatio).toBeGreaterThan(0);
      expect(stats[0]!.isRateLimited).toBe(false);
      expect(stats[0]!.consecutiveSuccesses).toBe(5);

      expect(stats[1]!.email).toBe("user2@example.com");
      expect(stats[1]!.tier).toBe("paid");
      expect(stats[1]!.isRateLimited).toBe(true);
      expect(stats[1]!.totalRateLimits).toBe(1);
    });
  });
});
