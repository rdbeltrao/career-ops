import { reportNumberFromCell } from './apply/cv-selection.mjs';

/** @param {{reportId?:string|null}} document @param {{n:string,report:string}[]} applications */
export function applicationIdForDocument(document, applications) {
  if (!/^\d+$/.test(document.reportId ?? '')) return null;
  const matches = applications.filter(row => /^\d+$/.test(row.n) && reportNumberFromCell(row.report) === Number(document.reportId));
  return matches.length === 1 ? matches[0].n : null;
}

/** @param {{id:string, kind?:string, reportId?:string|null, applicationId?:string|null}} document */
export function editorLinks(document) {
  return {
    classic: document.kind === 'cv' && /^\d+$/.test(document.applicationId ?? '')
      ? `/pipeline/${document.applicationId}/cv-studio` : null,
    visual: `/documents/${encodeURIComponent(document.id)}/edit`,
  };
}

/** EVIDENCE: https://developer.mozilla.org/en-US/docs/Web/API/Window/postMessage
 * Match both origin and source; a session also rejects messages from a prior document.
 * @param {{source:unknown,origin:string,data:unknown}} event
 * @param {{source:unknown,origin:string,session:string}} expected
 */
export function isEditorMessage(event, expected) {
  if (!expected.source || event.source !== expected.source || event.origin !== expected.origin) return false;
  const data = event.data;
  if (!data || typeof data !== 'object') return false;
  const d = /** @type {Record<string,any>} */ (data);
  if (d.channel !== 'career-ops-pdf-editor' || d.session !== expected.session) return false;
  if (d.type === 'selection') return typeof d.paragraphId === 'string' && typeof d.text === 'string' && Number.isInteger(d.pageIndex) && d.pageIndex >= 0;
  if (d.type === 'exported') return d.bytes instanceof ArrayBuffer;
  if (d.type === 'error') return typeof d.message === 'string';
  return ['ready','loaded','changed','selected'].includes(d.type);
}

/** @param {{paragraphId:string,original:string}} proposal
 * @param {{paragraphId:string,text:string}|null} selection */
export function proposalMatches(proposal, selection) {
  return !!selection && proposal.paragraphId === selection.paragraphId && proposal.original === selection.text;
}
