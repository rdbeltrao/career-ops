"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { isEditorMessage } from "@/lib/document-editing.mjs";

export type InlineState = { runs: Record<string, unknown>[]; format?: Record<string, unknown> };
export type PdfTarget = { paragraphId: string; text: string; pageIndex: number };
export type EditorEvent = { type: string; modified?: boolean; requestId?: string; paragraphId?: string; text?: string; original?: string; pageIndex?: number; bytes?: ArrayBuffer; message?: string; warnings?: string[]; canUndo?: boolean; canRedo?: boolean; inlineState?: InlineState; sectionId?: string; title?: string; targets?: PdfTarget[] };
type Pending = { resolve: (event: EditorEvent) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };

export function usePdfEditor(id: string, onEvent: (event: EditorEvent) => void) {
  const frame = useRef<HTMLIFrameElement>(null);
  const pending = useRef(new Map<string, Pending>());
  const callback = useRef(onEvent);
  const [session, setSession] = useState("");
  const [ready, setReady] = useState(false);
  useEffect(() => { callback.current = onEvent; });
  useEffect(() => { setSession(crypto.randomUUID()); setReady(false); }, [id]);

  useEffect(() => {
    if (!session) return;
    const receive = (event: MessageEvent) => {
      if (!isEditorMessage(event, { source: frame.current?.contentWindow, origin: window.location.origin, session })) return;
      const data = event.data as EditorEvent;
      if (data.type === "ready") setReady(true);
      const request = data.requestId ? pending.current.get(data.requestId) : undefined;
      if (request) {
        clearTimeout(request.timer);
        pending.current.delete(data.requestId!);
        if (data.type === "error") request.reject(new Error(data.message || "PDF editing failed."));
        else request.resolve(data);
      }
      callback.current(data);
    };
    window.addEventListener("message", receive);
    const requests = pending.current;
    return () => {
      window.removeEventListener("message", receive);
      for (const request of requests.values()) {
        clearTimeout(request.timer);
        request.reject(new Error("The editor was closed."));
      }
      requests.clear();
    };
  }, [session]);

  const command = useCallback((type: string, payload: Record<string, unknown> = {}) => new Promise<EditorEvent>((resolve, reject) => {
    const target = frame.current?.contentWindow;
    if (!target || !ready) return reject(new Error("The PDF editor is still loading."));
    const requestId = crypto.randomUUID();
    const timer = setTimeout(() => {
      pending.current.delete(requestId);
      reject(new Error("The PDF editor did not respond. Reload the document and try again."));
    }, 60_000);
    pending.current.set(requestId, { resolve, reject, timer });
    // EVIDENCE: postMessage requires an explicit target origin and a validated reply source.
    target.postMessage({ channel: "career-ops-pdf-editor", session, type, requestId, ...payload }, window.location.origin);
  }), [ready, session]);

  return { frame, session, ready, command };
}
