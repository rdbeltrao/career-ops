"use client";

import { useRouter } from "next/navigation";
import { Send, Lock } from "lucide-react";
import { useApply } from "@/components/apply/apply-provider";

// The "Apply" CTA. Brand fill only when the score is at/above the apply line
// and legitimacy is not caution (#4206). Disabled only when the report has no
// application URL: a tailored CV is never a prerequisite, the user decides
// when to apply. On click it opens the apply form-proxy for the offer (where
// the user reviews and submits it themselves — never auto-submit).
export function ApplyButton({
  n,
  url,
  company,
  quiet = false,
}: {
  n: string;
  url?: string;
  company: string;
  quiet?: boolean;
}) {
  const router = useRouter();
  const apply = useApply();

  const hasUrl = !!url && /^https?:\/\//i.test(url);

  if (!hasUrl) {
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
  return (
    <button
      type="button"
      onClick={() => {
        // n + from ride along so the Apply page can mark this row Applied,
        // return the user to the page they left, and resolve THIS report's own
        // tailored CV rather than the newest one for the company. Read straight
        // off the handler's own location: usePathname() drops the query and
        // hash, which is where the list filter and the row anchor live.
        const { pathname, search, hash } = window.location;
        apply.open(url!, { prefill: true, company, n, from: `${pathname}${search}${hash}` });
        router.push("/apply");
      }}
      className={
        quiet
          ? "inline-flex items-center justify-center gap-1.5 rounded-full border border-border bg-transparent px-3.5 py-1 text-xs font-medium text-muted transition-colors hover:border-foreground/20 hover:text-foreground max-sm:min-h-[44px]"
          : "inline-flex items-center justify-center gap-1.5 rounded-full bg-brand px-3.5 py-1 text-xs font-medium text-brand-foreground shadow-sm transition-colors hover:bg-brand-200 max-sm:min-h-[44px]"
      }
      title={
        quiet
          ? "Apply — below the apply line or caution; opens the form pre-filled, you review and submit yourself"
          : "Apply — opens the form pre-filled, you review and submit yourself"
      }
    >
      <Send className="size-3.5" /> Apply
    </button>
  );
}
