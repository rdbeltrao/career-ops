# Notion plugin — setup walkthrough

Step-by-step setup for the bundled [`plugins/notion/`](../plugins/notion/) plugin: mirrors
`data/applications.md` into a Notion database (`export`) and can pull leads with a job
`URL` back into the pipeline (`search`). `data/applications.md` stays the source of
truth throughout — Notion is an opt-in mirror, not a replacement backend.

## 1. Create the Notion integration

1. Go to [notion.so/my-integrations](https://www.notion.so/my-integrations) → **New integration**.
2. Type: **Internal** integration, associated with your workspace.
3. **Capabilities** — this is the part people get wrong, since Notion integrations
   default to zero access. Based on exactly what the plugin's API calls need:

   | Capability | Set to | Why |
   |---|---|---|
   | Read content | ✅ On | `export` looks up existing rows before upserting; `search` queries the DB |
   | Update content | ✅ On | `export` patches an existing Company+Role row's properties |
   | Insert content | ✅ On | `export` creates a new page when no matching row exists yet |
   | Read comments | ❌ Off | never called |
   | Insert comments | ❌ Off | never called |
   | User information | **No user information** (most restrictive) | the plugin never reads profiles or emails |

4. Save, then copy the **Internal Integration Secret** (starts `secret_` or `ntn_`) —
   this becomes `NOTION_ACCESS_TOKEN`.

## 2. Build the database

1. In Notion, create a page named **"Career Ops"** (any parent is fine — this page is
   just a container the plugin walks for child databases).
2. Under it, add a database named **exactly** `Applications` — the plugin resolves it
   by this literal name (`resolveDBs()` in `_notion.mjs`) and throws if it's missing
   rather than creating it for you.
3. Give it these properties, with these **exact types** (the plugin writes typed
   property payloads, so a mismatched type will fail on export):

   | Property | Type | Notes |
   |---|---|---|
   | `Role` | **Title** | Must be the database's title property — the plugin sends `{ title: [...] }` for it |
   | `Company` | Text (rich text) | |
   | `Status` | Select | New option values are created automatically on first write if they don't exist yet, as long as Update content is on |
   | `Score` | Number | |
   | `URL` | URL | Only populated if *you* fill it in manually — `export` never sets it. `search` only returns rows that have this set |

4. Share the **Career Ops page** (not just the database) with your integration:
   page **•••** menu → **Connections** → add your integration by name.

## 3. Get the parent page ID

Open the Career Ops page in the browser and copy the 32-character id from the URL
(the segment right before any `?v=` query string) — this becomes
`NOTION_PARENT_PAGE_ID`.

## 4. Enable the plugin locally

```bash
cp config/plugins.example.yml config/plugins.yml   # if you haven't already
```

Edit `config/plugins.yml`:

```yaml
notion:
  enabled: true
```

## 5. Add secrets to `.env`

```
NOTION_ACCESS_TOKEN=secret_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
NOTION_PARENT_PAGE_ID=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

## 6. Verify + run

```bash
node doctor.mjs --json                          # confirm notion shows configured
node plugins.mjs run notion export --dry-run     # preview what would be pushed
node plugins.mjs run notion export               # push tracker rows into Notion
```

Optional — pull leads that have a URL back into the pipeline:

```bash
node plugins.mjs run notion search "<query>"
```

## Scope, honestly

- `export` mirrors **four fields only**: Role, Company, Status, Score. It never sets
  `URL`, and it never touches notes, salary, or follow-up data — those stay
  Notion-only if you add them there.
- `search` is a separate lead-discovery path, not a sync-back of exported rows —
  rows `export` creates are deliberately excluded from `search` results (they have no
  `URL`), so there's no accidental round-trip loop.
- Once rows exist in the database, Notion's native views (Board grouped by Status,
  Calendar, filters/sorts) work for free on top — those are just views over whatever
  properties exist, independent of what the plugin writes.

## Career records sync (fork)

The plugin above mirrors the tracker *into* Notion. The `notion-sync` mode goes the
other way: it reads the career records you keep in Notion (profile, career history and
employer pages, claims to confirm, interests, professional examples) and proposes the
local files the evaluation and draft modes read from them. It runs inside an agent
session through the session's Notion connector, not through this plugin's integration
token, and it never writes to Notion.

1. Copy `config/notion-map.example.yml` to `config/notion-map.yml` in the data root and
   replace every placeholder URL with your own pages. The file is user layer and
   gitignored; keep the keys, the mode refers to them by name.
2. Run `/career-ops notion-sync` (or ask for "sync my Notion records"). The mode fetches
   the mapped pages, applies the factual rules in `modes/notion-sync.md` (an open
   "Claims to Confirm" item is used only through its "Use now" wording; interests keep
   the date they were recorded and ask for a `confirmed_on`; study notes and role
   expectations never become claims), and saves one proposal JSON under
   `output/notion-sync/`.
3. It then runs `node notion-sync-apply.mjs --proposal <file> --dry-run` and shows the
   diff per target: `modes/_context.md`, the `preferences` and `interests` blocks of
   `config/profile.yml` (every other byte of that file is kept), `article-digest.md`,
   `config/cv-facts.json` (sorted unions) and `data/career-profile.yml` (facts appended
   as `needs_review`, to verify in `master-profile`).
4. Only after your explicit yes does it run the same command with `--apply`. Applying the
   same proposal twice changes nothing.

No `NOTION_ACCESS_TOKEN` is needed for this sync; the connector's own authorization is
what reads the pages. If the session has no Notion connector, the mode stops and says so
before reading or writing anything.
