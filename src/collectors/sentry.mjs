import { signal } from "../signals.mjs";

/** Pull the stack out of a Sentry event. Native crashes keep it under "threads". */
export function stackOf(event) {
  const entries = event?.entries || [];
  const ex = entries.find((e) => e.type === "exception")?.data?.values || [];
  const threads = entries.find((e) => e.type === "threads")?.data?.values || [];
  const pick = ex.find((v) => v.stacktrace?.frames?.length) || threads.find((t) => t.crashed && t.stacktrace?.frames?.length) || threads.find((t) => t.stacktrace?.frames?.length);
  if (!pick) return "";
  const all = pick.stacktrace.frames;
  const mine = all.filter((f) => f.inApp);
  const use = (mine.length ? mine : all).slice(-14).reverse();
  const head = pick.type ? `${pick.type}: ${pick.value || ""}\n` : "";
  return head + use.map((f) => `  at ${f.function || "?"} (${f.filename || f.module || f.absPath || "?"}${f.lineNo ? ":" + f.lineNo : ""})`).join("\n");
}

export async function collect(cfg, ctx) {
  const { host, org, project } = cfg.sources.sentry;
  const token = ctx.env.SENTRY_AUTH_TOKEN;
  if (!token || !org || !project) {
    ctx.warn("Sentry is on but SENTRY_AUTH_TOKEN, sources.sentry.org or sources.sentry.project is missing.");
    return [];
  }
  const get = async (path) => {
    const res = await ctx.fetch(host + path, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`Sentry HTTP ${res.status}`);
    return res.json();
  };
  const q = new URLSearchParams({ project, query: "is:unresolved", statsPeriod: "14d", sort: "freq", limit: "25" });
  const issues = await get(`/api/0/organizations/${org}/issues/?${q}`);
  const out = [];
  for (const [i, it] of issues.entries()) {
    let stack;
    if (i < 8) {
      try { stack = stackOf(await get(`/api/0/organizations/${org}/issues/${it.id}/events/latest/`)); } catch (e) { ctx.warn(`Sentry event for ${it.shortId}: ${e.message}`); }
    }
    out.push(signal({
      source: "sentry", kind: it.level === "fatal" ? "crash" : "error", key: it.id, title: it.title,
      body: it.culprit ? `In ${it.culprit}` : "", count: Number(it.count) || undefined, users: it.userCount,
      firstSeen: it.firstSeen, date: it.lastSeen, url: it.permalink, stack,
    }));
  }
  return out;
}
