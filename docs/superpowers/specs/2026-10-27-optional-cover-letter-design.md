# Optional cover-letter direction

## Intent

Draft a useful, concise cover letter from the current candidate Context and job
description without requiring the candidate to repeat information in a questionnaire.
The user may supply extra direction in one optional prompt.

## Behavior

- The report-page form contains one textarea, `Additional instructions (optional)`.
  Remove the three required answers and tone selector. Blank submission starts a draft.
- Requests normalize to `brief: { instructions: string }`. Missing, null, empty,
  and whitespace-only briefs are valid. Reject non-object briefs, non-string
  instructions, and instructions exceeding 3,000 characters without truncation.
- Keep report-number validation, report existence checks, job state, retry, and
  draft review behavior. The prompt stays available when redrafting.
- Context career-fact pages and the actual job description supply evidence and
  employer needs. Preferences guide emphasis, never substantiate achievements.
  Invalid Context cannot trigger stale-file fallback.
- Optional direction may steer emphasis, length, tone, or supply a personal
  motivation. It cannot override factual, privacy, or submission safeguards.
  Quoting it does not verify a new claim about past experience.
- Default to 200–300 words in three short paragraphs: a specific role/company
  opening, one or two relevant supported examples tied to employer needs, and
  a concise contribution/interview close. This word target is an implementation
  choice for this user's request, not a universal research finding.
- Use a professional, direct voice; no generic flattery, CV repetition, keyword
  stuffing, fabricated company problems, speculative commitments, or invented
  recipient names. Metrics are optional and must have approved evidence.
- Do not block drafting on research, keyword, gap, motivation, approach, or tone
  confirmations. Unverified details are omitted; meaningful gaps appear after
  the draft. Missing essential JD or candidate evidence still blocks fabrication.
- Web runs stop at the draft and never send, submit, attach, save, or render a
  PDF. Interactive PDF approval remains unchanged.

## Evidence and boundaries

[Harvard MCS guidance](https://careerservices.fas.harvard.edu/resources/hes-create-impactful-resumes-and-cover-letters/)
recommends concise, factual, employer-specific letters, one or two examples,
and a short opening/body/closing structure rather than repeating the CV.
The 200–300 word default, three paragraphs, and 3,000-character direction limit
are scoped product choices. No new dependencies or candidate-data edits.

## Acceptance

Empty submission succeeds; optional text is trimmed and retained on retry;
invalid input fails clearly; draft prompts infer missing direction from Context
and JD; canonical mode no longer demands four answers; safety boundaries remain.
Verify with request/prompt regression tests, a browser exercise against disposable
data, the web suite, repository suite, typecheck, and production build.
