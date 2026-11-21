import { signal } from "../signals.mjs";
import { daysAgo } from "../util.mjs";

/** Public App Store reviews. Needs only the app's numeric id, no keys. */
export async function collect(cfg, ctx) {
  const opt = cfg.sources.appStoreReviews;
  const id = cfg.app.appStoreId;
  if (!id) return [];
  const since = daysAgo(opt.lookbackDays);
  const out = [];
  for (const cc of cfg.app.countries) {
    const url = `https://itunes.apple.com/${cc}/rss/customerreviews/id=${id}/sortBy=mostRecent/json`;
    const res = await ctx.fetch(url);
    if (!res.ok) { ctx.warn(`App Store reviews (${cc}): HTTP ${res.status}`); continue; }
    let entries = (await res.json())?.feed?.entry || [];
    if (!Array.isArray(entries)) entries = [entries];
    for (const e of entries) {
      const rating = Number(e["im:rating"]?.label);
      if (!rating || rating > opt.maxRating) continue;
      const date = e.updated?.label;
      if (date && new Date(date) < since) continue;
      out.push(signal({
        source: "appstore",
        kind: "review",
        key: e.id?.label,
        title: e.title?.label,
        body: e.content?.label,
        rating,
        appVersion: e["im:version"]?.label,
        date,
        country: cc,
      }));
    }
  }
  return out;
}
