import { mkdirSync, writeFileSync, readFileSync, existsSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "./config.mjs";
import { collectAll } from "./collect.mjs";
import { fetchHistory, filterNew, openWork, lessons, marker } from "./history.mjs";
import { askClaude, cleanEnv } from "./agent.mjs";
import { TRIAGE_SCHEMA, FIX_SCHEMA, triagePrompt, fixPrompt, prBody, issueBody } from "./prompts.mjs";
import { LABEL } from "./collectors/local.mjs";
import { run, shell, slug, hash, clip, matchesAny, log } from "./util.mjs";

const READ_TOOLS = ["Read", "Glob", "Grep"];
const WHO = ["-c", "user.name=Nightshift", "-c", "user.email=nightshift@users.noreply.github.com"];

export async function runNightshift({ repo, dryRun = false, env = process.env, fetch = globalThis.fetch }) {
  const cfg = loadConfig(repo);
  const git = (args, o = {}) => run("git", args, { cwd: repo, ...o });
  const gh = (args, o = {}) => run("gh", args, { cwd: repo, env, ...o });
  const runDir = join(repo, ".nightshift", "run");
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, ".gitignore"), "*\n");

  const report = { prs: [], issues: [], skipped: [], waiting: [], problems: [], cost: 0 };
  const finish = (headline) => summarize({ cfg, report, headline, runDir, env, dryRun });

  if (git(["status", "--porcelain"]).stdout.trim()) throw new Error("The working tree has uncommitted changes. Nightshift only runs on a clean checkout.");
  const startBranch = git(["rev-parse", "--abbrev-ref", "HEAD"]).stdout.trim();
  const startRef = startBranch === "HEAD" ? git(["rev-parse", "HEAD"]).stdout.trim() : startBranch;
  git(["fetch", "origin", cfg.baseBranch], { timeout: 180_000 });
  const baseRef = git(["rev-parse", "--verify", "--quiet", `origin/${cfg.baseBranch}`]).code === 0 ? `origin/${cfg.baseBranch}` : cfg.baseBranch;

  // Setup comes first: a source may be one of the project's own commands, which needs its dependencies.
  for (const cmd of cfg.setup) {
    const r = shell(cmd, { cwd: repo, env: cleanEnv(env), timeout: 15 * 60_000 });
    if (r.code !== 0) report.problems.push(`Setup command \`${cmd}\` failed: ${clip(r.stderr.trim() || r.stdout.trim(), 300)}`);
  }

  // 1. Listen.
  const { signals, counts, warnings } = await collectAll(cfg, { repo, env, fetch });
  report.counts = counts;
  report.problems.push(...warnings);
  log(`collected ${signals.length} signals`, JSON.stringify(counts));

  // 2. Remember.
  const history = fetchHistory(repo);
  if (!history.available) {
    if (!dryRun) throw new Error(`Cannot read past Nightshift work from GitHub (${history.error}). Stopping so nothing is opened twice.`);
    report.problems.push("GitHub history was not readable, so this dry run could not skip already handled signals.");
  }
  const { fresh, skipped } = filterNew(signals, history.items, cfg);
  report.skipped = skipped.map((s) => `${s.signal.title || s.signal.source}: ${s.why}`);
  writeFileSync(join(runDir, "signals.json"), JSON.stringify(fresh, null, 1));
  if (!fresh.length) return finish("Quiet night. Nothing new came in.");

  const notesFile = join(repo, ".nightshift", "notes.md");
  const notes = existsSync(notesFile) ? clip(readFileSync(notesFile, "utf8"), 6000) : "";
  const memory = lessons(history.items);
  const byId = new Map(fresh.map((s) => [s.id, s]));

  // 3. Think.
  const triage = askClaude({ cwd: repo, cfg, env, schema: TRIAGE_SCHEMA, tools: READ_TOOLS, allowed: READ_TOOLS, prompt: triagePrompt({ cfg, signals: fresh, openWork: openWork(history.items), lessons: memory, notes }) });
  report.cost += triage.cost || 0;
  if (!triage.ok) { report.problems.push(`Triage failed: ${triage.error}`); return finish("Nightshift could not triage tonight."); }
  const items = (triage.data.items || [])
    .map((it) => ({ ...it, signalIds: (it.signalIds || []).filter((id) => byId.has(id)) }))
    .filter((it) => it.signalIds.length)
    .sort((a, b) => b.severity - a.severity);
  writeFileSync(join(runDir, "triage.json"), JSON.stringify(items, null, 1));
  for (const it of items.filter((i) => i.action === "skip")) report.skipped.push(`${it.title}: ${it.reason}`);

  if (!dryRun) gh(["label", "create", LABEL, "--color", "1F2937", "--description", "Opened by Nightshift", "--force"]);

  const allowed = [...READ_TOOLS, "Edit", "Write", ...cfg.checks.flatMap((c) => [`Bash(${c})`, `Bash(${c} *)`])];
  const tools = [...READ_TOOLS, "Edit", "Write", ...(cfg.checks.length ? ["Bash"] : [])];
  const reset = () => { git(["reset", "--hard", "--quiet"]); git(["clean", "-fd", "--quiet"]); };
  const runChecks = () => cfg.checks.map((cmd) => {
    const r = shell(cmd, { cwd: repo, env: cleanEnv(env), timeout: 20 * 60_000 });
    return { cmd, ok: r.code === 0, output: clip((r.stdout + "\n" + r.stderr).trim().split("\n").slice(-40).join("\n"), 3000) };
  });
  const staged = () => {
    git(["add", "-A"]);
    const files = git(["diff", "--cached", "--name-only", "--no-renames"]).stdout.split("\n").filter(Boolean);
    const lines = git(["diff", "--cached", "--numstat"]).stdout.split("\n").filter(Boolean).reduce((n, l) => n + (parseInt(l.split("\t")[0]) || 0) + (parseInt(l.split("\t")[1]) || 0), 0);
    return { files, lines };
  };

  const openIssue = (item, sigs, fix, why) => {
    if (report.issues.length >= cfg.maxIssuesPerRun) { report.waiting.push(`${item.title} (issue limit reached, it will come up again next run)`); return; }
    const footer = marker(item.signalIds);
    const body = issueBody({ cfg, item, signals: sigs, fix, why, footer });
    const file = join(runDir, `issue-${slug(item.title)}.md`);
    writeFileSync(file, body);
    if (dryRun) { report.issues.push({ title: item.title, url: `(dry run) ${file}` }); return; }
    // If every signal is an issue someone already filed, answer there instead of opening a twin.
    const own = sigs.every((s) => s.issue) ? sigs[0].issue : null;
    if (own) {
      const c = gh(["issue", "comment", String(own), "--body-file", file]);
      gh(["issue", "edit", String(own), "--add-label", LABEL]);
      if (c.code === 0) report.issues.push({ title: item.title, url: `commented on #${own}` });
      else report.problems.push(`Could not comment on #${own}: ${c.stderr.trim()}`);
      return;
    }
    const args = ["issue", "create", "--title", item.title, "--body-file", file, "--label", LABEL];
    let r = gh(cfg.reviewer ? [...args, "--assignee", cfg.reviewer] : args);
    if (r.code !== 0 && cfg.reviewer) r = gh(args);
    if (r.code === 0) report.issues.push({ title: item.title, url: r.stdout.trim().split("\n").pop() });
    else report.problems.push(`Could not open an issue for "${item.title}": ${r.stderr.trim()}`);
  };

  // 4. Fix, one problem per branch.
  for (const item of items.filter((i) => i.action === "fix")) {
    const sigs = item.signalIds.map((id) => byId.get(id));
    if (report.prs.length >= cfg.maxPrsPerRun) { report.waiting.push(`${item.title} (pull request limit reached, it will come up again next run)`); continue; }
    const branch = `nightshift/${slug(item.title)}-${hash(item.signalIds.join(","))}`.slice(0, 80);
    if (git(["switch", "--quiet", "-C", branch, baseRef]).code !== 0) { report.problems.push(`Could not create branch ${branch}.`); continue; }
    log(`fixing: ${item.title}`);

    let fix, checkResults = [], rejected = "", broke = "";
    for (let attempt = 0; attempt < 2; attempt++) {
      const failed = checkResults.find((c) => !c.ok);
      const a = askClaude({ cwd: repo, cfg, env, schema: FIX_SCHEMA, tools, allowed, prompt: fixPrompt({ cfg, item, signals: sigs, lessons: memory, notes, retry: failed && `${failed.cmd}\n${failed.output}` }) });
      report.cost += a.cost || 0;
      if (!a.ok) { broke = `The fix step for "${item.title}" did not finish: ${a.error}`; break; }
      fix = a.data;
      const diff = staged();
      const bad = diff.files.filter((f) => matchesAny(f, cfg.protectedPaths));
      if (!fix.fixed || !diff.files.length) { rejected = "Nightshift could not establish the cause well enough to change code."; break; }
      if (bad.length) { rejected = `The change touched protected paths (${bad.join(", ")}), so it was thrown away.`; break; }
      if (diff.lines > cfg.maxChangedLines) { rejected = `The change was ${diff.lines} lines, over the ${cfg.maxChangedLines} line limit for unattended work.`; break; }
      checkResults = runChecks();
      const stillFailing = checkResults.find((c) => !c.ok);
      if (!stillFailing) break;
      if (attempt === 1) rejected = `A fix was written but \`${stillFailing.cmd}\` still fails with it:\n\n\`\`\`\n${stillFailing.output}\n\`\`\``;
    }

    if (rejected || broke) {
      reset();
      git(["switch", "--quiet", "-f", startRef]);
      git(["branch", "-D", "--quiet", branch]);
      // A tooling failure is not a finding. Say so and let the signal come back next run.
      if (broke) report.problems.push(broke);
      else openIssue(item, sigs, fix, rejected);
      continue;
    }

    staged(); // the checks may have left files behind; make sure the index is what we ship
    const footer = marker(item.signalIds);
    const body = prBody({ cfg, item, signals: sigs, fix, checkResults, footer });
    const file = join(runDir, `pr-${slug(item.title)}.md`);
    writeFileSync(file, body);
    const title = clip(fix.title || item.title, 90).replace(/\n.*/s, "");
    const commit = git([...WHO, "commit", "--quiet", "-m", `${title}\n\n${item.evidence}\n\nOpened by Nightshift.`]);
    if (commit.code !== 0) { report.problems.push(`Could not commit "${title}": ${commit.stderr.trim()}`); reset(); git(["switch", "--quiet", "-f", startRef]); continue; }
    git(["switch", "--quiet", "-f", startRef]);

    if (dryRun) { report.prs.push({ title, url: `(dry run) branch ${branch}, description in ${file}` }); continue; }
    const push = git([...pushAuth(repo, env), "push", "--force", "--quiet", "origin", `${branch}:${branch}`], { timeout: 300_000 });
    if (push.code !== 0) { report.problems.push(`Could not push ${branch}: ${push.stderr.trim()}`); continue; }
    const args = ["pr", "create", "--base", cfg.baseBranch, "--head", branch, "--title", title, "--body-file", file, "--label", LABEL];
    if (fix.confidence === "low") args.push("--draft");
    let pr = gh(cfg.reviewer ? [...args, "--reviewer", cfg.reviewer, "--assignee", cfg.reviewer] : args);
    // You cannot request a review from the account that opened the pull request. The @mention still reaches them.
    if (pr.code !== 0 && cfg.reviewer) pr = gh(args);
    if (pr.code === 0) report.prs.push({ title, url: pr.stdout.trim().split("\n").pop() });
    else report.problems.push(`Pushed ${branch} but could not open the pull request: ${pr.stderr.trim()}${/not permitted|not allowed/i.test(pr.stderr) ? ' Turn on "Allow GitHub Actions to create and approve pull requests" in the repository settings.' : ""}`);
  }

  // 5. Report what needs a human.
  for (const item of items.filter((i) => i.action === "report")) openIssue(item, item.signalIds.map((id) => byId.get(id)), null, item.reason);

  git(["switch", "--quiet", "-f", startRef]);
  const n = report.prs.length, m = report.issues.length;
  return finish(n || m ? `Nightshift opened ${n} pull request${n === 1 ? "" : "s"} and ${m} issue${m === 1 ? "" : "s"}.` : "Nightshift looked at tonight's signals and found nothing worth your time.");
}

/** In CI, push with the token from the environment so it never has to sit in .git/config. */
function pushAuth(repo, env) {
  const token = env.GH_TOKEN || env.GITHUB_TOKEN;
  const url = run("git", ["remote", "get-url", "origin"], { cwd: repo }).stdout.trim();
  if (!token || !/^https:\/\/github\.com\//.test(url)) return [];
  const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
  return ["-c", `http.https://github.com/.extraheader=AUTHORIZATION: basic ${basic}`];
}

function summarize({ cfg, report, headline, runDir, env, dryRun }) {
  const list = (title, rows) => (rows.length ? `\n### ${title}\n${rows.map((r) => `- ${r}`).join("\n")}\n` : "");
  const heard = Object.entries(report.counts || {}).map(([k, v]) => `${k}: ${v}`).join(", ") || "nothing";
  const md = `## ${headline}${dryRun ? " (dry run, nothing was pushed)" : ""}

Heard from ${heard}.
${list("Pull requests", report.prs.map((p) => `${p.title}: ${p.url}`))}${list("Issues", report.issues.map((p) => `${p.title}: ${p.url}`))}${list("Left for next run", report.waiting)}${list("Skipped", report.skipped.slice(0, 30))}${list("Problems", report.problems)}${report.cost ? `\nModel spend this run: about $${report.cost.toFixed(2)}.\n` : ""}`;
  writeFileSync(join(runDir, "summary.md"), md);
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, md);
  console.log("\n" + md);
  return { ...report, headline, ok: report.problems.length === 0 };
}
