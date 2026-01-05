import {
  CODE_ASSIST_ENDPOINT_FALLBACKS,
  CODE_ASSIST_HEADERS,
} from "../constants";
import { formatRefreshParts, parseRefreshParts } from "./auth";
import { printAntigravityConsole } from "./logger";
import type {
  OAuthAuthDetails,
  ProjectContextResult,
} from "./types";

const projectContextResultCache = new Map<string, ProjectContextResult>();
const projectContextPendingCache = new Map<string, Promise<ProjectContextResult>>();

const CODE_ASSIST_METADATA = {
  ideType: "IDE_UNSPECIFIED",
  platform: "PLATFORM_UNSPECIFIED",
  pluginType: "ANTIGRAVITY",
} as const;

interface AntigravityUserTier {
  id?: string;
  isDefault?: boolean;
  userDefinedCloudaicompanionProject?: boolean;
}

interface LoadCodeAssistPayload {
  cloudaicompanionProject?: string;
  currentTier?: {
    id?: string;
  };
  allowedTiers?: AntigravityUserTier[];
}

interface OnboardUserPayload {
  done?: boolean;
  response?: {
    cloudaicompanionProject?: {
      id?: string;
    };
  };
}

class ProjectIdRequiredError extends Error {
  /**
   * Error raised when a required Google Cloud project is missing during Antigravity onboarding.
   */
  constructor() {
    super(
      "Antigravity requires a Google Cloud project. Enable the Gemini for Google Cloud API on a project you control, rerun `opencode auth login`, and supply that project ID when prompted.",
    );
  }
}

function isMockProjectIdEnabled(): boolean {
  const raw = process.env.OPENCODE_ANTIGRAVITY_ALLOW_MOCK_PROJECT_ID;
  if (raw === undefined) return true;
  return raw === "1" || raw.toLowerCase() === "true" || raw.toLowerCase() === "yes";
}

// Known-working fallback projectId from Antigravity-Manager
// This is used when loadCodeAssist fails to return a cloudaicompanionProject
const FALLBACK_PROJECT_ID = "bamboo-precept-lgxtn";

function generateMockProjectId(_seed: string): string {
  // Use a real known-working projectId instead of generating fake ones
  // Fake projectIds get "Permission denied" errors from Google's API
  return FALLBACK_PROJECT_ID;
}

/**
 * Builds metadata headers required by the Code Assist API.
 */
function buildMetadata(projectId?: string): Record<string, string> {
  const metadata: Record<string, string> = {
    ideType: CODE_ASSIST_METADATA.ideType,
    platform: CODE_ASSIST_METADATA.platform,
    pluginType: CODE_ASSIST_METADATA.pluginType,
  };
  if (projectId) {
    metadata.duetProject = projectId;
  }
  return metadata;
}

/**
 * Selects the default tier ID from the allowed tiers list.
 */
function getDefaultTierId(allowedTiers?: AntigravityUserTier[]): string | undefined {
  if (!allowedTiers || allowedTiers.length === 0) {
    return undefined;
  }
  for (const tier of allowedTiers) {
    if (tier?.isDefault) {
      return tier.id;
    }
  }
  return allowedTiers[0]?.id;
}

/**
 * Promise-based delay utility.
 */
function wait(ms: number): Promise<void> {
  return new Promise(function (resolve) {
    setTimeout(resolve, ms);
  });
}

/**
 * Generates a cache key for project context based on refresh token.
 */
function getCacheKey(auth: OAuthAuthDetails): string | undefined {
  const refresh = auth.refresh?.trim();
  return refresh ? refresh : undefined;
}

/**
 * Clears cached project context results and pending promises, globally or for a refresh key.
 */
export function invalidateProjectContextCache(refresh?: string): void {
  if (!refresh) {
    projectContextPendingCache.clear();
    projectContextResultCache.clear();
    return;
  }
  projectContextPendingCache.delete(refresh);
  projectContextResultCache.delete(refresh);
}

/**
 * Loads managed project information for the given access token and optional project.
 */
export async function loadManagedProject(
  accessToken: string,
  projectId?: string,
): Promise<LoadCodeAssistPayload | null> {
  const metadata = buildMetadata(projectId);

  const requestBody: Record<string, unknown> = { metadata };
  if (projectId) {
    requestBody.cloudaicompanionProject = projectId;
  }

  for (const endpoint of CODE_ASSIST_ENDPOINT_FALLBACKS) {
    try {
      const response = await fetch(
        `${endpoint}/v1internal:loadCodeAssist`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${accessToken}`,
            ...CODE_ASSIST_HEADERS,
          },
          body: JSON.stringify(requestBody),
        },
      );

      if (!response.ok) {
        continue;
      }

      return (await response.json()) as LoadCodeAssistPayload;
    } catch (error) {
      printAntigravityConsole("error", "Failed to load Antigravity managed project", error);
      continue;
    }
  }

  return null;
}


/**
 * Onboards a managed project for the user, optionally retrying until completion.
 */
export async function onboardManagedProject(
  accessToken: string,
  tierId: string,
  projectId?: string,
  attempts = 10,
  delayMs = 5000,
): Promise<string | undefined> {
  const metadata = buildMetadata(projectId);
  const requestBody: Record<string, unknown> = {
    tierId,
    metadata,
  };

  if (tierId !== "FREE") {
    if (!projectId) {
      throw new ProjectIdRequiredError();
    }
    requestBody.cloudaicompanionProject = projectId;
  }

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      for (const endpoint of CODE_ASSIST_ENDPOINT_FALLBACKS) {
        const response = await fetch(
          `${endpoint}/v1internal:onboardUser`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${accessToken}`,
              ...CODE_ASSIST_HEADERS,
            },
            body: JSON.stringify(requestBody),
          },
        );

        if (!response.ok) {
          continue;
        }

        const payload = (await response.json()) as OnboardUserPayload;
        const managedProjectId = payload.response?.cloudaicompanionProject?.id;
        if (payload.done && managedProjectId) {
          return managedProjectId;
        }
        if (payload.done && projectId) {
          return projectId;
        }
      }
    } catch (error) {
      printAntigravityConsole("error", "Failed to onboard Antigravity managed project", error);
      return undefined;
    }

    await wait(delayMs);
  }

  return undefined;
}

/**
 * Resolves an effective project ID for the current auth state, caching results per refresh token.
 */
export async function ensureProjectContext(
  auth: OAuthAuthDetails,
): Promise<ProjectContextResult> {
  const accessToken = auth.access;
  if (!accessToken) {
    return { auth, effectiveProjectId: "" };
  }

  const cacheKey = getCacheKey(auth);
  if (cacheKey) {
    const cached = projectContextResultCache.get(cacheKey);
    if (cached) {
      return cached;
    }
    const pending = projectContextPendingCache.get(cacheKey);
    if (pending) {
      return pending;
    }
  }

  const resolveContext = async (): Promise<ProjectContextResult> => {
    const parts = parseRefreshParts(auth.refresh);
    if (parts.projectId || parts.managedProjectId) {
      return {
        auth,
        effectiveProjectId: parts.projectId || parts.managedProjectId || "",
      };
    }

    const loadPayload = await loadManagedProject(accessToken, parts.projectId);
    if (loadPayload?.cloudaicompanionProject) {
      const managedProjectId = loadPayload.cloudaicompanionProject;
      const updatedAuth: OAuthAuthDetails = {
        ...auth,
        refresh: formatRefreshParts({
          refreshToken: parts.refreshToken,
          projectId: parts.projectId,
          managedProjectId,
        }),
      };

      return { auth: updatedAuth, effectiveProjectId: managedProjectId };
    }

    if (!loadPayload) {
      if (isMockProjectIdEnabled()) {
        const mockProjectId = generateMockProjectId(parts.refreshToken || auth.refresh);
        const updatedAuth: OAuthAuthDetails = {
          ...auth,
          refresh: formatRefreshParts({
            refreshToken: parts.refreshToken,
            projectId: mockProjectId,
            managedProjectId: undefined,
          }),
        };
        return { auth: updatedAuth, effectiveProjectId: mockProjectId };
      }

      throw new ProjectIdRequiredError();
    }

    const currentTierId = loadPayload.currentTier?.id ?? undefined;
    if (currentTierId && currentTierId !== "FREE") {
      if (isMockProjectIdEnabled()) {
        const mockProjectId = generateMockProjectId(parts.refreshToken || auth.refresh);
        const updatedAuth: OAuthAuthDetails = {
          ...auth,
          refresh: formatRefreshParts({
            refreshToken: parts.refreshToken,
            projectId: mockProjectId,
            managedProjectId: undefined,
          }),
        };
        return { auth: updatedAuth, effectiveProjectId: mockProjectId };
      }
      throw new ProjectIdRequiredError();
    }

    const defaultTierId = getDefaultTierId(loadPayload.allowedTiers);
    const tierId = defaultTierId ?? "FREE";

    if (tierId !== "FREE") {
      throw new ProjectIdRequiredError();
    }

    const managedProjectId = await onboardManagedProject(accessToken, tierId, parts.projectId);
    if (managedProjectId) {
      const updatedAuth: OAuthAuthDetails = {
        ...auth,
        refresh: formatRefreshParts({
          refreshToken: parts.refreshToken,
          projectId: parts.projectId,
          managedProjectId,
        }),
      };

      return { auth: updatedAuth, effectiveProjectId: managedProjectId };
    }

    if (isMockProjectIdEnabled()) {
      const mockProjectId = generateMockProjectId(parts.refreshToken || auth.refresh);
      const updatedAuth: OAuthAuthDetails = {
        ...auth,
        refresh: formatRefreshParts({
          refreshToken: parts.refreshToken,
          projectId: mockProjectId,
          managedProjectId: undefined,
        }),
      };
      return { auth: updatedAuth, effectiveProjectId: mockProjectId };
    }

    throw new ProjectIdRequiredError();
  };

  if (!cacheKey) {
    return resolveContext();
  }

  const promise = resolveContext()
    .then((result) => {
      const nextKey = getCacheKey(result.auth) ?? cacheKey;
      projectContextPendingCache.delete(cacheKey);
      projectContextResultCache.set(nextKey, result);
      if (nextKey !== cacheKey) {
        projectContextResultCache.delete(cacheKey);
      }
      return result;
    })
    .catch((error) => {
      projectContextPendingCache.delete(cacheKey);
      throw error;
    });

  projectContextPendingCache.set(cacheKey, promise);
  return promise;
}
