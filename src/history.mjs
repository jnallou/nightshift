import { run, clip } from "./util.mjs";
import { LABEL } from "./collectors/local.mjs";

/**
 * Nightshift keeps no database. Its memory is GitHub itself: every pull request and
 * issue it opens carries a hidden marker listing the signals it covers, and what the
 * reviewer did with it (merged, closed, commented) is the lesson for next time.
 */
export const marker = (ids) => `<!-- nightshift:signals ${ids.join(" ")} -->`;
export const readMarker = (body) => {
  const m = /<!-- nightshift:signals ([^>]*?)-->/.exec(body || "");
  return m ? m[1].trim().split(/\s+/).filter(Boolean) : [];
};

const human = (c) => c?.body?.trim() && !/\[bot\]$|^github-actions$/.test(c.author?.login || c.user?.login || "");

export function fetchHistory(repo) {
  const prs = run("gh", ["pr", "list", "--label", LABEL, "--state", "all", "--limit", "60", "--json", "number,title,state,body,mergedAt,closedAt,createdAt,url,reviews,comments"], { cwd: repo });
  const issues = run("gh", ["issue", "list", "--label", LABEL, "--state", "all", "--limit", "60", "--json", "number,title,state,stateReason,body,closedAt,createdAt,url,comments"], { cwd: repo });
  if (prs.code !== 0 || issues.code !== 0) return { available: false, items: [], error: (prs.stderr || issues.stderr).trim().split("\n")[0] };
  const items = [];
  let inlineBudget = 8;
  for (const p of JSON.parse(prs.stdout || "[]")) {
    const state = p.state === "MERGED" ? "merged" : p.state === "CLOSED" ? "declined" : "open";
    const feedback = [...(p.reviews || []), ...(p.comments || [])].filter(human).map((c) => c.body.trim());
    if (state !== "open" && inlineBudget-- > 0) {
      const r = run("gh", ["api", `repos/{owner}/{repo}/pulls/${p.number}/comments`], { cwd: repo });
      if (r.code === 0) for (const c of JSON.parse(r.stdout || "[]")) if (human(c)) feedback.push(`On ${c.path}: ${c.body.trim()}`);
    }
    items.push({ type: "pr", number: p.number, title: p.title, url: p.url, state, at: p.mergedAt || p.closedAt || p.createdAt, signalIds: readMarker(p.body), feedback });
  }
  for (const i of JSON.parse(issues.stdout || "[]")) {
    const state = i.state === "OPEN" ? "open" : i.stateReason === "NOT_PLANNED" ? "declined" : "closed";
    items.push({ type: "issue", number: i.number, title: i.title, url: i.url, state, at: i.closedAt || i.createdAt, signalIds: readMarker(i.body), feedback: (i.comments || []).filter(human).map((c) => c.body.trim()) });
  }
  return { available: true, items };
}

/** Drop signals that were already handled. Returns what is new and why the rest was skipped. */
export function filterNew(signals, items, cfg) {
  const newest = new Map();
  for (const it of [...items].sort((a, b) => new Date(a.at) - new Date(b.at))) for (const id of it.signalIds) newest.set(id, it);
  const fresh = [], skipped = [];
  for (const s of signals) {
    const it = newest.get(s.id);
    const ref = it && `#${it.number}`;
    if (!it) fresh.push(s);
    else if (it.state === "open") skipped.push({ signal: s, why: `already covered by open ${ref}` });
    else if (it.state === "declined") skipped.push({ signal: s, why: `you closed ${ref} without taking it` });
    else {
      const cutoff = new Date(it.at).getTime() + cfg.regressionGraceDays * 86_400_000;
      if (s.date && new Date(s.date).getTime() > cutoff) fresh.push({ ...s, seenAgainAfter: `${ref} (${it.state} ${String(it.at).slice(0, 10)})` });
      else skipped.push({ signal: s, why: `handled in ${ref}` });
    }
  }
  return { fresh, skipped };
}

export function openWork(items) {
  return items.filter((i) => i.state === "open").map((i) => `- #${i.number} (${i.type}) ${i.title}`).join("\n") || "None.";
}

/** What the reviewer did with past work, newest first. This is how Nightshift improves. */
export function lessons(items) {
  const past = items.filter((i) => i.type === "pr" && i.state !== "open" || i.feedback.length).sort((a, b) => new Date(b.at) - new Date(a.at)).slice(0, 20);
  if (!past.length) return "No history yet. This is an early run.";
  return past.map((i) => {
    const verdict = i.type === "pr" ? (i.state === "merged" ? "MERGED" : i.state === "declined" ? "CLOSED WITHOUT MERGING" : "OPEN") : i.state.toUpperCase();
    const said = i.feedback.length ? "\n" + i.feedback.slice(0, 6).map((f) => `    reviewer said: ${clip(f.replace(/\s+/g, " "), 400)}`).join("\n") : "";
    return `- #${i.number} ${verdict}: ${i.title}${said}`;
  }).join("\n");
}
