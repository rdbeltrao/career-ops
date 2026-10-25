"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { CalendarClock, ExternalLink, Loader2, LogIn, Pencil, Plus, ShieldAlert, ShieldCheck } from "lucide-react";
import { cn } from "@/lib/cn";
import type { LinkedInState, SearchView, SessionState } from "@/lib/linkedin-settings";

const SESSION_LOOK: Record<SessionState, { label: string; tone: string; ok: boolean }> = {
  "signed-in": { label: "Signed in", tone: "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400", ok: true },
  "sign-in-needed": { label: "Sign-in needed", tone: "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400", ok: false },
  expired: { label: "Session expired", tone: "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400", ok: false },
  "signed-out": { label: "Not signed in", tone: "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400", ok: false },
  "no-profile": { label: "Not set up", tone: "border-border bg-surface-hover text-muted", ok: false },
  unknown: { label: "Unknown", tone: "border-border bg-surface-hover text-muted", ok: false },
};

const ENGINE_LABEL: Record<string, string> = { portals: "Portals + LinkedIn", linkedin: "LinkedIn only" };

function when(iso?: string) {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

type Draft = { name: string; searchUrl: string; maxPages: string; maxApplyLookups: string };
const EMPTY: Draft = { name: "LinkedIn ", searchUrl: "", maxPages: "3", maxApplyLookups: "" };

export function LinkedInView({ initial }: { initial: LinkedInState }) {
  const [state, setState] = useState(initial);
  const [editing, setEditing] = useState<string | null>(null); // a search name, or "" for a new one
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState("");
  const [rowError, setRowError] = useState("");
  const [signIn, setSignIn] = useState<{ waiting: boolean; error: string }>({ waiting: false, error: "" });
  const poll = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = useCallback(async () => {
    try {
      const r = await fetch("/api/linkedin", { cache: "no-store" });
      if (r.ok) setState(await r.json());
    } catch {
      /* keep the last state */
    }
  }, []);

  useEffect(() => () => {
    if (poll.current) clearInterval(poll.current);
  }, []);

  // While a sign-in window is open, look again every few seconds until the
  // profile is signed in and released, for up to five minutes.
  useEffect(() => {
    if (!signIn.waiting) return;
    const started = Date.now();
    poll.current = setInterval(async () => {
      await refresh();
      if (Date.now() - started > 5 * 60_000) setSignIn({ waiting: false, error: "" });
    }, 4000);
    return () => {
      if (poll.current) clearInterval(poll.current);
    };
  }, [signIn.waiting, refresh]);
  useEffect(() => {
    if (signIn.waiting && state.session?.state === "signed-in" && !state.session.busy) setSignIn({ waiting: false, error: "" });
  }, [signIn.waiting, state.session]);

  async function startSignIn() {
    setSignIn({ waiting: false, error: "" });
    try {
      const r = await fetch("/api/linkedin/sign-in", { method: "POST" });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) return setSignIn({ waiting: false, error: d.error || "The sign-in window could not be opened." });
      setSignIn({ waiting: true, error: "" });
    } catch {
      setSignIn({ waiting: false, error: "The sign-in window could not be opened." });
    }
  }

  async function send(body: unknown): Promise<string | null> {
    const r = await fetch("/api/linkedin/searches", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) return d.error || "portals.yml was not changed.";
    setState(d);
    return null;
  }

  async function toggle(s: SearchView) {
    setRowError("");
    const err = await send({ op: "toggle", name: s.name, enabled: !s.enabled });
    if (err) setRowError(err);
  }

  function openEditor(s?: SearchView) {
    setFormError("");
    setEditing(s ? s.name : "");
    setDraft(s ? { name: s.name, searchUrl: s.searchUrl, maxPages: String(s.maxPages ?? 3), maxApplyLookups: s.maxApplyLookups === null ? "" : String(s.maxApplyLookups) } : EMPTY);
  }

  async function save() {
    setSaving(true);
    setFormError("");
    const search = { name: draft.name, searchUrl: draft.searchUrl, maxPages: draft.maxPages, maxApplyLookups: draft.maxApplyLookups, enabled: true };
    const body = editing ? { op: "update", name: editing, search: { ...search, enabled: state.searches.find((s) => s.name === editing)?.enabled ?? true } } : { op: "add", search };
    const err = await send(body);
    setSaving(false);
    if (err) setFormError(err);
    else setEditing(null);
  }

  const session = state.session;
  const look = session ? SESSION_LOOK[session.state] : null;
  const crawl = state.crawl;
  const input = "w-full rounded-lg border border-border bg-surface/60 px-3 py-2 text-sm outline-none transition focus:border-brand/60 focus:ring-2 focus:ring-brand/20";

  return (
    <div className="space-y-8">
      {state.error && (
        <p role="alert" className="rounded-xl border border-rose-500/40 bg-rose-500/10 p-3 text-sm text-rose-600 dark:text-rose-400">
          {state.error}
        </p>
      )}

      {/* ── Session ── */}
      <section aria-labelledby="li-session" className="rounded-xl border border-border bg-surface/40 p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 id="li-session" className="flex items-center gap-2 text-sm font-semibold text-foreground">
            {look?.ok ? <ShieldCheck className="size-4 text-emerald-600" /> : <ShieldAlert className="size-4 text-amber-600" />}
            Crawl browser session
          </h2>
          {look && <span className={cn("rounded-full border px-2.5 py-0.5 text-xs font-medium", look.tone)}>{look.label}</span>}
        </div>
        {session ? (
          <div className="mt-2 space-y-1 text-sm text-muted">
            <p>{session.message}</p>
            {session.signedInAt && (
              <p className="text-xs text-faint">
                Signed in {when(session.signedInAt)}
                {session.expiresAt ? ` · LinkedIn's cookie runs until ${when(session.expiresAt)}` : ""}
              </p>
            )}
            {session.busy && <p className="text-xs text-amber-700 dark:text-amber-400">A scan or a sign-in window is using the profile right now.</p>}
          </div>
        ) : (
          <p className="mt-2 text-sm text-muted">This career-ops checkout has no LinkedIn session support (lib/linkedin-session.mjs).</p>
        )}
        <div className="mt-3 border-t border-border/70 pt-3 text-sm">
          <p className="text-xs font-medium uppercase tracking-wide text-faint">Last crawl</p>
          {crawl ? (
            <p className={cn("mt-1", crawl.result === "ok" ? "text-muted" : "text-amber-700 dark:text-amber-400")}>
              {when(crawl.at)} · {crawl.search || "a LinkedIn search"} ·{" "}
              {crawl.result === "ok" ? `${crawl.jobs ?? 0} new posting${crawl.jobs === 1 ? "" : "s"}` : crawl.result === "login-required" ? "LinkedIn asked for a login" : "failed"}
              {crawl.result !== "ok" && crawl.message ? <span className="block text-xs text-faint">{crawl.message}</span> : null}
            </p>
          ) : (
            <p className="mt-1 text-muted">No crawl recorded yet.</p>
          )}
        </div>
        {session && !look?.ok && (
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={startSignIn}
              aria-disabled={signIn.waiting}
              className="inline-flex items-center gap-1.5 rounded-full bg-brand px-4 py-2 text-sm font-medium text-brand-foreground transition-colors hover:bg-brand-200 max-sm:min-h-[44px]"
            >
              {signIn.waiting ? <Loader2 className="size-4 animate-spin" /> : <LogIn className="size-4" />} Sign in to LinkedIn
            </button>
            <span role="status" aria-live="polite" className="text-xs text-muted">
              {signIn.waiting ? "A LinkedIn window opened on this computer. Sign in there; this page updates when you are done." : signIn.error}
            </span>
          </div>
        )}
        {session && look?.ok && (
          <p className="mt-3 text-xs text-faint">
            Signed out later? Use <button type="button" onClick={startSignIn} className="underline hover:text-brand">sign in again</button>.
            <span role="status" aria-live="polite" className="ml-1">{signIn.waiting ? "A LinkedIn window opened on this computer." : signIn.error}</span>
          </p>
        )}
      </section>

      {/* ── Searches ── */}
      <section aria-labelledby="li-searches">
        <div className="flex items-center justify-between gap-3">
          <h2 id="li-searches" className="text-sm font-semibold text-foreground">
            Searches <span className="font-normal text-faint">({state.searches.filter((s) => s.enabled).length} on, {state.searches.length} total)</span>
          </h2>
          <button
            type="button"
            onClick={() => openEditor()}
            className="inline-flex items-center gap-1.5 rounded-full border border-border px-3 py-1.5 text-xs font-medium text-muted transition-colors hover:border-brand/40 hover:text-brand max-sm:min-h-[44px]"
          >
            <Plus className="size-3.5" /> Add search
          </button>
        </div>
        {rowError && <p role="alert" className="mt-2 text-xs text-rose-600 dark:text-rose-400">{rowError}</p>}

        {editing !== null && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
            className="mt-3 space-y-3 rounded-xl border border-brand/30 bg-brand-soft/30 p-4"
            aria-label={editing ? `Edit ${editing}` : "Add a LinkedIn search"}
          >
            <p className="text-xs text-muted">
              Run the search on LinkedIn with your filters (keywords, location, date posted, remote), then paste the address of the results page.
            </p>
            <label className="block text-sm">
              <span className="mb-1 block font-medium">Name</span>
              <input className={input} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} required maxLength={80} />
            </label>
            <label className="block text-sm">
              <span className="mb-1 block font-medium">Search URL</span>
              <input className={input} value={draft.searchUrl} onChange={(e) => setDraft({ ...draft, searchUrl: e.target.value })} required placeholder="https://www.linkedin.com/jobs/search/?keywords=…" inputMode="url" />
            </label>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block text-sm">
                <span className="mb-1 block font-medium">Result pages (25 jobs each)</span>
                <input className={input} type="number" min={1} max={10} value={draft.maxPages} onChange={(e) => setDraft({ ...draft, maxPages: e.target.value })} />
              </label>
              <label className="block text-sm">
                <span className="mb-1 block font-medium">Employer-link lookups</span>
                <input className={input} type="number" min={0} max={100} value={draft.maxApplyLookups} onChange={(e) => setDraft({ ...draft, maxApplyLookups: e.target.value })} placeholder="25 (default)" aria-describedby="li-lookups-help" />
                <span id="li-lookups-help" className="mt-1 block text-[11px] text-faint">Posting pages opened per run to read &quot;Apply on company website&quot; links. 0 turns it off.</span>
              </label>
            </div>
            {formError && <p role="alert" className="text-xs text-rose-600 dark:text-rose-400">{formError}</p>}
            <div className="flex gap-2">
              <button type="submit" aria-disabled={saving} className="inline-flex items-center gap-1.5 rounded-full bg-brand px-4 py-1.5 text-sm font-medium text-brand-foreground hover:bg-brand-200 max-sm:min-h-[44px]">
                {saving && <Loader2 className="size-4 animate-spin" />} {editing ? "Save" : "Add"}
              </button>
              <button type="button" onClick={() => setEditing(null)} className="rounded-full border border-border px-4 py-1.5 text-sm text-muted hover:text-foreground max-sm:min-h-[44px]">
                Cancel
              </button>
            </div>
          </form>
        )}

        {state.searches.length === 0 ? (
          <p className="mt-3 text-sm text-muted">{state.portalsFound ? "No LinkedIn searches yet. Add one to start." : "There is no portals.yml yet."}</p>
        ) : (
          <ul className="mt-3 space-y-2">
            {state.searches.map((s) => (
              <li key={s.name} className={cn("flex flex-wrap items-center gap-3 rounded-xl border border-border bg-surface/40 px-3.5 py-2.5", !s.enabled && "opacity-60")}>
                <button
                  type="button"
                  role="switch"
                  aria-checked={s.enabled}
                  aria-label={`${s.enabled ? "Turn off" : "Turn on"} ${s.name}`}
                  onClick={() => toggle(s)}
                  className={cn("relative h-5 w-9 shrink-0 rounded-full transition-colors", s.enabled ? "bg-brand" : "bg-border")}
                >
                  <span className={cn("absolute top-0.5 size-4 rounded-full bg-white shadow transition-all", s.enabled ? "left-[18px]" : "left-0.5")} />
                </button>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-foreground">{s.name}</p>
                  <p className="truncate text-xs text-muted">
                    {s.description
                      ? [s.description.keywords && `"${s.description.keywords}"`, s.description.posted, s.description.workplace.join(" / "), s.description.geoId && `location ${s.description.geoId}`].filter(Boolean).join(" · ")
                      : "unreadable URL"}
                    {" · "}
                    {s.maxPages ?? 3} page{(s.maxPages ?? 3) === 1 ? "" : "s"}
                    {s.maxApplyLookups === 0 ? " · no employer links" : s.maxApplyLookups ? ` · ${s.maxApplyLookups} employer links` : ""}
                  </p>
                </div>
                <a href={s.searchUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs text-muted hover:text-brand" aria-label={`Open ${s.name} on LinkedIn`}>
                  Open <ExternalLink className="size-3" />
                </a>
                <button type="button" onClick={() => openEditor(s)} className="inline-flex items-center gap-1 text-xs text-muted hover:text-brand" aria-label={`Edit ${s.name}`}>
                  <Pencil className="size-3" /> Edit
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* ── Schedules ── */}
      <section aria-labelledby="li-schedules">
        <h2 id="li-schedules" className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <CalendarClock className="size-4" /> Schedules that run these searches
        </h2>
        {state.schedules.length === 0 ? (
          <p className="mt-2 text-sm text-muted">
            No scheduled scan includes LinkedIn. In <Link href="/scheduled-scans" className="text-brand hover:underline">Scheduled scans</Link>, create one with
            the engine &quot;LinkedIn searches only&quot;, or &quot;Zero-Token Portals.yml&quot; to run them with the boards.
          </p>
        ) : (
          <ul className="mt-2 space-y-1.5 text-sm">
            {state.schedules.map((j) => (
              <li key={j.id} className="flex flex-wrap items-center gap-2 text-muted">
                <span className="font-medium text-foreground">{j.name}</span>
                <span className="rounded-full border border-border px-2 py-0.5 text-[11px]">{ENGINE_LABEL[j.engine] ?? j.engine}</span>
                <span>every {j.every} {j.unit}</span>
                {j.status !== "active" && <span className="text-amber-700 dark:text-amber-400">({j.status})</span>}
                {j.nextRunAt && <span className="text-xs text-faint">next {when(j.nextRunAt)}</span>}
              </li>
            ))}
          </ul>
        )}
        <p className="mt-2 text-xs text-faint">
          Any run of <code>node scan.mjs</code> also includes the searches that are on, including a daily job outside the app.
        </p>
      </section>
    </div>
  );
}
