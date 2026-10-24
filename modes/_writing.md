---

## Voice DNA (writing guardrail)

If `voice-dna.md` exists in the project root, it is a writing guardrail for generated prose. It is user-layer and optional — never assume it exists, and skip this block silently if it doesn't. It layers **under** the user's personal style: it catches AI-slop and fills gaps, but it always defers to the user's own voice rules in `_profile.md` (see Precedence below).

**Two-tier scope (this is what keeps CVs accurate):**

- **Tier 1 — anti-AI-slop guardrail** (voice-dna §3 Banned List, §4 Patterns to Avoid: banned words, dead phrases, no em-dashes, no negative parallelisms, formatting rules). These are HARD RULES. They apply to **all** generated text, including CV bullets and the Professional Summary.
- **Tier 2 — conversational voice** (voice-dna §1-2: contractions, And/But sentence openers, hedging like "I think"/"maybe", parenthetical asides, direct "I"/"you"). Apply **only** to conversational candidate-facing prose: cover letters, LinkedIn outreach, follow-up emails. **Do NOT apply Tier 2 to CV/ATS text** (PDF bullets, Professional Summary) — those keep the formal, keyword-dense register in the ATS Rules below.

**Accuracy always wins over style.** Facts from `cv.md` and `article-digest.md` are never overridden by voice-dna. Never drop, soften, or hedge a real metric to improve rhythm. Never invent detail to sound more human. Voice-dna shapes wording; it never changes content.

**Precedence with personal style (`_profile.md` always wins):** The user's `## Writing Style` in `_profile.md` is the authority on voice and tone. Where `voice-dna.md` and `_profile.md` conflict, `_profile.md` wins — voice-dna never overrides a rule the user set for themselves. Example: if the user's `_profile.md` style uses em-dashes, keep them, even though voice-dna discourages them. voice-dna's anti-AI-slop rules apply only where `_profile.md` is silent. (`voice-dna.md` is itself a user file, so a user who wants the strict guardrail to win can simply leave that preference out of `_profile.md`.)

---

## Writing Style Calibration

**Check `_profile.md` first.** If a `## Writing Style` section exists there, use it directly — do not re-scan the writing-samples files. Re-scanning is only needed when new samples are added or the user explicitly asks to recalibrate.

**When to apply:** Before generating any text the user will send or publish — cover letters, LinkedIn outreach, application form answers, follow-up emails, executive summaries, profile blurbs. Does NOT apply to internal evaluation reports (A–F blocks, scores, analysis).

**If no cached style in `_profile.md`:** Read all files in `writing-samples/`, **skipping any file named `README.md`**. If no user-provided samples are found, skip style calibration and gently note — once, without pressure — that adding a writing sample (e.g. a past cover letter, a LinkedIn About section, any professional writing) would help tailor outputs to their voice. If samples exist, extract the markers below and write the result to `_profile.md` under `## Writing Style` so future sessions skip this step.

### What to extract

**Tone & register**
- Formal vs. conversational
- Confident vs. hedging (watch for qualifiers like "I think", "perhaps", "somewhat")
- Warm vs. transactional
- Degree of self-promotion — does the user undersell, match, or lead with achievements?

**Sentence structure**
- Average sentence length — short and punchy or long and layered?
- Use of fragments for emphasis
- Clause nesting and complexity
- How sentences open — subject-first, action-first, context-first?

**Punctuation habits**
- Em dashes, en dashes, or parentheses for asides?
- Oxford comma or not?
- Ellipses — used or avoided?
- Exclamation marks — never, sparingly, or freely?
- Semicolons vs. full stops to join related ideas

**Vocabulary**
- Technical density — how much jargon per paragraph?
- Preferred synonyms (e.g. "built" vs. "developed" vs. "engineered")
- Words or phrases the user reaches for repeatedly — keep them
- Words that never appear — don't introduce them

**Paragraph and structure patterns**
- Paragraph length — one-liners or developed blocks?
- Bullet-heavy or prose-heavy?
- How ideas are sequenced — problem → solution, result-first, chronological?
- Use of headers within longer pieces

**Voice signatures**
- First-person patterns — "I led", "we built", "our team"?
- Active vs. passive ratio
- Habitual openers and closers
- Rhetorical moves — does the user ask questions, use contrast, tell micro-stories?

### Rules

- **Only extract what is demonstrably present.** Do not infer style from a single data point.
- **Idiosyncratic choices are intentional.** Unconventional punctuation or phrasing is the user's voice — preserve it, do not correct it.
- **If samples conflict**, weight the most recent or most similar-context file.
- **If samples are sparse**, apply what can be reliably extracted and fall back to defaults for the rest.
- **Style calibration applies to tone and structure only.** Do not import content, claims, or metrics from samples into CVs, reports, or evaluations.
- **No verbatim copying or personal identifiers.** Store only abstract style descriptors (tone, structure, vocabulary preferences). Do not quote user sentences verbatim and do not retain personal identifiers (names, emails, phone numbers) from writing samples. "Preserve idiosyncratic choices" applies to stylistic traits only.

### Persisting the extracted style

After scanning (excluding any `README.md` files), write to `modes/_profile.md` only if at least one user-provided sample was found: find the existing `## Writing Style` section and replace the entire block up to the next `##` heading (or EOF) with the new content. If no `## Writing Style` section exists, append it. This ensures there is always exactly one canonical section. If no samples were found after filtering, do not write or modify the section.

```markdown
## Writing Style

_Extracted from writing-samples/ on {date}. Re-run if new samples are added._

**Tone:** {e.g. conversational, confident, no hedging qualifiers}
**Sentence length:** {e.g. short and punchy, avg 12 words}
**Openings:** {e.g. action-first, subject-first}
**Punctuation:** {e.g. em dashes for asides, Oxford comma, no ellipses}
**Vocabulary:** {e.g. prefers "built"/"ran"/"cut" over "developed"/"led"/"reduced"}
**Structure:** {e.g. prose-heavy, result-first sequencing}
**Voice:** {e.g. "I led", active voice dominant, no rhetorical questions}
**Avoid:** {words or patterns absent from samples}
```

---

## Professional Writing & ATS Compatibility

These rules apply to ALL generated text that ends up in candidate-facing documents: PDF summaries, bullets, cover letters, form answers, LinkedIn messages. They do NOT apply to internal evaluation reports.

For recruiter-side risk mapping, six-second clarity, business-value bullets, and ATS reality checks, read `modes/heuristics/recruiter-side.md`.

### Avoid cliché phrases
_If `voice-dna.md` exists, its §3 Banned List is the canonical, fuller version of this list and takes precedence. The list below is the fallback for users without that file._
- "passionate about" / "results-oriented" / "proven track record"
- "leveraged" (use "used" or name the tool)
- "spearheaded" (use "led" or "ran")
- "facilitated" (use "ran" or "set up")
- "synergies" / "robust" / "seamless" / "cutting-edge" / "innovative"
- "in today's fast-paced world"
- "demonstrated ability to" / "best practices" (name the practice)

### Unicode normalization for ATS
`generate-pdf.mjs` automatically normalizes em-dashes, smart quotes, and zero-width characters to ASCII equivalents for maximum ATS compatibility. But avoid generating them in the first place.

### Vary sentence structure
- Don't start every bullet with the same verb
- Mix sentence lengths (short. Then longer with context. Short again.)
- Don't always use "X, Y, and Z" — sometimes two items, sometimes four

### Prefer specifics over abstractions
- "Cut p95 latency from 2.1s to 380ms" beats "improved performance"
- "Postgres + pgvector for retrieval over 12k docs" beats "designed scalable RAG architecture"
- Name tools, projects, and customers when allowed

---

## Outreach and comment rules

These rules bind every short text the candidate pastes into LinkedIn or a chat box: connection notes, outreach messages, networking messages, post comments and reposts (`contacto`, the referral variant of `email`, `engage`). They sit on top of the Voice DNA guardrail and the Professional Writing rules above; where a mode names a tighter limit, the tighter one wins.

- **Length.** 90 to 140 words per message. A connection note stays under 300 characters, and under the account tier's limit when the mode names a lower one (`contacto`: 200 characters on a free account).
- **One number at most, and only a confirmed one.** Confirmed means it is in `cv.md` or `article-digest.md`, or the candidate stated it in this conversation. A figure that exists only in `modes/_context.md`, `modes/_profile.md` or a story-bank entry without provenance is not confirmed and stays out.
- **Honest reason before facts.** The first thing the reader learns is why the candidate writes to them; the facts about the candidate come after, in prose. No "I hope this finds you well", no "I am passionate about", no CV bullets, no lists of tools.
- **Never ask for a job.** Ask for a conversation, a referral, the name of the right person, or a look at an application. One ask per message, phrased as a question.
- **Never write for the candidate to a colleague at their current employer about leaving.** Peers at the current employer are out of scope for outreach and for the networking plan.
- **Never claim the candidate read, used or admired something unless they said so.** When nothing is known about the person, the "why you" paragraph is about the company or the product instead, from the posting or the company's own pages.
- **A referral message names the specific opening and its title.** "Any role" asks the reader to run the candidate's search for them.
- **Comments** add one thing in 40 to 90 words: an experience, a counterpoint, a concrete example, or a question that moves the thread. Kind in every line; recruiters read them. No "Great post", no restating the post, no hashtags, no links to the candidate's own material. Never criticise recruiters, interview processes or companies by name. Nothing internal about the current employer: no customers, incidents or people.
- **Structures** live in `templates/outreach.md` (messages and notes) and `templates/posts.md` (comments, reposts, posts). They are paragraph roles in a fixed order, never text to copy.
- **Drafts only.** The candidate sends, connects, posts, comments and follows. No mode does, and no mode records who accepted or ignored.

---

## Interests in candidate-facing text

The "why this role", "why this company" and "what are you looking for" material in a cover letter, an outreach message, a form answer or an interview answer comes from two user-layer sources when they exist, plus whatever the candidate says in this conversation:

- `modes/_context.md`: the candidate's fit profile (target role, location and language, preferences, deal-breakers, what a strong and a weak match look like). For a draft it is **targeting only**: it steers what to emphasise and never supplies a fact, a number or a claim for candidate-facing text, even though the evaluation may cite its qualitative facts (`AGENTS.md` → Source-of-Truth Boundary → Context tier). The fact gate stays `cv.md` and `article-digest.md`; a number that lives only in `modes/_context.md` does not pass it. When a draft needs a fact that lives only there, ask the candidate to confirm it in the conversation first.
- `config/profile.yml` → `interests` (`role_balance`, `team_size`, `team_type`, `domains`, `ways_of_working`, `learning`), dated by `recorded_on` and `confirmed_on`, and `preferences` with its own `confirmed_on`.

**Staleness rule.** When `confirmed_on` is more than 90 days before today, say so in one line and ask the candidate to confirm before an interest decides a paragraph; a confirmation in this conversation counts for the rest of it. `node render-context.mjs --section interests` prints the block with its `STALE` marker; without the script, compare the date by hand. In an unattended run (`modes/_shared.md` → **Unattended runs**) do not build on a stale interest: leave that paragraph to the candidate's own answer and name the staleness in the closing line.

A missing `modes/_context.md` or `interests` block is not an error. Note it once and continue from `modes/_profile.md` and the candidate's answers. The candidate's own words always win over both files.
