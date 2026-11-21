import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { signal } from "../signals.mjs";
import { run, shell, clip } from "../util.mjs";

export const LABEL = "nightshift";

/** Open GitHub issues that people (not Nightshift) filed. */
export async function githubIssues(cfg, ctx) {
  const want = cfg.sources.githubIssues.labels || [];
  const r = run("gh", ["issue", "list", "--state", "open", "--limit", "60", "--json", "number,title,body,labels,updatedAt,url"], { cwd: ctx.repo });
  if (r.code !== 0) { ctx.warn(`GitHub issues: ${r.stderr.trim().split("\n")[0]}`); return []; }
  return JSON.parse(r.stdout || "[]")
    .filter((i) => {
      const names = i.labels.map((l) => l.name.toLowerCase());
      return !names.includes(LABEL) && (want.length === 0 || want.some((w) => names.includes(w.toLowerCase())));
    })
    .map((i) => signal({ source: "github", kind: "issue", key: i.number, title: i.title, body: i.body, url: i.url, issue: i.number, date: i.updatedAt }));
}

function fromObject(source, o, fallbackTitle) {
  const title = o.title || o.message || o.summary || o.textPayload || o.error || fallbackTitle;
  const body = o.body || o.description || o.steps || o.stack || JSON.stringify(o, null, 1);
  return signal({ source, kind: o.kind || "note", key: o.id || o.key, title, body, count: o.count, appVersion: o.appVersion || o.version, date: o.date || o.timestamp });
}

/** Anything dropped into .nightshift/inbox: exported logs, a pasted email, a JSON list of reports. */
export async function inbox(cfg, ctx) {
  const dir = join(ctx.repo, ".nightshift", "inbox");
  if (!existsSync(dir)) return [];
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const file = join(dir, name);
    if (name === "README.md" || name.startsWith(".") || !statSync(file).isFile()) continue;
    const text = readFileSync(file, "utf8");
    if (name.endsWith(".json")) {
      try {
        const data = JSON.parse(text);
        for (const o of Array.isArray(data) ? data : [data]) out.push(fromObject(`inbox/${name}`, o, name));
        continue;
      } catch { /* fall through and treat as text */ }
    }
    out.push(signal({ source: `inbox/${name}`, kind: "note", title: name, body: clip(text, 6000) }));
  }
  return out;
}

/** Your own commands. Print JSON (an array of objects) or plain text such as log lines. */
export async function commands(cfg, ctx) {
  const out = [];
  for (const c of cfg.sources.commands || []) {
    if (!c?.run) continue;
    const name = c.name || "command";
    const r = shell(c.run, { cwd: ctx.repo, env: ctx.env, timeout: 180_000 });
    if (r.code !== 0) { ctx.warn(`Command "${name}" exited ${r.code}: ${r.stderr.trim().split("\n")[0]}`); continue; }
    const text = r.stdout.trim();
    if (!text) continue;
    try {
      const data = JSON.parse(text);
      for (const o of (Array.isArray(data) ? data : [data]).slice(0, 40)) out.push(fromObject(name, o, name));
    } catch {
      out.push(signal({ source: name, kind: c.kind || "log", title: `Output of ${name}`, body: clip(text, 6000) }));
    }
  }
  return out;
}
