#!/usr/bin/env node
import { resolve } from "node:path";
import { run } from "../src/util.mjs";

const [cmd, ...rest] = process.argv.slice(2);
const flag = (name) => rest.includes(`--${name}`);
const opt = (name) => { const i = rest.indexOf(`--${name}`); return i >= 0 ? rest[i + 1] : undefined; };
const repo = resolve(opt("repo") || process.cwd());

const HELP = `nightshift: a feedback loop agent for your app

  nightshift init [--reviewer you] [--app-id 123] [--force]   set it up in this repo
  nightshift collect                                          show what it hears, without using the model
  nightshift run [--dry-run]                                  one full shift (dry run pushes nothing)
  nightshift doctor                                           check that everything is in place

  --repo <path> points any command at another folder.`;

try {
  if (cmd === "init") {
    const { init, nextSteps } = await import("../src/init.mjs");
    console.log(nextSteps(await init({ repo, reviewer: opt("reviewer"), appId: opt("app-id"), force: flag("force") })));
  } else if (cmd === "collect") {
    const { loadConfig } = await import("../src/config.mjs");
    const { collectAll } = await import("../src/collect.mjs");
    const { signals, counts } = await collectAll(loadConfig(repo), { repo });
    console.log(JSON.stringify(signals, null, 2));
    console.error(`\n${signals.length} signals.`, counts);
  } else if (cmd === "run") {
    const { runNightshift } = await import("../src/run.mjs");
    const r = await runNightshift({ repo, dryRun: flag("dry-run") });
    process.exit(r.ok ? 0 : 1);
  } else if (cmd === "doctor") {
    const { loadConfig } = await import("../src/config.mjs");
    const cfg = loadConfig(repo);
    const env = process.env, s = cfg.sources;
    const rows = [
      ["Claude Code is installed", run(env.NIGHTSHIFT_CLAUDE_BIN || "claude", ["--version"]).code === 0, "npm install -g @anthropic-ai/claude-code"],
      ["GitHub CLI is signed in", run("gh", ["auth", "status"], { cwd: repo }).code === 0, "gh auth login"],
      ["A reviewer is set", !!cfg.reviewer, "set reviewer in .nightshift/config.json"],
      ["The App Store id is set", !!cfg.app.appStoreId, "set app.appStoreId in .nightshift/config.json"],
    ];
    if (env.CI) rows.push(["A Claude credential is present", !!(env.ANTHROPIC_API_KEY || env.CLAUDE_CODE_OAUTH_TOKEN), "add the CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY secret"]);
    if (s.appStoreConnect.enabled) rows.push(["App Store Connect keys are present", !!(env.ASC_KEY_ID && env.ASC_ISSUER_ID && env.ASC_PRIVATE_KEY), "add ASC_KEY_ID, ASC_ISSUER_ID and ASC_PRIVATE_KEY"]);
    if (s.sentry.enabled) rows.push(["Sentry is configured", !!(env.SENTRY_AUTH_TOKEN && s.sentry.org && s.sentry.project), "add SENTRY_AUTH_TOKEN and fill in sources.sentry"]);
    for (const [what, ok, fix] of rows) console.log(`${ok ? "ok  " : "FIX "} ${what}${ok ? "" : `  ->  ${fix}`}`);
    process.exit(rows.every((r) => r[1]) ? 0 : 1);
  } else {
    console.log(HELP);
    process.exit(cmd && cmd !== "help" && cmd !== "--help" ? 1 : 0);
  }
} catch (e) {
  console.error(`nightshift: ${e.message}`);
  process.exit(1);
}
