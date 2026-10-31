// Opt-in integration check: starts a loopback app against disposable data.
// RUN_CV_DOWNLOAD_BROWSER=1 node --test tests/lib/cv-download.browser.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

test("generated CV downloads from job details and completed run, using the exact report", {
  skip: process.env.RUN_CV_DOWNLOAD_BROWSER !== "1", timeout: 120_000,
}, async (t) => {
  const web = fileURLToPath(new URL("../../", import.meta.url));
  const root = await mkdtemp(path.join(tmpdir(), "cv-download-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const dir of ["data", "reports", "output", "config"]) await mkdir(path.join(root, dir));
  await writeFile(path.join(root, "config/profile.yml"), "candidate:\n  full_name: Jane Example\n");
  await writeFile(path.join(root, "data/applications.md"), [
    "| # | Date | Company | Role | Score | Status | PDF | Report | Notes |",
    "|---|---|---|---|---|---|---|---|---|",
    "| 309 | 2026-10-31 | Acme | Engineer | 4.5/5 | Evaluated | | [018](../reports/018-acme-2026-10-31.md) | |",
    "| 310 | 2026-10-31 | Acme | Manager | 4.5/5 | Evaluated | | [019](../reports/019-acme-2026-10-31.md) | |",
    "| 311 | 2026-10-31 | Other | Engineer | 4.5/5 | Evaluated | | [020](../reports/020-other-2026-10-31.md) | |",
  ].join("\n"));
  for (const [n, company] of [["018", "acme"], ["019", "acme"], ["020", "other"]]) {
    await writeFile(path.join(root, `reports/${n}-${company}-2026-10-31.md`), `# ${company}\n\n**Global score:** 4.5/5\n`);
  }
  const filename = "cv-jane-018-acme.pdf";
  // Real, synthetic PDF bytes; no candidate data or AI generation needed.
  const pdf = await readFile(new URL("../fixtures/pdf-decorated-cv.pdf", import.meta.url));
  await writeFile(path.join(root, "output", filename), pdf);
  await writeFile(path.join(root, "output/cv-jane-019-acme.pdf"), "different role's PDF");
  await writeFile(path.join(root, "data/pdf-index.tsv"), [
    "# report\tpdf\thtml\tformat\tdate",
    `018\toutput/${filename}\t\ta4\t2026-10-31`,
    "019\toutput/cv-jane-019-acme.pdf\t\ta4\t2026-10-31",
  ].join("\n"));

  const socket = createServer();
  socket.listen(0, "127.0.0.1");
  await once(socket, "listening");
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  const origin = `http://127.0.0.1:${port}`;
  const dist = `.next-cv-download-${process.pid}`;
  const server = spawn(process.execPath, ["server.mjs", "dev", "-p", String(port)], {
    cwd: web,
    env: { ...process.env, CAREER_OPS_ROOT: root, CAREER_OPS_CODE_ROOT: path.resolve(web, ".."),
      CAREER_OPS_PROFILE: path.join(root, "config/profile.yml"), CAREER_OPS_TRACKER: path.join(root, "data/applications.md"),
      CAREER_OPS_PDF_INDEX: path.join(root, "data/pdf-index.tsv"), BUILD_DIST: dist },
    detached: true, stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  for (const stream of [server.stdout, server.stderr]) stream.on("data", chunk => { log = (log + chunk).slice(-6000); });
  t.after(async () => {
    const stopped = once(server, "exit");
    process.kill(-server.pid, "SIGTERM");
    await stopped;
    await rm(path.join(web, dist), { recursive: true, force: true });
    // Next adds custom build directories to the shared TypeScript includes.
    const configPath = path.join(web, "tsconfig.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.include = config.include.filter(value => !value.startsWith(`${dist}/`));
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
  });
  const deadline = Date.now() + 90_000;
  while (true) {
    try { if ((await fetch(`${origin}/api/cv-pdf?n=18`)).ok) break; } catch { /* starting */ }
    assert.ok(server.exitCode === null && Date.now() < deadline, log);
    await new Promise(resolve => setTimeout(resolve, 250));
  }

  const { chromium } = await import("playwright-core");
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ acceptDownloads: true });
  page.setDefaultTimeout(15_000);
  const assertDownload = async () => {
    const before = page.url();
    const [download] = await Promise.all([
      page.waitForEvent("download"), page.getByRole("link", { name: "Download CV (PDF)", exact: true }).click(),
    ]);
    assert.equal(download.suggestedFilename(), filename);
    assert.deepEqual(await readFile(await download.path()), pdf);
    assert.equal(page.url(), before, "download keeps the job page open");
  };

  await page.goto(`${origin}/pipeline/309`);
  assert.match(await page.getByRole("link", { name: "Download CV (PDF)", exact: true }).getAttribute("href"), /[?&]n=18(?:&|$)/);
  assert.equal(await page.getByRole("link", { name: "View tailored CV", exact: true }).count(), 1);
  await assertDownload();
  await page.reload();
  await assertDownload();
  await page.goto(`${origin}/pipeline/311`);
  assert.equal(await page.getByRole("link", { name: "Download CV (PDF)", exact: true }).count(), 0);

  // Exercise the real generation button/provider with a synthetic worker
  // response. PDF serving stays real; no AI process or paid API is launched.
  await page.route("**/api/clis", route => route.fulfill({ json: { clis: [{ id: "claude", installed: true }] } }));
  await page.route("**/api/runs/save", route => route.fulfill({ json: { ok: true } }));
  let finishRun;
  let completion = { type: "done", reportN: 18 };
  await page.route("**/api/run", async route => {
    await new Promise(resolve => { finishRun = resolve; });
    await route.fulfill({ contentType: "application/x-ndjson", body: `${JSON.stringify(completion)}\n` });
  });
  await page.goto(`${origin}/pipeline/309`);
  await page.getByTitle("Regenerate the tailored CV", { exact: true }).click();
  await page.getByRole("link", { name: "Generating CV…", exact: true }).click();
  assert.equal(await page.getByRole("link", { name: "Download CV (PDF)", exact: true }).count(), 0);
  await page.waitForFunction(() => document.querySelector("h1")?.textContent === "CV PDF · Acme");
  // The CLI lookup is asynchronous; wait until the fake run actually starts.
  const runDeadline = Date.now() + 10_000;
  while (!finishRun) {
    assert.ok(Date.now() < runDeadline, "generation request starts");
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  finishRun();
  await assertDownload();
  await page.goBack();
  await assertDownload();

  finishRun = null;
  completion = { type: "error", msg: "Synthetic generation failure" };
  await page.getByTitle("Regenerate the tailored CV", { exact: true }).click();
  await page.getByRole("link", { name: "Generating CV…", exact: true }).click();
  const failureDeadline = Date.now() + 10_000;
  while (!finishRun) {
    assert.ok(Date.now() < failureDeadline, "generation retry starts");
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  finishRun();
  await page.getByRole("main").getByText("Synthetic generation failure", { exact: true }).waitFor();
  assert.equal(await page.getByRole("link", { name: "Download CV (PDF)", exact: true }).count(), 0);
});
