import { DocumentStoreError, MAX_PDF_BYTES } from './document-store.mjs';
import { checkRequest, parseAllowedHosts, parseAllowedOrigins } from './origin-guard.mjs';
import { inlineDisposition } from './content-disposition.mjs';

function json(data, status = 200) {
  const headers = { 'Cache-Control': 'no-store' };
  if (data.revision) headers.ETag = `"${data.revision}"`;
  return Response.json(data, { status, headers });
}

export function documentRequestGuard(req) {
  const allowedOrigins = parseAllowedOrigins(process.env.CAREER_OPS_ALLOWED_ORIGINS);
  const requestUrl = new URL(req.url);
  const host = req.headers.get('host') ?? requestUrl.host;
  const result = checkRequest({
    host,
    origin: req.headers.get('origin'),
    secFetchSite: req.headers.get('sec-fetch-site'),
    allowedHosts: parseAllowedHosts(process.env.CAREER_OPS_WEB_ALLOWED_HOSTS),
    allowedOrigins,
  });
  if (!result.ok) return json({ error: result.reason }, 403);
  const origin = req.headers.get('origin');
  // checkRequest's legacy fallback compares host only; file mutations also
  // require the complete scheme/host/port origin unless explicitly allowed.
  // Next may rewrite Request.url to its internal localhost hostname while
  // preserving the browser's Host header. Compare the already validated Host
  // so http://127.0.0.1 remains its own legitimate origin in that deployment.
  const publicOrigin = new URL(`${requestUrl.protocol}//${host}`).origin;
  if (origin && origin !== publicOrigin && !allowedOrigins.has(origin)) {
    return json({ error: 'Cross-origin document access is not allowed.' }, 403);
  }
  return null;
}

async function readBoundedBody(req, limit) {
  const length = req.headers.get('content-length');
  if (length && (!/^\d+$/.test(length) || Number(length) > limit)) throw new DocumentStoreError(413, 'Request body is too large.');
  if (!req.body) return Buffer.alloc(0);
  const reader = req.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new DocumentStoreError(413, 'Request body is too large.');
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    try { await reader.cancel(); } catch { /* Preserve the request error. */ }
    throw error;
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks, size);
}

function expectedRevision(req) {
  const header = req.headers.get('if-match') ?? '';
  return /^"[a-f0-9]{64}"$/.test(header) ? header.slice(1, -1) : header;
}

export function documentErrorResponse(error) {
  if (error instanceof DocumentStoreError) return json({ error: error.message }, error.status);
  if (error?.name === 'DirLockTimeoutError') return json({ error: 'This document is busy. Try again shortly.' }, 409);
  console.error('[documents] Document operation failed:', error);
  return json({ error: 'The document could not be updated. Your recoverable copies were kept.' }, 500);
}

/** Framework-independent handler; tests use a real store in a scratch data root. */
export async function handleDocumentRequest(req, id, { store }) {
  const blocked = documentRequestGuard(req);
  if (blocked) return blocked;
  try {
    if (req.method === 'GET') {
      if (new URL(req.url).searchParams.get('format') === 'pdf') {
        const doc = store.read(id);
        return new Response(new Uint8Array(doc.bytes), { headers: {
          'Content-Type': 'application/pdf', 'Content-Disposition': inlineDisposition(doc.filename),
          'Cache-Control': 'no-store', ETag: `"${doc.revision}"`,
        } });
      }
      return json(store.metadata(id));
    }
    if (req.method === 'PUT') {
      if (req.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/pdf') {
        return json({ error: 'Send the edited document as application/pdf.' }, 415);
      }
      const revision = expectedRevision(req);
      if (!/^[a-f0-9]{64}$/.test(revision)) return json({ error: 'Reload the PDF before saving it.' }, 428);
      const bytes = await readBoundedBody(req, MAX_PDF_BYTES);
      return json(await store.save(id, bytes, revision));
    }
    if (req.method === 'DELETE') return json(await store.remove(id, expectedRevision(req)));
    if (req.method === 'POST') {
      if (req.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
        return json({ error: 'Send recovery details as application/json.' }, 415);
      }
      let body;
      try { body = JSON.parse((await readBoundedBody(req, 16384)).toString('utf8')); }
      catch (error) {
        if (error instanceof DocumentStoreError) throw error;
        return json({ error: 'Invalid recovery request.' }, 400);
      }
      if (body?.action === 'restore') return json(await store.restore(id, body.restoreToken));
      if (body?.action === 'restore-version') return json(await store.restoreVersion(id, body.versionId, body.revision));
      return json({ error: 'Unknown recovery action.' }, 400);
    }
    return json({ error: 'Method not allowed.' }, 405);
  } catch (error) { return documentErrorResponse(error); }
}
