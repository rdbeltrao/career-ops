import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { listTree } from "../../../lib/walk-tree.mjs";

// EVIDENCE: Next deployment manifests list paths relative to each .nft.json.
// https://nextjs.org/docs/app/api-reference/config/next-config-js/output
// npm's postbuild hook checks every build; CAREER_OPS_TRACE_BUILD also allows
// checking an existing output directory. Runtime data is never a build asset.
const buildDirectory = process.env.CAREER_OPS_TRACE_BUILD
  || (process.env.npm_lifecycle_event === "postbuild" ? process.env.BUILD_DIST || ".next" : "");

test("production traces exclude project instructions, config and test sources", {
  skip: !buildDirectory && "requires a production build; set CAREER_OPS_TRACE_BUILD",
}, () => {
  const build = path.resolve(buildDirectory);
  const manifests = listTree(build, { match: /\.nft\.json$/ });
  assert.ok(manifests.length > 0, "production build must contain deployment traces");
  const unexpected = [];
  for (const manifest of manifests) {
    const { files } = JSON.parse(fs.readFileSync(manifest, "utf8"));
    assert.ok(Array.isArray(files), `${manifest}: missing trace file list`);
    for (const entry of files) {
      const normalized = entry.replaceAll("\\", "/");
      if (/(?:^|\/)node_modules\//.test(normalized)) continue;
      if (/(?:^|\/)(?:AGENTS\.md|next\.config\.mjs)$/.test(normalized)
        || /(?:^|\/)tests\/.*\.test\.mjs$/.test(normalized)) {
        unexpected.push(`${manifest}: ${normalized}`);
      }
    }
  }
  assert.equal(unexpected.length, 0, `Unrelated project files included in deployment traces:\n${unexpected.slice(0, 12).join("\n")}`);
});
