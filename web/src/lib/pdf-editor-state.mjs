/** Bound and copy the native editor's serializable style runs for recovery. */
export function copyInlineState(value) {
  if (value == null) return undefined;
  try {
    if (typeof value !== 'object' || !Array.isArray(value.runs) || value.runs.length > 4096 ||
      value.runs.some(run => !run || typeof run !== 'object' || typeof run.text !== 'string') ||
      value.runs.reduce((size,run) => size + run.text.length,0) > 12000 ||
      (value.format != null && (typeof value.format !== 'object' || Array.isArray(value.format)))) throw new Error();
    const serialized=JSON.stringify(value);
    if (serialized.length > 128 * 1024) throw new Error();
    return JSON.parse(serialized);
  } catch { throw new Error('Invalid PDF inline draft.'); }
}

export function validPdfTargets(targets) {
  return Array.isArray(targets) && targets.length > 0 && targets.length <= 24 &&
    targets.every(target => target && /^\d+:\d+$/.test(target.paragraphId) && typeof target.text === 'string' && target.text.length <= 4000 &&
      Number.isInteger(target.pageIndex) && target.pageIndex >= 0 && target.pageIndex < 20) &&
    new Set(targets.map(target=>target.paragraphId)).size === targets.length &&
    targets.reduce((size,target)=>size+target.text.length,0) <= 24000;
}

/** Identity and original text must both match, including a whole section. */
export function pdfTargetsMatch(expected, actual) {
  return expected.length === actual.length && expected.every((target,index) =>
    target.paragraphId === actual[index].paragraphId && target.text === actual[index].text);
}
