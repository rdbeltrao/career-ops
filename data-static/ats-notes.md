# ATS notes

Vendor-documented facts about the applicant tracking systems career-ops meets in `modes/apply.md`: what each one parses from the CV, which fields it pre-fills, its file limits, and whether it documents automatic rejection. Only facts from the vendors' own documentation go here, each with its source and the date it was checked. Third-party "ATS optimisation" blogs do not count as sources.

This file ships with career-ops (system layer) and holds no personal data. To add an ATS or refresh an entry, change it with the vendor page and a new check date; `modes/apply.md` reads the quick-reference row for the detected ATS in Step 1 and the knockout-prone class in Step 6 rests on the auto-reject column.

## What holds across all documented systems

1. **Parsing fills a profile.** Every system below parses the CV into candidate fields that a recruiter reviews and searches. None of the vendor docs describes scoring or rejecting a candidate on the CV text.
2. **Automatic rejection exists, but on form answers.** Ashby and JOIN document auto-rejection rules that run on the answers to application questions (location, work permit, availability, years of experience, salary). JOIN states that free-text and file-upload answers cannot trigger it. These knockout questions are where an application can be rejected without a human, so `modes/apply.md` treats them as a class of their own and asks the candidate every time.
3. **The same things break parsing everywhere:** images and scans, tables, multi-column layouts, headers and footers, contact details in a header, footer or text box, graphics and skill bars, small fonts. The single-column, text-based templates `generate-pdf.mjs` renders avoid all of them, so one CV layout fits every system.
4. **What does change per ATS:** file limits, which fields get pre-filled (and which the candidate types by hand), and which application questions can auto-reject.

Context on the "75% of CVs are auto-rejected" claim: a survey of 25 US recruiters by a CV-builder vendor (November 2025) found 92% said their systems do not auto-reject on formatting or keywords; the automated filters were knockout criteria. Small and vendor-run, but more evidence than the 75% figure has. Source: https://itbrief.co.uk/story/study-reveals-ats-rarely-auto-rejects-cvs-debunks-75-myth (checked 2026-10-15).

## Quick reference

| ATS | Detect in apply link | File types (documented) | Size limit | Pre-fills from CV | Auto-reject documented | Per-ATS action |
|-----|----------------------|-------------------------|-----------|-------------------|------------------------|----------------|
| Greenhouse | `greenhouse.io`, `gh_jid=` | .docx, .pdf (not images) | 2.5 MB parse limit | profile fields | not in parsing docs | Write job titles in full; contact details in the body |
| Workday | `myworkdayjobs.com`, `myworkdaysite.com` | not listed | not listed | most fields, **not Skills or Languages** | not in parsing docs | Type Skills and Languages into the form |
| Personio | `jobs.personio.de`, `jobs.personio.com` | PDF, DOCX | 10 MB (recruiter upload) | name, location, phone, email, gender, current employer and title, years of experience, public profile | not in parsing docs | Current role first and unambiguous; consistent dates; no salutation title (gender may be inferred from it) |
| Lever | `jobs.lever.co` | Word, PDF, RTF, WordPerfect, HTML, ODF (not images) | not listed | name, organisation, contact details, work history | not in parsing docs | Text-based file only |
| Ashby | `jobs.ashbyhq.com` | not listed | 50 MB upload; parsed only up to 16 MB | application fields, education (school names standardised) | **yes, on application answers** | Answer screening questions with care; ask the candidate for every one |
| SmartRecruiters | `smartrecruiters.com` | PDF, DOC(X), RTF, JPG, PNG via API | 2 MB per file via API | education, experience, contact | not documented | Keep the PDF under 2 MB |
| JOIN | `join.com` | not listed | not listed | skills, seniority, languages and levels, certifications, education, work history, current role, location | **yes, knockout questions** (rejected the next day, logged, reversible) | Clear Skills and Languages sections; ask the candidate for every knockout answer |
| softgarden | `softgarden.io`, `softgarden.de` | not listed | not listed | name, contact details, work experience, training (not email) | not documented | Contact details in the body; standard sections |
| Recruitee | `recruitee.com` | PDF, Word, ODT | not listed | fields each company defines | not documented | Standard sections |
| Teamtailor | `teamtailor.com` | not listed | not listed | not listed | not documented | Generic rules only |
| SAP SuccessFactors | `successfactors`, `sapsf` | not listed | not listed | per-company mapping | not documented | Generic rules only |

"Not documented" means the vendor pages checked do not mention it, not that the feature does not exist. Detection from the link is a guess; confirm it on the application page (company career sites often embed an ATS under their own domain).

## Sources and details

### Greenhouse (checked 2026-10-15)
https://support.greenhouse.io/hc/en-us/articles/200989175-Unsuccessful-resume-parse
- Does not parse files larger than 2.5 MB; fails on image files.
- Problems: photos, graphics, tables, headers and footers, columns, contact details in a header, footer or text box, unclear sections.
- Also hurts parsing: letters separated by spaces, abbreviated job titles, company names without an identifier (Inc., GmbH).
- Skips placeholder text such as "First Last" or "Company 1".

### Workday (checked 2026-10-15)
https://doc.workday.com/admin-guide/en-us/human-capital-management/recruiting/candidates/set-up-prospects-and-candidates/hdc1552497830785.html
- Parsing populates application fields; recruiters review them.
- Does not populate Skills or Languages.
- Accuracy varies with format and word order; image-based styles do worse.

### Personio (checked 2026-10-15)
https://support.personio.de/hc/en-us/articles/360010193018
- Parsing by Textkernel, opt-in per company; PDF and DOCX.
- Extracts: first and last name, location, phone, email, gender, current employer, current title, years of experience, public profile. Gender may be inferred from a salutation such as "Mr.", so the CV carries none.
- Fails or is incomplete on images, scans, tables, columns, headers and footers, small fonts, graphical skills.
- Recruiters filter applications by parsed attributes such as current employer.

### Lever (checked 2026-10-15)
https://help.lever.co/hc/en-us/articles/20087345054749-Understanding-resume-parsing
- Parses name, organisation, contact details and work history into the candidate profile.
- Parses Word (.docx), PDF, RTF, WordPerfect, HTML, MS Office HTML and Open Office; cannot parse JPG or PNG.
- Lever's own check: if you cannot highlight the text in the file, it likely will not parse. (Passing this does not prove the reading order is right; a two-column layout passes it.)

### Ashby (checked 2026-10-15)
https://docs.ashbyhq.com/application-forms and https://docs.ashbyhq.com/auto-reject-applications
- Resume uploads up to 50 MB; only files of 16 MB or less are processed for autofill and search.
- Education entries are standardised (a short school name and its full name map to one school).
- Auto-reject runs at submission on application-question answers: equals, contains, starts/ends with, empty, and fuzzy "similar to" matches, combined with and/or/not. Companies choose the conditions (the docs give location as an example) and can delay the rejection email.
- Some questions can be private: the candidate answers them, but only admins see the responses.

### SmartRecruiters (checked 2026-10-15)
https://developers.smartrecruiters.com/docs/post-an-application and https://developers.smartrecruiters.com/reference/candidatesresumeparse
- Developer API: attachments limited to 2 MB per file; accepted PDF, DOC(X), RTF, JPG, PNG. This is the API limit used by integrations; the career-site limit is not documented there, so 2 MB is the safe ceiling.
- The parser returns an error for resumes that cannot be parsed, "e.g. an image".
- Application records hold education and experience entries (title, company, dates, location, description).

### JOIN (checked 2026-10-15)
https://join.com/en/features/candidate-profiles and https://join.com/en/features/screening
- An LLM-based parser extracts skills, seniority level, languages and proficiency, certifications, education, work history, current role and location into filterable fields.
- Knockout questions (yes/no, single- and multi-select, numeric, date) reject a failing application the next day with an automatic email; text and file-upload questions cannot knock out. Decisions are logged and recruiters can restore a rejection.
- Typical knockouts named: work permit, driving licence, on-site availability, years of experience, salary expectation, notice period.

### softgarden (checked 2026-10-15)
https://support.softgarden.de/en/articles/680780-how-does-cv-parsing-work
- Optional add-on by Textkernel; if a company has not activated it, the CV is not parsed.
- Extracts name, contact details, work experience and training. Email and severe-disability information are deliberately not extracted.
- Accuracy varies with the CV's language, formatting and structure.

### Recruitee (checked 2026-10-15)
https://support.recruitee.com/en/articles/1109254-upload-and-parse-cvs
- Parses PDF, Word and ODT. Each company defines which profile fields are extracted per job.

### Teamtailor (checked 2026-10-15)
https://www.teamtailor.com/en/productnews/parse-candidates-faster-and-easier/
- Product news only: parsed data can be previewed and edited before a candidate is added. No fields, file types or limits documented on that page.

### SAP SuccessFactors Recruiting (checked 2026-10-15)
https://apps.support.sap.com/sap/support/knowledge/public/E/2582786
- Parsing applies when a resume is uploaded on the candidate profile, not on CSV or API imports; field mapping is configured per company. No file types or limits on that page.
