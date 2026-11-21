import { hash, clip } from "./util.mjs";

/**
 * A signal is one piece of evidence that something is wrong or wanted:
 * a review, a crash group, a hang, a bug report, a log excerpt, a metric regression.
 *
 * `key` is whatever makes it stable across runs (a review id, a crash group id).
 * The id derived from it is how Nightshift remembers what it has already handled.
 */
export function signal({ source, kind, key, title, body = "", ...extra }) {
  const s = {
    id: hash(`${source}:${key ?? `${title}\n${body}`}`),
    source,
    kind,
    title: clip(String(title || "").trim(), 200),
    body: clip(String(body || "").trim(), 6000),
  };
  for (const [k, v] of Object.entries(extra)) {
    if (v !== undefined && v !== null && v !== "") s[k] = v;
  }
  return s;
}
