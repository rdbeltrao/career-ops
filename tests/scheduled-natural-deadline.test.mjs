import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { executeJob } from '../web/scripts/scheduled-jobs-runner.mjs';
import { runScheduledScanner } from '../web/src/lib/scheduled-scan-process.mjs';

const codeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const moduleUrl = name => JSON.stringify(pathToFileURL(path.join(codeRoot, name)).href);

for (const engine of ['full', 'linkedin']) {
  test(`${engine} exits naturally at its work deadline and preserves its receipt`, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-natural-deadline-'));
    try {
      fs.mkdirSync(path.join(root, 'data/cache/ats-companies'), { recursive: true });
      fs.writeFileSync(path.join(root, 'portals.yml'), 'title_filter:\n  positive: [Engineer]\ntracked_companies:\n  - name: Fixture\n    provider: linkedin-browser\n    search_url: https://www.linkedin.com/jobs/search/\n');
      fs.writeFileSync(path.join(root, 'data/cache/ats-companies/greenhouse.json'), JSON.stringify(['ready', 'hung']));
      const launcher = path.join(root, 'launch.mjs');
      const body = engine === 'full' ? `
        import provider from ${moduleUrl('providers/greenhouse.mjs')};
        provider.fetchListing = async entry => entry.name === 'ready' ? [] : new Promise(() => {});
      ` : `
        import provider, {walkSearch,parseCards,parseDetail} from ${moduleUrl('providers.local/linkedin-browser.mjs')};
        const html = fs.readFileSync(${JSON.stringify(path.join(codeRoot, 'tests/fixtures/linkedin/list.html'))}, 'utf8');
        const cards = parseCards(html);
        provider.fetch = async (entry,ctx) => {
          const heartbeat = setInterval(()=>{},100);
          const locator = {first(){return this},count:async()=>1,innerHTML:async()=>html};
          const page = {url:()=>entry.search_url,goto:async()=>{},waitForTimeout:async()=>{},waitForSelector:async()=>{},evaluate:async()=>0,locator:()=>locator};
          let read = 0;
          try {return await walkSearch(page,{entry:{...entry,resolve_apply_url:false},searchUrl:entry.search_url,maxPages:1,seenPath:${JSON.stringify(path.join(root, 'data/seen.json'))},applyRoot:${JSON.stringify(root)},dryRun:false,pause:async()=>{},signal:ctx.signal,deadlineMs:ctx.deadlineMs,
            readDetail:async(_page,id)=>{
              if(++read>1)return new Promise(()=>{});
              const card=cards.find(c=>c.id===id);
              return '<h1><a href="/jobs/view/'+id+'/">'+card.title+'</a></h1><div class="job-details-jobs-unified-top-card__company-name">'+card.company+'</div><div id="job-details">Lead engineers.</div>';
            }});
          }finally{clearInterval(heartbeat);}
        };
      `;
      fs.writeFileSync(launcher, `import fs from 'node:fs';
        process.env.CAREER_OPS_NO_AUTO_JEV='1';
        ${body}
        process.argv[1]=${JSON.stringify(path.join(codeRoot, engine === 'full' ? 'scan-ats-full.mjs' : 'scan.mjs'))};
        await import(${moduleUrl(engine === 'full' ? 'scan-ats-full.mjs' : 'scan.mjs')});
      `);
      let processResult;
      const result = await executeJob(root, { id: '11111111-1111-4111-8111-111111111111', engine, filters: { ats: ['greenhouse'] } }, {
        timeoutMs: 2000, sessionFn: () => ({ state: 'signed-in' }),
        spawnFn: async (command, args, options) => {
          processResult = await runScheduledScanner(command, [launcher, ...args.slice(1)], options);
          return processResult;
        },
      });
      assert.equal(result.state, 'partial', JSON.stringify(result));
      assert.equal(processResult.error, undefined, 'work must stop before the hard process deadline');
      assert.equal(result.diagnostics.stoppedEarly, true);
      assert.equal(result.diagnostics.receiptPresent, true);
      if (engine === 'full') {
        assert.equal(result.rolesFound, 0);
        assert.equal(JSON.parse(processResult.stdout).coverage.companiesCompleted, 1);
      } else {
        const receipt = JSON.parse(processResult.stdout);
        assert.ok(receipt.found >= 1);
        assert.deepEqual(receipt.errors, [], 'budget stops are not source errors');
        assert.deepEqual(receipt.unverified_zero, [], 'unstarted searches are not empty results');
        assert.equal(receipt.incomplete_sources.length, 1);
        assert.match(result.message, /time budget reached/);
      }
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
}
