# Career workspace presentation corrections

## Problem

The first implementation exposed internal Markdown files as a nested library. It
did not reproduce the source workspace's page hierarchy. Naming the proof-point
digest "Approved achievements" falsely suggested it was the complete approved
source page; placing the working CV beside source material made its role unclear.
Two sidebars and repeated heading wrappers reduced the usable document width.
Conservative rich-editor fallbacks opened ordinary documents as raw source.

## Design

- Keep content readable on every navigation. Unsupported rich-editing syntax
  opens as safely rendered Markdown, with an explicit source-editing control.
  Switching views never rewrites the source or marks it dirty.
- Support ordinary horizontal rules in Lexical using the same transformer for
  import, export and shortcuts. Preserve the semantic round-trip check.
- Keep the main app sidebar fully visible, use a wider document pane,
  and a drawer when both panes cannot fit. Hide redundant single-H1 wrappers in
  navigation only; cap indentation and expand only active ancestry by default.
- Label app summaries, settings and CV drafts honestly. A local summary is not a
  complete source page. Keep source hierarchy and application outputs distinct.
- The user selected actual Notion pages and hierarchy. Import the complete child
  graph into `data/context-workspace/` in the configured private data root, with
  one editable Markdown file per page, a validated hierarchy manifest, source
  links, and untouched original snapshots. Never overwrite an existing library.
- Source pages and App files are separate navigation views. Context opens the
  imported root; CV draft remains an app output. Source headings remain page
  content, never invented child pages. Reference notes do not become candidate
  facts or replace the canonical application profile.
- Convert enhanced Markdown into readable Markdown. Preserve tables, emphasis,
  links and code; expand toggles and stack columns in reading order. Media embeds
  remain source links. Keep original snapshots and conversion notices so layout
  simplifications are explicit. This is a local copy, not ongoing Notion sync.

## Work and verification

1. Add failing regressions for thematic rules and readable unsupported documents;
   implement native rules and formatted fallback; verify exact source and no saves.
2. Add navigation tests for H1-wrapper flattening and expansion; adjust responsive
   layout; inspect desktop, narrow desktop and mobile without horizontal overflow.
3. Correct document labels and CV explanation; verify all destinations remain
   accessible and unsaved-draft/revision protections still work.
4. Import the validated source inventory into the new private library. Verify
   every title, parent and sibling order against the fetched child-page graph.
   Test local page creation, rename, reorder, reload and conflicting saves.
5. Run focused tests, browser regressions, full web suite, typecheck and build.
   Review spec compliance, then code quality; record existing root-suite failures
   separately from this change's result.

## Evidence

- The actual source workspace has a Start Here guide, career context pages,
  employer pages under Career History, references, and an approved achievement
  reference. The existing `_context.md` instead contains a compiled fit profile.
- `article-digest.md` contains thematic rules; the original supported-node set
  omitted `thematicBreak`, causing otherwise ordinary prose to fall back.
- React Markdown renders CommonMark, and remark-gfm adds tables and task lists:
  https://github.com/remarkjs/react-markdown and
  https://github.com/remarkjs/remark-gfm.
- Lexical's Markdown shortcut plugin includes a horizontal-rule transformer:
  https://github.com/facebook/lexical/blob/main/packages/lexical-react/src/LexicalMarkdownShortcutPlugin.tsx.

## Completed validation

- Imported 65 actual source pages into the configured private data root: 65
  editable bodies, 65 unchanged original snapshots and one hierarchy manifest.
  Checked every title, parent and sibling order against the fetched child graph.
  Ten pages carry visible conversion notes. The six existing canonical career
  files were unchanged by the import.
- Full web suite: 2,070 tests, 2,048 passed, 22 skipped, zero failures.
  Editor opt-in run: 15 passed (11 unit checks and four browser scenarios).
  Workspace browser run: three passed, including a missing source body that
  leaves healthy siblings available. Typecheck and production build passed.
- Layout checks passed at 390, 768, 1,024, 1,440 and 1,600 pixels. The app rail is
  72 pixels; the document pane is 304–320 pixels. Expansion does not shrink the
  editor. No horizontal overflow, browser errors or writes during read checks.
- Verified the live app opens the imported root and renders the actual approved
  achievement page with headings, emphasis and callouts. Live verification was
  read-only; editing tests used disposable fictional data.
- Review found and fixed divider shortcuts dropping adjacent formatted text,
  nested code conversion losing backticks or indentation, and an unavailable
  source page hiding its healthy siblings. Final review found no open issues.
- The earlier root-suite failures remain documented in
  `2026-10-25-career-workspace.md`; this correction changes the web workspace and
  was verified with its complete suite. No unrelated root failures were changed.

## Deliberate boundaries

This is an internal source library. Local source edits do not automatically
change facts used for matching or generated CVs. Toggles are expanded and columns
stack in source order. Private attachments unavailable locally retain their
captions, without outbound Notion links. Conversion notes remain available on
each affected page, and original snapshots are retained as private provenance.

## Navigation simplification follow-up

The user requested five further corrections after using the workspace:

- The page drawer stays open when switching Source pages/App files or selecting
  pages, including the current page. Only explicit close controls dismiss it.
- The app has no outbound Notion navigation. Known imported page links resolve
  internally; unmatched references keep their labels as text. Original snapshots
  remain private provenance. Canonical app files are never rewritten on open.
- Remove the duplicate child-page cards below the editor. The page sidebar owns
  navigation, with breadcrumbs for ancestry.
- Restore the full main app sidebar at desktop widths. Remove the compact rail
  and manual expansion controls.
- Remove the permanent "Reload from disk" control. A conflicting saved version
  offers "Open saved version" only when needed, with explicit draft protection.

Verification covers repeated drawer navigation, visible app labels, absence of
duplicate cards/vendor links, internal-link resolution, safe pasted HTML, and
conflict recovery. Existing imported page bodies receive a backed-up link-only
migration that preserves their content and hierarchy.

### Follow-up validation

- The new navigation assertion failed against the previous build (`72 !== 240`)
  before the layout change, then passed against the corrected production build.
- Full web suite: 2,139 tests, 2,114 passed, 25 skipped, zero failures.
  All eight browser scenarios passed: three workspace scenarios and five editor
  scenarios, including pasted HTML and preserving unsupported source text.
  The editor run also passed all 13 unit checks. Typecheck and production build
  passed.
- Live read-only verification confirms a 240-pixel main sidebar, no outbound
  Notion anchors, no duplicate child-page lists and no reload control.
- Applied the link-only migration to 39 of 65 imported page bodies and neutralized
  conversion notes on eight pages. Created 40 backups and verified every changed
  file after writing. Page titles, parents, order and original snapshots remain
  unchanged. The six canonical career files were not touched.
- Final spec and code review found no actionable issues. Existing root-suite
  failures remain recorded in the original workspace plan; they were not changed.
