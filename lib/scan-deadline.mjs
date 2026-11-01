/** One cancellation signal shared by a scan's worker and browser operations. */
export function createScanDeadline(raw, { now = Date.now } = {}) {
  const deadlineMs = Number.isFinite(Number(raw)) && Number(raw) > 0 ? Number(raw) : Infinity;
  const controller = new AbortController();
  const stop = () => {
    if (!controller.signal.aborted) controller.abort(Object.assign(new Error('Scan time budget reached'), { code: 'SCAN_DEADLINE' }));
  };
  const timer = Number.isFinite(deadlineMs) ? setTimeout(stop, Math.max(0, deadlineMs - now())) : null;
  timer?.unref();
  return {
    deadlineMs, signal: controller.signal, stop,
    expired() { if (now() >= deadlineMs) stop(); return controller.signal.aborted; },
    close() { clearTimeout(timer); },
  };
}

/** Observe late completion without letting an unresponsive operation hold a run. */
export function withScanSignal(signal, operation) {
  if (!signal) return Promise.resolve().then(operation);
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const aborted = () => { signal.removeEventListener('abort', aborted); reject(signal.reason); };
    signal.addEventListener('abort', aborted, { once: true });
    Promise.resolve().then(() => { if (signal.aborted) throw signal.reason; return operation(); })
      .then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted));
  });
}
