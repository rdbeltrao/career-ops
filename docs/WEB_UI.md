# Career-ops Web UI Launcher Documentation

Career-ops includes a local-first web interface located in the `web/` directory. The `npm run ui` launcher script (`scripts/ui-server.mjs`) provides a zero-setup daemon to start the local Next.js server, verify environment readiness, canonically resolve the career-ops data root, and open the dashboard in your default browser.

---

## Getting Started

The web UI has its own dependencies. Install them once:

```bash
npm --prefix web ci
```

Then launch the local web server and open the browser dashboard:

```bash
npm run ui
```

The server starts locally on `http://127.0.0.1:3000` by default and automatically opens your browser once the server is ready.

---

## CV and context workspace

Open **Context** to organize career records, or **CV** to edit the base CV. Both
use the same Lexical editor. The page sidebar groups career context, achievements,
targeting notes, CVs, professional examples and writing rules. Document headings
appear as nested pages; search filters their titles while retaining their parents.

Select a page to edit its body. Use **New child page**, **Rename page**, and the
page move controls to organize sections. The editor provides formatting, lists,
links, callouts, undo/redo, a `/` command menu and block reordering. **Save** writes
the change; opening or navigating a saved document does not rewrite it.

Markdown remains the source of truth. Context edits go to `modes/_context.md`,
the base CV to `cv.md`, and the other documents retain their existing user-layer
files. Editing a section preserves the rest of its document. Each replacement
uses the existing atomic-write and backup helper. If another tool changed the
file after it was opened, saving reports a conflict and retains the local draft.
Unsaved text and page titles can be recovered in the same browser tab after
navigation or reload. Recovery requires an explicit restore and retains the
original file revision, so it cannot overwrite a newer file silently.

Some Markdown, including tables and raw HTML, cannot yet round-trip safely through
the visual editor. Those pages open in **Source** mode with the original text
intact. Supported sections of the same document can still use visual editing.
Context remains the authority for career facts; targeting notes, derived stories
and procedural guidance keep their existing roles. This workspace does not sync
or import Notion automatically. **Documents** and **Pipeline** remain the homes
for generated files and applications.

---

## Command-Line Options

You can pass command-line options directly to `npm run ui`:

| Flag | Default | Description |
|---|:---:|---|
| `--port=<number>` or `--port <number>` | `3000` | Custom port to listen on. |
| `--host=<ip>` or `--host <ip>` | `127.0.0.1` | Network interface host (default: `127.0.0.1`; network exposure requires `CAREER_OPS_WEB_ALLOWED_HOSTS`). |
| `--no-open` or `--noopen` | `false` | Start the server without opening the browser automatically. |

### Examples

```bash
# Run on a custom port
npm run ui -- --port=3030

# Start without automatically launching a browser
npm run ui -- --no-open
```

---

## Process Lifecycle & Architecture

- **Canonical Data Root Resolution**: The launcher resolves the user data directory using `path-resolver.mjs` (`CAREER_OPS_ROOT` / `CAREER_OPS_DATA_DIR` / `.career-ops-data`), ensuring the web application reads and writes user-layer files according to the Data Contract.
- **Readiness Polling**: Polls the server until it responds before launching the browser, draining responses properly via `res.resume()`.
- **Graceful Shutdown**: Handles `SIGINT` (Ctrl+C) and `SIGTERM` signals cleanly across Linux, macOS, and Windows (terminating the launched child process and waiting for shutdown before exiting).

