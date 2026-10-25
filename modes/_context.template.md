# Fit profile: {Your Name}

<!-- ============================================================
     THIS FILE IS YOURS. Copy it to `modes/_context.md` in the data root
     and replace every section with your own facts. It is USER LAYER —
     never auto-updated by `node update-system.mjs`.

     PURPOSE: the SOURCE OF TRUTH about you as a candidate (AGENTS.md,
     Source-of-Truth Boundary → Context file), read first in every mode.
     Every fact and figure in it — roles, employers, domains,
     responsibilities, skills, practices, languages, talks, publications,
     and the numbers, team sizes, durations and amounts — is evidence for
     the evaluation, cited as `_context.md:` next to `cv.md:` lines, and
     may back candidate-facing text (CV, cover letter, form answer):
     verify-cv-facts.mjs reads it as a source. cv.md is one tailored
     rendering of this file, never the authority: when the two disagree,
     this file wins and cv.md is the one to fix. A figure you are not yet
     sure of belongs here marked as such ("held for confirmation",
     "approximate", "not a claim"); a figure so marked steers a score but
     stays out of candidate-facing text.

     Readers: the Jev pre-screen (`node jev-score.mjs`, whole file as the
     profile text), modes/oferta.md and batch/batch-prompt.md, the OpenRouter
     runner and the *-eval.mjs scripts, and the draft modes. The agents read
     it through `node context-evidence.mjs`, which prints it as written
     under a one-line notice; masking every quantity as [n] is an opt-in
     (`--mask`, or CAREER_OPS_MASK_CONTEXT=1) for a file whose figures are
     still unresolved. Write it the way you would brief a recruiter:
     concrete, factual, in English, one idea per line. Keep the headings:
     the Jev criteria refer to them by name.
     ============================================================ -->

## Target role

- Title range: {the titles you apply to, and the ones that fit only under a condition}
- Shape: {e.g. player-coach, about 75% people management and 25% hands-on}
- Team: {size you want, directly or through leads}
- Product: {customer-facing, internal, platform; the domains you have worked in}
- Team type: {product teams vs platform, infrastructure or SRE teams, and how strongly you prefer one}
- Company stage: {startup, scale-up, corporate; which is a plus, a minus or neutral}
- Ways of working: {practices you want (remote-first, asynchronous, continuous delivery) and the ones you avoid}

## Location and language

- Where you live and what you accept: {remote (which countries), hybrid (how many office days are fine, how many are a minus), on-site, relocation}
- Languages: {each language and level; which language situations are a blocker and which are only a minus}
- Work authorization: {where you can work without sponsorship}

## Preferences confirmed on {YYYY-MM-DD}

<!-- Keep this in step with `preferences` in config/profile.yml; `node
     render-context.mjs --section preferences` prints that block. Older than
     90 days and the modes ask before letting it decide anything. -->

Hard rules
- {employment type you accept; e.g. employee contract only, contractor or freelance is a blocker}

Minus, not a blocker
- {things you would rather avoid but would consider for an exceptional role}

Neutral (no effect on the score by itself)
- {things that do not sway you either way}

Plus
- {things that make a role more attractive beyond the basics}

No penalty
- {things other people might mind that you do not: travel, title, company size}

## Deal-breakers (score low or skip)

<!-- One per line, the same list as `dealbreakers` in config/profile.yml
     (`node render-context.mjs --section dq`). -->

- {language, employment type, role level, on-site outside your area, industries you refuse}

## Experience summary

- {one bullet per role, newest first: company, title, dates, scope (teams, headcount), what you were responsible for, what you built or changed; only figures that also appear in cv.md}
- {total years in software and years in leadership}

## Technical profile

How to weigh a posting's stack: a required stack counts heavy, a desired stack light. Say which of your skills count where.

- Core, many years hands-on and in production: {...}
- Solid working knowledge: {...}
- Managed, not hands-on: {...}
- Aspirations only, no professional depth: {...}

## Strengths beyond the stack

- {what you have done repeatedly that postings ask for: building teams from scratch, scaling a platform, turning around delivery, insourcing from an agency}

## Management competencies

{One paragraph: hiring, 1:1s, performance reviews, career frameworks, SDLC and agile practices, incident management, metrics, budgeting, stakeholder work.}

## Signals of a strong match

- {what a posting says when it fits you}

## Signals of a weak match

- {what a posting says when it does not}

## Education and extras

{Degrees, talks, publications, awards — as named in cv.md.}
