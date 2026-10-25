"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { cn } from "@/lib/cn";
import { CoMark } from "@/components/co-mark";
import { AssistantConsole } from "@/components/assistant-console";
import { MobileNav } from "@/components/mobile-nav";
import { ThemeToggle } from "@/components/theme-toggle";
import { BackToTop } from "@/components/back-to-top";
import { JobsProvider } from "@/components/jobs/job-store";
import { PipelineProvider } from "@/components/pipeline/pipeline-provider";
import { ApplyProvider } from "@/components/apply/apply-provider";
import { ExploreProvider } from "@/components/explore/explore-provider";
import { FirstScoreView } from "@/components/explore/first-score-view";
import { WorkerPills } from "@/components/jobs/worker-pills";
import { UsageMeter } from "@/components/usage-meter";
import { instrumentSerif } from "@/lib/fonts";
import { visibleNavItems, isActivePath } from "@/lib/nav-items";

export function AppShell({ children, followupsEnabled }: { children: React.ReactNode; followupsEnabled: boolean }) {
  const pathname = usePathname();
  const workspace = pathname === "/context" || pathname === "/cv";
  const [navigationExpanded, setNavigationExpanded] = useState(false);
  const compact = workspace && !navigationExpanded;

  useEffect(() => {
    if (!navigationExpanded) return;
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") setNavigationExpanded(false); };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [navigationExpanded]);

  return (
    <JobsProvider>
      <PipelineProvider>
      <ApplyProvider>
      <ExploreProvider>
      <MobileNav followupsEnabled={followupsEnabled} />
      <div className="flex min-h-screen">
        {workspace && navigationExpanded && <button type="button" tabIndex={-1} aria-label="Close app navigation" onClick={() => setNavigationExpanded(false)} className="fixed inset-0 z-30 hidden cursor-default bg-black/10 md:block" />}
        {/* JUDGMENT: Workspace routes keep a fixed rail footprint. Expanded app
            navigation overlays the workspace so the document and editor never squeeze. */}
        <aside aria-label="App sidebar" className={cn("sticky top-0 hidden h-screen shrink-0 md:block", workspace ? "z-40 w-[72px]" : "w-60")}>
          <div className={cn("flex h-full flex-col overflow-y-auto border-r border-border", workspace && navigationExpanded ? "absolute inset-y-0 left-0 w-60 bg-background p-4 shadow-xl" : compact ? "bg-surface/30 px-2 py-4" : "bg-surface/30 p-4")}>
          <Link href="/" aria-label="career-ops home" title={compact ? "career-ops home" : undefined} onClick={() => setNavigationExpanded(false)} className={cn("flex items-center gap-2.5 px-1", compact ? "mb-4 justify-center" : "mb-8")}>
            <CoMark size={32} />
            <span className={cn(instrumentSerif.className, "relative -top-px text-2xl font-normal tracking-tight text-landing", compact && "sr-only")}>
              career-ops
            </span>
          </Link>
          {workspace && <button type="button" aria-label={compact ? "Expand app navigation" : "Collapse app navigation"} title={compact ? "Expand app navigation" : "Collapse app navigation"} aria-expanded={navigationExpanded} aria-controls="app-navigation" onClick={() => setNavigationExpanded((open) => !open)} className={cn("mb-4 flex min-h-10 items-center gap-3 rounded-md px-3 py-2 text-sm text-muted hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-brand", compact && "justify-center px-2")}>
            {compact ? <PanelLeftOpen aria-hidden="true" className="size-4 shrink-0" /> : <PanelLeftClose aria-hidden="true" className="size-4 shrink-0" />}
            {!compact && "Collapse navigation"}
          </button>}
          <nav id="app-navigation" aria-label="App navigation" className="flex flex-col gap-1">
            {visibleNavItems(followupsEnabled).map(({ href, label, icon: Icon, chip }) => {
              const active = isActivePath(href, pathname);
              return (
                <Link
                  key={href}
                  href={href}
                  aria-label={label}
                  aria-current={active ? "page" : undefined}
                  title={compact ? label : undefined}
                  onClick={() => setNavigationExpanded(false)}
                  className={cn(
                    "flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors focus-visible:outline-2 focus-visible:outline-brand",
                    workspace && "min-h-10",
                    compact && "justify-center px-2",
                    active
                      ? "bg-brand-soft text-brand-text"
                      : "text-muted hover:bg-surface-hover hover:text-foreground",
                  )}
                >
                  <Icon aria-hidden="true" className="size-4 shrink-0" />
                  <span className={compact ? "sr-only" : undefined}>{label}</span>
                  {chip && !compact && (
                    <span className="ml-auto rounded-full border border-brand/30 bg-brand-soft px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-brand-text">
                      {chip}
                    </span>
                  )}
                </Link>
              );
            })}
          </nav>

          {!compact && <WorkerPills />}

          {compact ? <div className="mt-auto flex justify-center pb-16 pt-4"><ThemeToggle /></div> : <div className="mt-auto space-y-3 pb-16 pt-4">
            <UsageMeter />
            <div className="space-y-1.5">
              <div className="flex items-center justify-between px-1">
                <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-faint">Appearance</span>
                <span className="font-mono text-[10px] text-faint">THEME</span>
              </div>
              <ThemeToggle showLabel />
              <div className="px-1">
                <span className={`${instrumentSerif.className} text-sm text-faint`}>local-first · v0</span>
              </div>
            </div>
          </div>}
          </div>
        </aside>
        <main className="min-w-0 flex-1 overflow-x-hidden">{children}</main>
        <AssistantConsole />
        <BackToTop />
        <FirstScoreView />
        {/* Fork: the pre-release pill and bug-report button stay off; report upstream bugs from the fork's repository. */}
      </div>
      </ExploreProvider>
      </ApplyProvider>
      </PipelineProvider>
    </JobsProvider>
  );
}
