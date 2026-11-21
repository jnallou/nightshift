import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export const DEFAULTS = {
  app: { name: "", appStoreId: "", countries: ["us"] },
  reviewer: "",
  baseBranch: "main",
  maxPrsPerRun: 2,
  maxIssuesPerRun: 3,
  maxChangedLines: 400,
  regressionGraceDays: 14,
  model: "",
  budgetUsdPerCall: 4,
  // Commands the engine runs once before the agent starts, for example "npm ci".
  setup: [],
  // Commands that prove a change is sound, for example "npx tsc --noEmit".
  // The agent may run these and nothing else. The engine runs them again itself.
  checks: [],
  // The agent can never open a pull request that touches these.
  protectedPaths: [
    ".github/**", ".nightshift/**", "**/.env", "**/.env.*", "**/*.p8", "**/*.p12", "**/*.pem",
    "**/*.mobileprovision", "**/*.entitlements", "**/GoogleService-Info.plist",
    "**/google-services.json", "fastlane/**",
  ],
  sources: {
    appStoreReviews: { enabled: true, maxRating: 4, lookbackDays: 30 },
    appStoreConnect: { enabled: false, lookbackDays: 30 },
    sentry: { enabled: false, host: "https://sentry.io", org: "", project: "" },
    githubIssues: { enabled: true, labels: ["bug", "feedback"] },
    inbox: { enabled: true },
    commands: [],
  },
};

function merge(base, over) {
  if (Array.isArray(base) || typeof base !== "object" || base === null) return over ?? base;
  const out = { ...base };
  for (const [k, v] of Object.entries(over || {})) {
    out[k] = k in base && typeof base[k] === "object" && !Array.isArray(base[k]) ? merge(base[k], v) : v;
  }
  return out;
}

export function loadConfig(repo) {
  const file = join(repo, ".nightshift", "config.json");
  if (!existsSync(file)) throw new Error(`No ${file}. Run "nightshift init" in your repo first.`);
  return merge(DEFAULTS, JSON.parse(readFileSync(file, "utf8")));
}
