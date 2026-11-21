import { collect as appStoreReviews } from "./collectors/appstore-reviews.mjs";
import { collect as appStoreConnect } from "./collectors/appstore-connect.mjs";
import { collect as sentry } from "./collectors/sentry.mjs";
import { githubIssues, inbox, commands } from "./collectors/local.mjs";
import { log } from "./util.mjs";

/** Run every source that is switched on. One broken source never stops the others. */
export async function collectAll(cfg, { repo, env = process.env, fetch = globalThis.fetch } = {}) {
  const warnings = [];
  const ctx = { repo, env, fetch, warn: (m) => { warnings.push(m); log("warning:", m); } };
  const s = cfg.sources;
  const jobs = [];
  // With App Store Connect on, it already returns the reviews, so skip the public feed.
  if (s.appStoreConnect.enabled) jobs.push(["App Store Connect", appStoreConnect]);
  else if (s.appStoreReviews.enabled) jobs.push(["App Store reviews", appStoreReviews]);
  if (s.sentry.enabled) jobs.push(["Sentry", sentry]);
  if (s.githubIssues.enabled) jobs.push(["GitHub issues", githubIssues]);
  if (s.inbox.enabled) jobs.push(["Inbox", inbox]);
  if ((s.commands || []).length) jobs.push(["Commands", commands]);

  const signals = [], counts = {}, seen = new Set();
  for (const [name, fn] of jobs) {
    let got = [];
    try { got = await fn(cfg, ctx); } catch (e) { ctx.warn(`${name} failed: ${e.message}`); }
    counts[name] = got.length;
    for (const g of got) if (!seen.has(g.id)) { seen.add(g.id); signals.push(g); }
  }
  return { signals, counts, warnings };
}
