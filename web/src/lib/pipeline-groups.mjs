import { applicationKey } from "./pipeline-status.mjs";
import { canonStatus } from "./status-alias.mjs";
import { normalizeUrl } from "./core/url-key.mjs";
import { postingHref } from "./posting-url.mjs";

const PLACEHOLDER = /^(?:see report|unknown|pending|tbd|n\/?a|none|null|[-—–?]*)$/i;

function textKey(value) {
  return String(value ?? "").normalize("NFC").trim().toLowerCase().replace(/\s+/g, " ");
}

function roleKey(value) {
  return textKey(value)
    .replace(/\(\s*(?:[mfwxd]\s*[/|]\s*){1,2}[mfwxd]\s*\)/g, " ")
    .replace(/[(),\-–—]+/g, " ")
    .replace(/\s+/g, " ").trim();
}

function linkedinPosting(url) {
  const { hostname, pathname } = new URL(url);
  return /^(?:[a-z]+\.)?linkedin\.com$/.test(hostname) && /^\/jobs\/view\//.test(pathname);
}

/**
 * Lossless display groups, not tracker deduplication. LinkedIn reposts and
 * employer listings with the same full title can share a collapsed row; every
 * original application remains available for expansion and individual edits.
 * Preserve seniority, team, geography, channel and status. Unknown titles and
 * employers never group. Two different employer URLs never group, including
 * through a LinkedIn row that would otherwise bridge separate requisitions.
 * Input is already filtered and sorted: the first row remains the visible one.
 * @template {{ n: string, company: string, role: string, date: string, report: string, status: string, url: string, location?: string, via?: string }} T
 * @param {T[]} rows
 * @returns {{ key: string, rows: T[] }[]}
 */
export function groupSimilarApplications(rows) {
  const groups = [];
  const buckets = new Map();
  for (const row of rows) {
    const company = textKey(row.company);
    const role = roleKey(row.role);
    const url = normalizeUrl(postingHref(row.url));
    const eligible = !PLACEHOLDER.test(company) && !PLACEHOLDER.test(role) && url;
    const key = JSON.stringify([company, role, textKey(row.location), textKey(row.via), canonStatus(row.status)]);
    const bucket = eligible ? buckets.get(key) ?? [] : [];
    const group = bucket.find((candidate) => candidate.urls.every((other) =>
      other === url || linkedinPosting(other) || linkedinPosting(url),
    ));
    if (group) {
      group.rows.push(row);
      group.urls.push(url);
    } else {
      const created = { key: applicationKey(row), rows: [row], urls: [url] };
      groups.push(created);
      if (eligible) {
        bucket.push(created);
        buckets.set(key, bucket);
      }
    }
  }
  return groups.map(({ key, rows }) => ({ key, rows }));
}
