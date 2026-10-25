import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import "../helpers/web-ts-alias-loader.mjs";

const { unsupportedRewriteClaims } = await import("../../src/lib/cv-studio/server.ts");
const codeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

test("Classic and visual rewrite gate reads current Context and ignores old CV metrics", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "context-web-gate-"));
  const previous = { root: process.env.CAREER_OPS_ROOT, codeRoot: process.env.CAREER_OPS_CODE_ROOT };
  t.after(() => {
    for (const [name, value] of [["CAREER_OPS_ROOT", previous.root], ["CAREER_OPS_CODE_ROOT", previous.codeRoot]]) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  process.env.CAREER_OPS_ROOT = root;
  process.env.CAREER_OPS_CODE_ROOT = codeRoot;
  const id = "d".repeat(32);
  const directory = path.join(root, "data/context-workspace");
  fs.mkdirSync(path.join(directory, "pages"), { recursive: true });
  fs.writeFileSync(path.join(directory, "index.json"), JSON.stringify({ version: 1, rootId: id, pages: [{ id, parentId: null, order: 0, title: "Career facts", usage: "facts" }] }));
  const facts = path.join(directory, "pages", `${id}.md`);
  fs.writeFileSync(facts, "Reduced deployment time by 23%.");
  // The library alone is sufficient; no cv.md exists yet.
  assert.deepEqual(await unsupportedRewriteClaims("Reduced deployment time by 23%", "Reduced deployment time by 23%"), []);
  fs.writeFileSync(path.join(root, "cv.md"), "Reduced deployment time by 91%.");
  assert.deepEqual(await unsupportedRewriteClaims("Reduced deployment time by 91%", "Reduced deployment time by 91%"), ["91%"]);
  fs.writeFileSync(facts, "Reduced deployment time by 29%.");
  assert.deepEqual(await unsupportedRewriteClaims("Reduced deployment time by 29%", "Reduced deployment time by 29%"), []);
  assert.deepEqual(await unsupportedRewriteClaims("Reduced deployment time by 23%", "Reduced deployment time by 23%"), ["23%"]);
  // Current facts elsewhere cannot move into this selected bullet.
  assert.deepEqual(await unsupportedRewriteClaims("Reduced deployment time by 29%", "Improved deployment reliability"), ["29%"]);
  fs.rmSync(facts);
  await assert.rejects(unsupportedRewriteClaims("Reduced deployment time by 91%", "Reduced deployment time by 91%"));
});
