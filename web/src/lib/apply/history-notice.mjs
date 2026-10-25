/**
 * history-notice.mjs - the Apply page's repeat-application notice (modes/apply.md
 * #1920), built from the answer bank's history for the company.
 *
 * Plain .mjs with no imports so `node --test` can load it. Kept apart from the
 * provider so its wording can be pinned: it must not say "applied" for a form
 * that was only filled, and must not claim pre-filled answers when none matched.
 */

/**
 * @param {{ company: string, applications: { date: string, state: string, role?: string, report?: string | null }[], matched: number }} input
 * @returns {string} The notice, or "" when there is no earlier application.
 */
export function historyNotice({ company, applications = [], matched = 0 }) {
  if (!applications.length) return "";
  const submitted = applications.some((a) => a.state === "submitted");
  const list = applications
    .slice(0, 3)
    .map((a) => `${a.date} (${[a.role, a.state === "submitted" ? "submitted" : "filled but not submitted", a.report ? `report ${a.report}` : ""].filter(Boolean).join(", ")})`)
    .join("; ");
  const lead = submitted ? `You have applied to ${company} before: ${list}.` : `You started an application to ${company} before: ${list}.`;
  const prefilled = matched > 0 ? " Earlier answers are pre-filled where the questions match, so this application stays consistent." : "";
  return `${lead}${prefilled} Some ATS keep your whole history, so check your candidate profile there too.`;
}
