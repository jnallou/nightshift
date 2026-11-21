import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, cpSync, appendFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULTS } from "./config.mjs";
import { run } from "./util.mjs";

const ENGINE = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SKIP = new Set(["node_modules", "Pods", ".git", "build", "DerivedData", ".build", "dist", ".expo", "vendor"]);

function find(root, test, depth = 3, dir = "") {
  if (depth < 0) return [];
  let out = [];
  for (const e of readdirSync(join(root, dir), { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const rel = dir ? `${dir}/${e.name}` : e.name;
    if (test(e.name)) out.push(rel);
    if (e.isDirectory() && !/\.(xcodeproj|xcworkspace)$/.test(e.name)) out = out.concat(find(root, test, depth - 1, rel));
  }
  return out;
}

const json = (file) => { try { return JSON.parse(readFileSync(file, "utf8")); } catch { return null; } };

/** Work out what kind of app this is and how to check a change, from the files alone. */
export function detect(repo) {
  const pkg = json(join(repo, "package.json"));
  const deps = { ...(pkg?.dependencies || {}), ...(pkg?.devDependencies || {}) };
  const xcode = find(repo, (n) => n.endsWith(".xcodeproj"));
  const d = { stack: "unknown", setup: [], checks: [], bundleId: "", note: "" };

  if (deps.expo || deps["react-native"]) {
    d.stack = deps.expo ? "expo" : "react-native";
    d.setup = [existsSync(join(repo, "pnpm-lock.yaml")) ? "corepack enable && pnpm install --frozen-lockfile" : existsSync(join(repo, "yarn.lock")) ? "yarn install --frozen-lockfile" : existsSync(join(repo, "package-lock.json")) ? "npm ci" : "npm install"];
    if (existsSync(join(repo, "tsconfig.json"))) d.checks.push("npx tsc --noEmit");
    if (pkg.scripts?.lint) d.checks.push("npm run lint");
    if (pkg.scripts?.test && !/no test specified/.test(pkg.scripts.test)) d.checks.push("npm test");
    const app = json(join(repo, "app.json"));
    d.bundleId = app?.expo?.ios?.bundleIdentifier || "";
  } else if (existsSync(join(repo, "pubspec.yaml"))) {
    d.stack = "flutter";
    d.note = "Flutter needs the Flutter SDK on the runner. Add a setup step to the workflow, then set checks to [\"flutter analyze\", \"flutter test\"].";
  } else if (xcode.length || existsSync(join(repo, "Package.swift"))) {
    d.stack = "swift";
    d.note = "A Swift app can only be built on a macOS runner, which costs more minutes. Nightshift starts on Linux and reads the code without compiling. To have it build, set runs-on to macos-latest in the workflow and add an xcodebuild line to checks.";
  }
  if (!d.bundleId) {
    for (const x of xcode) {
      const text = readFileSync(join(repo, x, "project.pbxproj"), "utf8");
      const ids = [...text.matchAll(/PRODUCT_BUNDLE_IDENTIFIER = "?([\w.-]+)"?;/g)].map((m) => m[1]).filter((i) => !/tests?$/i.test(i));
      if (ids.length) { d.bundleId = ids.sort((a, b) => a.length - b.length)[0]; break; }
    }
  }
  return d;
}

export async function init({ repo, reviewer, appId, force = false, fetch = globalThis.fetch }) {
  const top = run("git", ["rev-parse", "--show-toplevel"], { cwd: repo });
  if (top.code !== 0) throw new Error("Run this inside your app's git repository.");
  repo = top.stdout.trim();
  const dir = join(repo, ".nightshift");
  const cfgFile = join(dir, "config.json");
  if (existsSync(cfgFile) && !force) throw new Error(".nightshift/config.json already exists. Pass --force to write it again.");

  const d = detect(repo);
  reviewer ||= run("gh", ["api", "user", "--jq", ".login"], { cwd: repo }).stdout.trim();
  const head = run("git", ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], { cwd: repo }).stdout.trim().replace(/^origin\//, "");
  const baseBranch = head || run("git", ["branch", "--show-current"], { cwd: repo }).stdout.trim() || "main";

  let name = "";
  if (appId || d.bundleId) {
    try {
      const q = appId ? `id=${appId}` : `bundleId=${d.bundleId}`;
      const hit = (await (await fetch(`https://itunes.apple.com/lookup?${q}`)).json()).results?.[0];
      if (hit) { appId = String(hit.trackId); name = hit.trackName; }
    } catch { /* offline is fine, the id can be filled in later */ }
  }

  const cfg = {
    app: { name, appStoreId: appId || "", countries: ["us"] },
    reviewer,
    baseBranch,
    maxPrsPerRun: DEFAULTS.maxPrsPerRun,
    setup: d.setup,
    checks: d.checks,
    sources: {
      appStoreReviews: { enabled: true },
      appStoreConnect: { enabled: false },
      sentry: { enabled: false, org: "", project: "" },
      githubIssues: { enabled: true, labels: ["bug", "feedback"] },
      inbox: { enabled: true },
      commands: [],
    },
  };

  mkdirSync(join(dir, "inbox"), { recursive: true });
  writeFileSync(cfgFile, JSON.stringify(cfg, null, 2) + "\n");
  const tpl = (n) => readFileSync(join(ENGINE, "templates", n), "utf8");
  if (!existsSync(join(dir, "notes.md"))) writeFileSync(join(dir, "notes.md"), tpl("notes.md"));
  writeFileSync(join(dir, "inbox", "README.md"), tpl("inbox.md"));
  const engine = join(dir, "engine");
  if (resolve(engine) !== ENGINE) {
    for (const part of ["bin", "src", "templates", "package.json"]) cpSync(join(ENGINE, part), join(engine, part), { recursive: true });
  }
  const wf = join(repo, ".github", "workflows", "nightshift.yml");
  mkdirSync(dirname(wf), { recursive: true });
  if (!existsSync(wf) || force) writeFileSync(wf, tpl("workflow.yml"));
  const ignore = join(repo, ".gitignore");
  if (!existsSync(ignore) || !readFileSync(ignore, "utf8").includes(".nightshift/run")) appendFileSync(ignore, "\n# Nightshift scratch space\n.nightshift/run/\n");

  return { repo, cfg, detected: d };
}

export function nextSteps({ cfg, detected }) {
  const found = [
    `Stack: ${detected.stack}`,
    `App: ${cfg.app.name ? `${cfg.app.name} (App Store id ${cfg.app.appStoreId})` : "not found on the App Store yet. Set app.appStoreId in .nightshift/config.json"}`,
    `Reviewer: ${cfg.reviewer ? "@" + cfg.reviewer : "not set. Put your GitHub username in .nightshift/config.json"}`,
    `Base branch: ${cfg.baseBranch}`,
    `Checks: ${cfg.checks.length ? cfg.checks.join(", ") : "none"}`,
  ];
  return `
Nightshift is installed.

${found.map((f) => "  " + f).join("\n")}
${detected.note ? "\n  Note: " + detected.note + "\n" : ""}
Three things left, about two minutes:

  1. Give it a brain. Either a Claude subscription token:
       claude setup-token
       gh secret set CLAUDE_CODE_OAUTH_TOKEN
     or an API key:
       gh secret set ANTHROPIC_API_KEY

  2. Let it open pull requests:
       gh api -X PUT repos/{owner}/{repo}/actions/permissions/workflow -F can_approve_pull_request_reviews=true

  3. Commit and push, then start the first shift by hand:
       git add .nightshift .github/workflows/nightshift.yml .gitignore
       git commit -m "Add Nightshift"
       git push
       gh workflow run nightshift.yml

After that it clocks in every night on its own.
To see what it would do without pushing anything: node .nightshift/engine/bin/nightshift.mjs run --dry-run
`;
}
