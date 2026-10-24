# LinkedIn: connections, activity and applying

career-ops has no LinkedIn provider by design: it never logs in to LinkedIn, never scrapes it, and never clicks anything there. What it does have is the three pieces a job seeker needs around LinkedIn: a weekly connection plan (`network`), daily comment drafts (`engage`), and messages to individuals (`contacto`). This document explains the three pillars behind them, which piece of the system covers each, and what is never automated.

The playbook is distilled from a public LinkedIn job-search guide (read 2026-10-19), in our own words. Its rules are empirical, not published LinkedIn behaviour: treat them as the default and let the candidate's own results override them.

## The three pillars

Success on LinkedIn for a job seeker is a filled profile, constant growth of relevant connections, and constant activity on the platform. The profile is the candidate's own work (its headline, location and skills must match the target roles, since recruiters read those fields); career-ops covers the other two pillars, plus how applications should be sent.

## Who searches, and what they filter on

Recruiters and hiring managers find candidates through the normal search (small companies, one-off hires) or through LinkedIn Recruiter (anyone hiring at volume). Recruiter filters that networking directly feeds:

- **Have company connections**: the candidate is connected to people at the recruiter's company.
- **Engaged with talent brand**: the candidate follows the company page or pressed "I am interested" on the company page or at the bottom of a job post.
- Location, skills and years of experience are read from the profile.

Quality changes show after one to two weeks, once the algorithms re-rank the profile. If nothing changes after that, demand for the role in the location is low and the regular actions below matter more, not less.

## How the pieces fit

| Piece | Where it runs | What it does | What it never does |
|---|---|---|---|
| The job-hunt feeder (`uv run python -m jobs fetch`, then `jobs pipeline --data-root <data root>`) | The candidate's job-hunt checkout, with their own logged-in browser session | Reads LinkedIn job search results and writes pending rows to `data/pipeline.md` and JD files to `jds/feeder/` in the career-ops data root | Applies, connects, posts; it only reads |
| `node jev-score.mjs`, `node jev-rank.mjs`, `triage` | career-ops | Annotate the pending rows with a calibrated verdict (`jev:` segment) and shortlist them | Filter, reorder or delete a row |
| `network` mode, `node network-plan.mjs` | career-ops, zero network | Rank the funnel's companies and print this week's connection plan: openings, company-page search, one people-search link per role family; `--done` records covered companies in `data/network.json` | Send an invitation, follow a page, name a person |
| `node linkedin-join.mjs` | career-ops, offline | Say whether the candidate already knows someone at a company in the funnel, from their own `Connections.csv` export ([LINKEDIN_JOIN.md](LINKEDIN_JOIN.md)) | Change a score or become a claim in a document |
| `contacto` mode | career-ops | Draft the message to one person: power move, greeting, referral, networking, built from `templates/outreach.md` | Send, connect, or write to a current-employer colleague about leaving |
| The feeder's `jobs engage --list` | The job-hunt checkout | Write the latest posts of the candidate's chosen creators to `out/engage-pending.json` | Comment or react |
| `engage` mode | career-ops | Pick at most three posts and draft the comments from `templates/posts.md`; offer `jobs engage --done` afterwards | Post, comment, repost |
| `apply` mode | career-ops | Fill the application form and stop before Submit; names the ATS and its documented auto-reject behaviour (`data-static/ats-notes.md`) | Submit, use Easy Apply when another route exists |

A Node port of the feeder as a fork-local provider is a later option; until then the Python feeder stays, and the data root is the only thing the two share.

## Connections

- Target: 1500 to 2000 connections minimum, all relevant: people with the candidate's title, people with the title they want, people who could be their manager, their managers, and recruiters, all at companies and in locations where the candidate wants to work.
- LinkedIn allows roughly 100 invitations a week. Two months of that is a network that works on its own. `network-plan.mjs` spreads the budget over the week; the mode stops at it.
- Use **Connect**, never Follow. Connect is at the top of a profile or hidden under "More".
- Follow the company page of every company the candidate applies to or wants to work for, and press "I am interested" where the company offers it (About block of the company page, or below the job post).
- A note with the invitation only when there is something real to say (a compliment, what caught the candidate's attention, a shared context). A "nice to meet you" note is worse than no note. In cybersecurity adding strangers is frowned upon, in finance treated with care; everywhere else it is normal.
- Peers at the candidate's current employer are never part of the plan.

## Activity: comments first, posts optional

- For a job search (not a personal brand), comments on other people's posts and reposts with an added opinion beat writing posts, up to about 3000 connections. The guide's own numbers: 15 to 25 search appearances a week with no comments, about 200 with one to three comments a day and no posts.
- Pick three to five creators in the industry, turn on post alerts (the bell on their profile), and comment one to three times a day. The feeder's creators file holds that list; `engage` drafts the comments.
- A comment must add something: an experience, a counterpoint, a concrete example, a question that moves the thread. "Great post, thanks" counts for nothing with the algorithm.
- Repost with a comment of the candidate's own, not a bare repost.
- Stay kind. Every comment is public and recruiters read them; sour comments about recruiters or companies cost interviews.
- Posts are a long-term investment (return after a year or more). The one post that pays off during a search is an Open to work post, which LinkedIn boosts. Write it as a pitch, not as a plea; the structure is in `templates/posts.md`.
- Post format: half to one and a half desktop screens, no paragraph longer than one and a half lines, one useful thing the reader can apply at once; media (image, carousel, poll) raises reach. Write in the audience's language only; LinkedIn translates.

## Applying

- Never use Easy Apply when any other way to apply exists (company site, ATS link, recruiter contact). Easy Apply drowns an application among hundreds of unread ones, and LinkedIn ranks applicants only by profile match, with filters on location, years of experience and skills pulled from the profile. The recruiter sees the headline, the location, the experience preview and the uploaded CV (a PDF). `apply` checks for the other route first.
- Before or right after applying, find a person: a possible referrer, the hiring manager, or the recruiter, and write to them (`contacto`). The application itself is the weakest signal.
- Small companies and startups post jobs as free posts, invisible in job search: search posts with the role in quotes, type Posts, content type Job posts. This search cannot filter by location; results depend on the network.
- Hiring managers for common roles can be found with the people-search filter "Actively hiring" (Premium only): people search, role title of the hiring manager or recruiter, the target location.

## Measuring (Premium shows more)

- Search appearances (updated on Wednesdays, no history, so keep a weekly table), profile views (weekly history), the share of views from recruiters, and views from LinkedIn Recruiter (counted by hand).
- Open to work badge: test it one month on, one month off, keep what produced interviews.
- Settings → Data privacy → Job seeking preferences → "Signal your interest to recruiters at companies you've created job alerts for": on.

## What is never automated

- No sending: no invitation, message, InMail, comment, reaction, repost, post, follow or "I am interested" is ever sent by a mode or a script. Every text is a draft the candidate pastes.
- No Easy Apply when another route exists, no account creation, no password typed anywhere.
- No login to LinkedIn from career-ops and no scraping of it. The only logged-in fetch is the job-hunt feeder, which the candidate runs in their own checkout with their own session, and which reads only job search results and the posts of the creators they chose.
- Nothing from LinkedIn becomes a claim in a CV, a cover letter or a form answer, and knowing someone at a company never changes an evaluation score.
- No record of who accepted or ignored an invitation: `data/network.json` holds company names and dates only, and `data/contacts.tsv` holds a person's name and professional role only, written after the candidate confirms.
- No write to the feeder's own records from career-ops: `jobs engage --done` and the feeder's done lists are the candidate's to run.
