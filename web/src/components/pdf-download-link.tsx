"use client";

import { useState, type MouseEvent, type ReactNode } from "react";
import { downloadFilename } from "@/lib/content-disposition.mjs";

// Retrieve the PDF in the page's same-origin context and surface HTTP errors
// before handing the received bytes to the browser for saving.
export function PdfDownloadLink({ href, className, children }: {
  href: string;
  className?: string;
  children: ReactNode;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function download(event: MouseEvent<HTMLAnchorElement>) {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setError(null);
    let objectUrl: string | undefined;
    try {
      const response = await fetch(href, { cache: "no-store" });
      if (!response.ok) throw new Error(`PDF download failed (HTTP ${response.status}).`);
      if (!response.headers.get("content-type")?.toLowerCase().startsWith("application/pdf")) {
        throw new Error("PDF download failed: server did not return a PDF.");
      }
      const filename = downloadFilename(response.headers.get("content-disposition"), "cv.pdf");
      objectUrl = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = objectUrl;
      link.download = filename;
      document.body.appendChild(link);
      try { link.click(); } finally { link.remove(); }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "PDF download failed. Please retry.");
    } finally {
      // Give the browser time to start reading the object URL before releasing it.
      if (objectUrl) {
        const savedUrl = objectUrl;
        setTimeout(() => URL.revokeObjectURL(savedUrl), 60_000);
      }
      setPending(false);
    }
  }

  return (
    <>
      <a href={href} download onClick={download} aria-disabled={pending} aria-busy={pending} className={className}>
        {children}
      </a>
      {error && <span role="alert" className="text-xs text-red-700 dark:text-red-400">{error}</span>}
    </>
  );
}
