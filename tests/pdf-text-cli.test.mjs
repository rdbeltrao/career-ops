import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../lib/pdf-text.mjs', import.meta.url));

for (const flag of ['--help', '-h']) {
  test(`PDF text extraction ${flag} prints usage without opening a PDF`, () => {
    const result = spawnSync(process.execPath, [script, flag], {
      encoding: 'utf8', timeout: 10_000,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^Usage:.*<file\.pdf>/m);
    assert.equal(result.stderr, '');
  });
}
