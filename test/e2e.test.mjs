// Whole shifts against a throwaway repo with a real git remote.
// The model and the GitHub CLI are stand-ins, so these prove the engine: what it
// branches, pushes, opens and refuses. They do not prove the model's judgement.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runNightshift } from "../src/run.mjs";
import { init, detect } from "../src/init.mjs";
import { marker } from "../src/history.mjs";
import { signal } from "../src/signals.mjs";
import { run } from "../src/util.mjs";

const REPORT = { title: "Streak resets when I travel", body: "Flew west and my 30 day streak went to zero.", appVersion: "1.1.0" };
const SIGNAL_ID = signal({ source: "inbox/reports.json", kind: "note", title: REPORT.title, body: REPORT.body }).id;

const CLAUDE = `#!/usr/bin/env node
const fs = require("fs"), path = require("path");
const dir = process.env.STUB_DIR, plan = JSON.parse(fs.readFileSync(path.join(dir, "plan.json"), "utf8"));
const prompt = fs.readFileSync(0, "utf8");
const step = prompt.includes("This is the triage step") ? "triage" : "fix";
fs.appendFileSync(path.join(dir, "claude.jsonl"), JSON.stringify({ step, argv: process.argv.slice(2), env: Object.keys(process.env), retry: prompt.includes("<failed_check>"), prompt }) + "\\n");
if (plan.error) { console.log(JSON.stringify({ type: "result", is_error: true, result: plan.error })); process.exit(0); }
let out = plan.triage;
if (step === "fix") {
  const n = fs.readFileSync(path.join(dir, "claude.jsonl"), "utf8").split("\\n").filter((l) => l.includes('"step":"fix"')).length;
  const f = plan.fixes[Math.min(n, plan.fixes.length) - 1];
  for (const [file, text] of Object.entries(f.write || {})) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); }
  out = f.answer;
}
console.log(JSON.stringify({ type: "result", is_error: false, result: "done", structured_output: out, total_cost_usd: 0.25, permission_denials: [] }));
`;

const GH = `#!/usr/bin/env node
const fs = require("fs"), path = require("path");
const dir = process.env.STUB_DIR, a = process.argv.slice(2);
const read = (f) => { try { return fs.readFileSync(path.join(dir, f), "utf8"); } catch { return "[]"; } };
const bodyAt = a.indexOf("--body-file");
fs.appendFileSync(path.join(dir, "gh.jsonl"), JSON.stringify({ a, token: process.env.GH_TOKEN || null, body: bodyAt > 0 ? fs.readFileSync(a[bodyAt + 1], "utf8") : undefined }) + "\\n");
const cmd = a.slice(0, 2).join(" ");
if (cmd === "pr list") console.log(read("prs.json"));
else if (cmd === "issue list") console.log(a.includes("--label") ? read("issues.json") : read("open-issues.json"));
else if (cmd === "pr create") {
  if (a.includes("--reviewer") && fs.existsSync(path.join(dir, "reject-reviewer"))) { console.error("Review cannot be requested from pull request author."); process.exit(1); }
  console.log("https://github.com/demo/app/pull/7");
}
else if (cmd === "issue create") console.log("https://github.com/demo/app/issues/8");
else if (a[0] === "api") console.log("[]");
`;

const BUGGY = `export function dayKey(date) {\n  return date.toISOString().slice(0, 10); // BUG: uses UTC, not the user's day\n}\n`;
const FIXED = `export function dayKey(date, timeZone) {\n  return new Intl.DateTimeFormat("en-CA", { timeZone }).format(date);\n}\n`;
const CHECK = `import { dayKey } from "./src/streak.mjs";\nconst got = dayKey(new Date("2026-03-01T03:00:00Z"), "America/Los_Angeles");\nif (got !== "2026-02-28") { console.error("dayKey ignores the time zone, got " + got); process.exit(1); }\nif (process.env.GH_TOKEN) { console.error("LEAK: checks can see the GitHub token"); process.exit(1); }\n`;
const answer = (over = {}) => ({ fixed: true, confidence: "high", title: "Use the user's time zone for streak days", rootCause: "src/streak.mjs:2 builds the day key from UTC.", change: "dayKey takes the user's time zone.", verification: "Ran node check.mjs, it passed.", risk: "Callers must pass a time zone.", howToTest: "Set the phone to Honolulu and clock in at 9pm.", ...over });
const TRIAGE = { items: [{ title: "Streak resets across time zones", action: "fix", severity: 4, signalIds: [SIGNAL_ID, "made-up-id"], evidence: "One report on 1.1.0 of a 30 day streak lost after flying west.", suspectedFiles: ["src/streak.mjs"], reason: "Day key is built from UTC." }] };

function world({ plan, config = {}, files = {} }) {
  const root = mkdtempSync(join(tmpdir(), "nightshift-"));
  const repo = join(root, "app"), remote = join(root, "remote.git"), stub = join(root, "stub"), bin = join(root, "bin");
  for (const d of [repo, stub, bin, join(repo, "src"), join(repo, ".nightshift", "inbox")]) mkdirSync(d, { recursive: true });
  const put = (f, text) => { mkdirSync(join(repo, f, ".."), { recursive: true }); writeFileSync(join(repo, f), text); };
  put("src/streak.mjs", BUGGY);
  put("check.mjs", CHECK);
  put(".nightshift/inbox/reports.json", JSON.stringify([REPORT]));
  put(".nightshift/notes.md", "Keep diffs small.");
  put(".nightshift/config.json", JSON.stringify({ app: { name: "Demo" }, reviewer: "sam", baseBranch: "main", checks: ["node check.mjs"], sources: { appStoreReviews: { enabled: false }, githubIssues: { enabled: true } }, ...config }));
  for (const [f, text] of Object.entries(files)) put(f, text);
  const git = (...a) => run("git", a, { cwd: repo, check: true });
  run("git", ["init", "--bare", "-q", "-b", "main", remote], { check: true });
  git("init", "-q", "-b", "main");
  git("add", "-A");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "start");
  git("remote", "add", "origin", remote);
  git("push", "-q", "origin", "main");
  writeFileSync(join(stub, "plan.json"), JSON.stringify(plan));
  writeFileSync(join(bin, "claude-stub"), CLAUDE); chmodSync(join(bin, "claude-stub"), 0o755);
  writeFileSync(join(bin, "gh"), GH); chmodSync(join(bin, "gh"), 0o755);
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, STUB_DIR: stub, NIGHTSHIFT_CLAUDE_BIN: join(bin, "claude-stub"), GH_TOKEN: "ghs_secret", GITHUB_STEP_SUMMARY: join(stub, "summary.md") };
  const lines = (f) => (existsSync(join(stub, f)) ? readFileSync(join(stub, f), "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []);
  // gh is found through PATH, so the engine must be given this env for every call it makes
  const realPath = process.env.PATH;
  return {
    repo, remote, stub, env, git,
    shift: async (o = {}) => { process.env.PATH = env.PATH; process.env.STUB_DIR = stub; try { return await runNightshift({ repo, env, ...o }); } finally { process.env.PATH = realPath; delete process.env.STUB_DIR; } },
    gh: () => lines("gh.jsonl"), claude: () => lines("claude.jsonl"),
    remoteBranches: () => run("git", ["branch", "--format=%(refname:short)"], { cwd: remote }).stdout.trim().split("\n").filter(Boolean),
    clean: () => run("git", ["status", "--porcelain"], { cwd: repo }).stdout.trim() === "" && run("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: repo }).stdout.trim() === "main",
  };
}

test("a real report becomes a reviewed, checked pull request", async () => {
  const w = world({ plan: { triage: TRIAGE, fixes: [{ write: { "src/streak.mjs": FIXED }, answer: answer() }] } });
  const r = await w.shift();
  assert.deepEqual(r.problems, []);
  assert.equal(r.prs.length, 1);
  assert.equal(r.prs[0].url, "https://github.com/demo/app/pull/7");

  const branch = w.remoteBranches().find((b) => b.startsWith("nightshift/"));
  assert.ok(branch, "the fix branch was pushed");
  assert.equal(run("git", ["show", `${branch}:src/streak.mjs`], { cwd: w.remote }).stdout, FIXED);
  assert.equal(run("git", ["show", "main:src/streak.mjs"], { cwd: w.remote }).stdout, BUGGY, "main is never touched");
  assert.equal(run("git", ["log", "-1", "--format=%an", branch], { cwd: w.remote }).stdout.trim(), "Nightshift");
  assert.ok(w.clean(), "the checkout is left clean on its original branch");

  const pr = w.gh().find((c) => c.a[0] === "pr" && c.a[1] === "create");
  const arg = (n) => pr.a[pr.a.indexOf(n) + 1];
  assert.equal(arg("--reviewer"), "sam");
  assert.equal(arg("--assignee"), "sam");
  assert.equal(arg("--label"), "nightshift");
  assert.equal(arg("--base"), "main");
  assert.equal(arg("--title"), "Use the user's time zone for streak days");
  assert.ok(!pr.a.includes("--draft"));
  for (const part of ["## What users hit", "30 day streak", "## Root cause", "src/streak.mjs:2", "`node check.mjs` passed when the engine ran it", "@sam this one is yours", marker([SIGNAL_ID])]) assert.ok(pr.body.includes(part), part);
  assert.ok(!pr.body.includes("made-up-id"), "ids the model invented are dropped");

  const [triage, fix] = w.claude();
  const flag = (c, n) => c.argv[c.argv.indexOf(n) + 1];
  assert.equal(flag(triage, "--tools"), "Read,Glob,Grep", "triage cannot write or run anything");
  assert.equal(flag(fix, "--tools"), "Read,Glob,Grep,Edit,Write,Bash");
  assert.deepEqual(fix.argv.slice(fix.argv.indexOf("--allowedTools") + 1), ["Read", "Glob", "Grep", "Edit", "Write", "Bash(node check.mjs)", "Bash(node check.mjs *)"]);
  assert.equal(flag(fix, "--permission-mode"), "dontAsk");
  assert.ok(!fix.env.includes("GH_TOKEN"), "the agent never sees the GitHub token");
  assert.ok(triage.prompt.includes("Keep diffs small."), "owner notes reach the agent");
  assert.match(readFileSync(w.env.GITHUB_STEP_SUMMARY, "utf8"), /opened 1 pull request and 0 issues/);
});

test("the next night it does not raise the same thing again, and a declined one stays declined", async () => {
  for (const state of ["OPEN", "CLOSED"]) {
    const w = world({ plan: { triage: TRIAGE, fixes: [] } });
    writeFileSync(join(w.stub, "prs.json"), JSON.stringify([{ number: 7, title: "x", state, body: marker([SIGNAL_ID]), createdAt: new Date().toISOString(), closedAt: null, mergedAt: null, reviews: [{ author: { login: "sam" }, body: "Intended behaviour." }], comments: [] }]));
    const r = await w.shift();
    assert.equal(w.claude().length, 0, "no model call when nothing is new");
    assert.match(r.headline, /Quiet night/);
    assert.match(r.skipped[0], state === "OPEN" ? /already covered by open #7/ : /you closed #7 without taking it/);
  }
});

test("a change to a protected file is thrown away and reported instead", async () => {
  const w = world({ plan: { triage: TRIAGE, fixes: [{ write: { "src/streak.mjs": FIXED, ".github/workflows/ci.yml": "on: push\n" }, answer: answer() }] } });
  const r = await w.shift();
  assert.equal(r.prs.length, 0);
  assert.deepEqual(w.remoteBranches(), ["main"], "nothing was pushed");
  assert.ok(w.clean());
  const issue = w.gh().find((c) => c.a[0] === "issue" && c.a[1] === "create");
  assert.match(issue.body, /touched protected paths \(\.github\/workflows\/ci\.yml\)/);
  assert.ok(issue.body.includes(marker([SIGNAL_ID])));
});

test("a fix that fails the checks gets one more try, then becomes an issue", async () => {
  const wrong = BUGGY.replace("BUG", "still wrong");
  const w = world({ plan: { triage: TRIAGE, fixes: [{ write: { "src/streak.mjs": wrong }, answer: answer() }, { write: { "src/streak.mjs": wrong + "\n" }, answer: answer() }] } });
  const r = await w.shift();
  const fixes = w.claude().filter((c) => c.step === "fix");
  assert.deepEqual(fixes.map((c) => c.retry), [false, true]);
  assert.match(fixes[1].prompt, /dayKey ignores the time zone/);
  assert.equal(r.prs.length, 0);
  assert.deepEqual(w.remoteBranches(), ["main"]);
  assert.match(w.gh().find((c) => c.a[0] === "issue" && c.a[1] === "create").body, /`node check\.mjs` still fails/);
  assert.ok(w.clean());

  const w2 = world({ plan: { triage: TRIAGE, fixes: [{ write: { "src/streak.mjs": wrong }, answer: answer() }, { write: { "src/streak.mjs": FIXED }, answer: answer() }] } });
  assert.equal((await w2.shift()).prs.length, 1, "a repaired fix ships");
});

test("no diagnosis, low confidence, and reviewer-is-author are each handled", async () => {
  const w = world({ plan: { triage: TRIAGE, fixes: [{ answer: answer({ fixed: false, rootCause: "Could not find where the day rolls over." }) }] } });
  await w.shift();
  assert.match(w.gh().find((c) => c.a[0] === "issue" && c.a[1] === "create").body, /Could not find where the day rolls over\./);

  const w2 = world({ plan: { triage: TRIAGE, fixes: [{ write: { "src/streak.mjs": FIXED }, answer: answer({ confidence: "low" }) }] } });
  writeFileSync(join(w2.stub, "reject-reviewer"), "");
  const r = await w2.shift();
  assert.equal(r.prs.length, 1, "falls back to opening without a review request");
  const creates = w2.gh().filter((c) => c.a[0] === "pr" && c.a[1] === "create");
  assert.equal(creates.length, 2);
  assert.ok(creates[1].a.includes("--draft") && !creates[1].a.includes("--reviewer"));
});

test("report items open an issue, or answer on the issue a person already filed", async () => {
  const report = { items: [{ ...TRIAGE.items[0], action: "report", reason: "Needs a product decision on travel days." }] };
  const w = world({ plan: { triage: report, fixes: [] } });
  const r = await w.shift();
  assert.equal(r.issues[0].url, "https://github.com/demo/app/issues/8");
  assert.equal(w.claude().length, 1, "no fix call for a report");

  const w2 = world({ plan: { triage: { items: [] }, fixes: [] }, config: { sources: { appStoreReviews: { enabled: false }, inbox: { enabled: false }, githubIssues: { enabled: true, labels: [] } } } });
  writeFileSync(join(w2.stub, "open-issues.json"), JSON.stringify([{ number: 3, title: "Duel score wrong", body: "b", labels: [], updatedAt: new Date().toISOString(), url: "u" }]));
  const id = signal({ source: "github", kind: "issue", key: 3, title: "x" }).id;
  writeFileSync(join(w2.stub, "plan.json"), JSON.stringify({ triage: { items: [{ title: "Duel score wrong", action: "report", severity: 3, signalIds: [id], evidence: "One issue.", reason: "Scoring runs on the server, which is not in this repo." }] }, fixes: [] }));
  const r2 = await w2.shift();
  assert.equal(r2.issues[0].url, "commented on #3");
  assert.ok(w2.gh().some((c) => c.a.join(" ") === "issue edit 3 --add-label nightshift"));
  assert.ok(!w2.gh().some((c) => c.a[0] !== "label" && c.a[1] === "create"));
});

test("a dry run pushes nothing and opens nothing; a model failure is a problem, not a finding", async () => {
  const w = world({ plan: { triage: TRIAGE, fixes: [{ write: { "src/streak.mjs": FIXED }, answer: answer() }] } });
  const r = await w.shift({ dryRun: true });
  assert.match(r.prs[0].url, /dry run/);
  assert.deepEqual(w.remoteBranches(), ["main"]);
  assert.ok(!w.gh().some((c) => ["create", "comment", "edit"].includes(c.a[1])));
  assert.ok(w.clean());

  const w2 = world({ plan: { error: "Failed to authenticate" } });
  const r2 = await w2.shift();
  assert.equal(r2.ok, false);
  assert.match(r2.problems[0], /Triage failed: Failed to authenticate/);
  assert.ok(!w2.gh().some((c) => c.a[0] !== "label" && c.a[1] === "create"));
});

test("it refuses to run on a dirty checkout", async () => {
  const w = world({ plan: { triage: TRIAGE, fixes: [] } });
  writeFileSync(join(w.repo, "wip.txt"), "mine");
  await assert.rejects(w.shift(), /uncommitted changes/);
  assert.equal(readFileSync(join(w.repo, "wip.txt"), "utf8"), "mine");
});

test("init reads the project and installs a working copy of itself", async () => {
  const root = mkdtempSync(join(tmpdir(), "nightshift-init-"));
  run("git", ["init", "-q", "-b", "main", root], { check: true });
  mkdirSync(join(root, "ios", "ClockdIn.xcodeproj"), { recursive: true });
  writeFileSync(join(root, "ios", "ClockdIn.xcodeproj", "project.pbxproj"), 'PRODUCT_BUNDLE_IDENTIFIER = "com.demo.app.tests";\nPRODUCT_BUNDLE_IDENTIFIER = com.demo.app;\n');
  assert.deepEqual({ stack: detect(root).stack, id: detect(root).bundleId }, { stack: "swift", id: "com.demo.app" });
  const fetch = async (url) => ({ json: async () => (url.includes("bundleId=com.demo.app") ? { results: [{ trackId: 4242, trackName: "Demo App" }] } : { results: [] }) });
  const out = await init({ repo: root, reviewer: "sam", fetch });
  assert.deepEqual(out.cfg.app, { name: "Demo App", appStoreId: "4242", countries: ["us"] });
  assert.deepEqual(out.cfg.checks, []);
  for (const f of [".nightshift/config.json", ".nightshift/notes.md", ".nightshift/inbox/README.md", ".nightshift/engine/bin/nightshift.mjs", ".nightshift/engine/src/run.mjs", ".github/workflows/nightshift.yml"]) assert.ok(existsSync(join(root, f)), f);
  assert.match(readFileSync(join(root, ".gitignore"), "utf8"), /\.nightshift\/run\//);
  assert.match(run("node", [join(root, ".nightshift/engine/bin/nightshift.mjs"), "help"]).stdout, /feedback loop agent/);
  await assert.rejects(init({ repo: root, fetch }), /already exists/);

  const expo = mkdtempSync(join(tmpdir(), "nightshift-expo-"));
  writeFileSync(join(expo, "package.json"), JSON.stringify({ dependencies: { expo: "1" }, scripts: { test: "jest", lint: "eslint ." } }));
  writeFileSync(join(expo, "package-lock.json"), "{}"); writeFileSync(join(expo, "tsconfig.json"), "{}");
  writeFileSync(join(expo, "app.json"), JSON.stringify({ expo: { ios: { bundleIdentifier: "com.demo.rn" } } }));
  assert.deepEqual(detect(expo), { stack: "expo", setup: ["npm ci"], checks: ["npx tsc --noEmit", "npm run lint", "npm test"], bundleId: "com.demo.rn", note: "" });
});
