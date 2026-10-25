"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Send, Lock, ExternalLink, Loader2 } from "lucide-react";
import { useApply } from "@/components/apply/apply-provider";

/** Where Apply goes: applyTarget() in lib/apply/apply-target.mjs, computed on the server. */
export type ApplyTargetProp =
  | { kind: "none" }
  | { kind: "proxy"; host: string; url?: string; boardUrl?: string; boardHost?: string }
  | { kind: "direct"; host: string; easyApply?: boolean }
  | { kind: "resolve"; host: string };

// The "Apply" CTA. Brand fill only when the score is at/above the apply line
// and legitimacy is not caution (#4206). Disabled only when the report has no
// application URL: a tailored CV is never a prerequisite, the user decides
// when to apply. On click it opens the apply form-proxy for the offer (where
// the user reviews and submits it themselves — never auto-submit).
//
// A LinkedIn posting opens the proxy on the EMPLOYER's form when the crawl (or
// linkedin-apply.mjs) read the URL behind "Apply on company website"; the
// LinkedIn link stays beside it. Not read yet: the button looks it up first.
// Easy Apply, and other login-gated boards, open in the user's own browser,
// because the proxy's browser is signed out.
export function ApplyButton({
  n,
  url,
  company,
  quiet = false,
  target,
}: {
  n: string;
  url?: string;
  company: string;
  quiet?: boolean;
  target?: ApplyTargetProp;
}) {
  const router = useRouter();
  const apply = useApply();
  const [looking, setLooking] = useState(false);
  const [lookup, setLookup] = useState<{ error?: string; easyApply?: boolean } | null>(null);

  const hasUrl = !!url && /^https?:\/\//i.test(url);
  const t: ApplyTargetProp = target ?? (hasUrl ? { kind: "proxy", host: "" } : { kind: "none" });

  const look = quiet
    ? "inline-flex items-center justify-center gap-1.5 rounded-full border border-border bg-transparent px-3.5 py-1 text-xs font-medium text-muted transition-colors hover:border-foreground/20 hover:text-foreground max-sm:min-h-[44px]"
    : "inline-flex items-center justify-center gap-1.5 rounded-full bg-brand px-3.5 py-1 text-xs font-medium text-brand-foreground shadow-sm transition-colors hover:bg-brand-200 max-sm:min-h-[44px]";
  const subtle = "inline-flex items-center gap-1 text-xs text-muted transition-colors hover:text-brand";

  // n + from ride along so the Apply page can mark this row Applied, return the
  // user to the page they left, and resolve THIS report's own tailored CV rather
  // than the newest one for the company. Read straight off the handler's own
  // location: usePathname() drops the query and hash, which is where the list
  // filter and the row anchor live.
  const openProxy = (formUrl: string) => {
    const { pathname, search, hash } = window.location;
    apply.open(formUrl, { prefill: true, company, n, from: `${pathname}${search}${hash}` });
    router.push("/apply");
  };

  if (!hasUrl || t.kind === "none") {
    return (
      <button
        type="button"
        disabled
        title="No application URL on this report"
        className="inline-flex cursor-not-allowed items-center justify-center gap-1.5 rounded-full border border-border bg-surface/40 px-3.5 py-1 text-xs font-medium text-faint max-sm:min-h-[44px]"
      >
        <Lock className="size-3.5" /> Apply
      </button>
    );
  }

  const boardLink = (href: string, host: string, label = host) => (
    <a href={href} target="_blank" rel="noopener noreferrer" className={look}>
      <ExternalLink className="size-3.5" /> {label}
    </a>
  );

  if (t.kind === "direct" || lookup?.easyApply) {
    const host = t.kind === "proxy" ? "" : t.host;
    const easy = lookup?.easyApply || (t.kind === "direct" && t.easyApply);
    return (
      <span
        title={
          easy
            ? "This posting uses LinkedIn Easy Apply: the application happens on LinkedIn itself, so it opens there."
            : `Opens the posting on ${host || "the job board"} in your browser. Job boards show their Apply flow only when you're signed in, so career-ops can't read or pre-fill it. If the employer has its own careers page, applying there is better.`
        }
      >
        {boardLink(url!, host, easy ? `Easy Apply on ${host || "linkedin.com"}` : `Apply on ${host || "job board"}`)}
      </span>
    );
  }

  if (t.kind === "resolve") {
    return (
      <span className="inline-flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={looking}
          onClick={async () => {
            setLooking(true);
            setLookup(null);
            try {
              const r = await fetch("/api/apply/linkedin-resolve", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url }) });
              const d = await r.json().catch(() => ({}));
              if (r.ok && d.applyUrl) return openProxy(d.applyUrl);
              if (r.ok && d.kind === "easy-apply") return setLookup({ easyApply: true });
              setLookup({ error: d.error || "The employer's form could not be found." });
            } catch {
              setLookup({ error: "The lookup did not finish. Try again in a moment." });
            } finally {
              setLooking(false);
            }
          }}
          className={look}
          title={`Looks up the employer's own application form behind this ${t.host} posting (one page in your signed-in crawl profile), then opens it pre-filled. You review and submit yourself.`}
        >
          {looking ? <Loader2 className="size-3.5 animate-spin" /> : <Send className="size-3.5" />}
          {looking ? "Finding the employer's form…" : "Apply"}
        </button>
        {lookup?.error && (
          <span className="inline-flex flex-wrap items-center gap-2 text-xs text-amber-700 dark:text-amber-400">
            {lookup.error}
            <a href={url} target="_blank" rel="noopener noreferrer" className={subtle}>
              Open on {t.host} <ExternalLink className="size-3" />
            </a>
          </span>
        )}
      </span>
    );
  }

  // proxy: the posting's own URL, or the employer form behind a LinkedIn posting
  const formUrl = t.url ?? url!;
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <button
        type="button"
        onClick={() => openProxy(formUrl)}
        className={look}
        title={
          t.boardUrl
            ? `Apply — opens the employer's own form (${t.host}) pre-filled; you review and submit yourself`
            : quiet
              ? "Apply — below the apply line or caution; opens the form pre-filled, you review and submit yourself"
              : "Apply — opens the form pre-filled, you review and submit yourself"
        }
      >
        <Send className="size-3.5" /> Apply
      </button>
      {t.boardUrl && (
        <a href={t.boardUrl} target="_blank" rel="noopener noreferrer" className={subtle} title="The posting on LinkedIn">
          {t.boardHost ?? "posting"} <ExternalLink className="size-3" />
        </a>
      )}
    </span>
  );
}
