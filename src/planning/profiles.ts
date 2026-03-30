/**
 * Delivery policy profiles.
 *
 * Profiles configure execution strategy, verify commands, review policy,
 * shipping policy, and watchdog thresholds.
 */

export interface DeliveryProfile {
  execution: {
    modePreference: "auto" | "serial" | "parallel";
    maxConcurrent: number;
  };
  verify: {
    requirePackageChecks: boolean;
    commands: string[];
  };
  review: {
    autoReview: boolean;
    requiredReviewers: string[];
  };
  ship: {
    requirePullRequest: boolean;
    autoShip: boolean;
  };
  watchdog: {
    staleMinutes: number;
    zombieMinutes: number;
  };
}

const DEFAULT_POLICY: DeliveryProfile = {
  execution: { modePreference: "auto", maxConcurrent: 4 },
  verify: { requirePackageChecks: true, commands: [] },
  review: { autoReview: true, requiredReviewers: [] },
  ship: { requirePullRequest: true, autoShip: false },
  watchdog: { staleMinutes: 5, zombieMinutes: 15 },
};

export const BUILTIN_PROFILES: Record<string, Partial<DeliveryProfile>> = {
  "feature-delivery": {
    execution: { modePreference: "auto", maxConcurrent: 4 },
    verify: {
      requirePackageChecks: true,
      commands: ["npm test", "npx tsc --noEmit"],
    },
    review: { autoReview: true, requiredReviewers: ["evaluator"] },
    ship: { requirePullRequest: true, autoShip: true },
    watchdog: { staleMinutes: 5, zombieMinutes: 15 },
  },

  "local-dev": {
    execution: { modePreference: "auto", maxConcurrent: 2 },
    verify: { requirePackageChecks: false, commands: ["npm test"] },
    review: { autoReview: false, requiredReviewers: [] },
    ship: { requirePullRequest: false, autoShip: false },
    watchdog: { staleMinutes: 10, zombieMinutes: 30 },
  },

  "migration-rollout": {
    execution: { modePreference: "serial", maxConcurrent: 1 },
    verify: {
      requirePackageChecks: true,
      commands: ["npm test", "npx tsc --noEmit"],
    },
    review: { autoReview: true, requiredReviewers: ["evaluator"] },
    ship: { requirePullRequest: true, autoShip: false },
    watchdog: { staleMinutes: 3, zombieMinutes: 10 },
  },

  "quick-fix": {
    execution: { modePreference: "auto", maxConcurrent: 1 },
    verify: { requirePackageChecks: false, commands: ["npm test"] },
    review: { autoReview: false, requiredReviewers: [] },
    ship: { requirePullRequest: true, autoShip: true },
    watchdog: { staleMinutes: 5, zombieMinutes: 15 },
  },
};

/**
 * Resolve a profile by name, merging with defaults.
 */
export function resolveProfile(name: string): DeliveryProfile {
  const overrides = BUILTIN_PROFILES[name];
  if (!overrides) return { ...DEFAULT_POLICY };

  return {
    execution: { ...DEFAULT_POLICY.execution, ...overrides.execution },
    verify: { ...DEFAULT_POLICY.verify, ...overrides.verify },
    review: { ...DEFAULT_POLICY.review, ...overrides.review },
    ship: { ...DEFAULT_POLICY.ship, ...overrides.ship },
    watchdog: { ...DEFAULT_POLICY.watchdog, ...overrides.watchdog },
  };
}

/**
 * Get verify commands for a profile.
 */
export function getVerifyCommands(profileName: string): string[] {
  const profile = resolveProfile(profileName);
  return profile.verify.commands;
}

/**
 * Check if a profile wants package-scoped quality gates derived from file scope.
 */
export function requiresPackageChecks(profileName: string): boolean {
  const profile = resolveProfile(profileName);
  return profile.verify.requirePackageChecks;
}

/**
 * Get max concurrent agents for a profile.
 */
export function getMaxConcurrent(profileName: string): number {
  const profile = resolveProfile(profileName);
  return profile.execution.maxConcurrent;
}

/**
 * Check if a profile requires code review.
 */
export function requiresReview(profileName: string): boolean {
  const profile = resolveProfile(profileName);
  return profile.review.autoReview;
}

/**
 * Check if a profile requires a pull request to ship.
 */
export function requiresPR(profileName: string): boolean {
  const profile = resolveProfile(profileName);
  return profile.ship.requirePullRequest;
}
