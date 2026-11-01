import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs';import path from 'node:path';import os from 'node:os';
import { parseCareerPeriod, careerChronology, validateCvPublication, validateCvChronology, reviewedCvForReport, reviewFinalPdf } from '../lib/cv-publication.mjs';
import { reviewedCvFixture } from './fixtures/reviewed-cv.mjs';
import { chromium } from 'playwright';

function fixture(t) { const root=fs.mkdtempSync(path.join(os.tmpdir(),'cv-review-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root; }
const source='Led the migration and improved delivery reliability.';
const job='Lead an engineering team. Improve production reliability. Partner with Product on priorities.';
const quotes=['Lead an engineering team','Improve production reliability','Partner with Product on priorities'];
const payload={candidate:{name:'Ada Example'},summary:source,experience:[{company:'Example',role:'Manager',dates:'Jan 2020 – Present',bullets:[source]}],tailoring:{requirements:quotes.map(requirement=>({requirement,jdQuote:requirement,match:'supported',evidence:[{source:'facts.md',quote:source}],placements:[{section:'summary',claim:source}]}))}};
const brief={chronology:[{company:'Example',dates:'January 2020 – Present',period:parseCareerPeriod('January 2020 – Present'),source:'facts.md'}],criticalRequirements:[],evidence:[{source:'facts.md',text:source}]};

test('dates require a complete valid period and preserve source precision',()=>{
 for(const x of['','Present','2025','2025-13 – Present','May 2025 – March 2024'])assert.equal(parseCareerPeriod(x),null,x);
 assert.deepEqual(parseCareerPeriod('01/2020 – Present'),parseCareerPeriod('January 2020 – Present'));
 assert.equal(validateCvChronology([{company:'Example',dates:'2020 – Present'}],brief.chronology).length,1);
 assert.equal(validateCvChronology([{company:'Example',dates:'Jan 2020 – Present'}],brief.chronology).length,0);
});

test('eligible periods survive adjacent uncertainty, uncertain periods and reference pages never enter chronology',t=>{
 const root=fixture(t);fs.mkdirSync(path.join(root,'data/context-workspace/pages'),{recursive:true});
 const ids={root:'a'.repeat(32),facts:'b'.repeat(32),held:'c'.repeat(32),ref:'d'.repeat(32),scoped:'e'.repeat(32)};
 const pages=[{id:'root',title:'Career',parentId:null,order:0,usage:'reference'},{id:'facts',title:'Example — Manager',parentId:'root',order:0,usage:'facts'},{id:'held',title:'Held — Manager',parentId:'root',order:1,usage:'facts'},{id:'ref',title:'Reference — Manager',parentId:'root',order:2,usage:'reference'},{id:'scoped',title:'Scoped — Manager',parentId:'root',order:3,usage:'facts'}];
 fs.writeFileSync(path.join(root,'data/context-workspace/index.json'),JSON.stringify({version:1,rootId:ids.root,pages:pages.map(p=>({...p,id:ids[p.id],parentId:p.parentId?ids[p.parentId]:null}))}));
 for(const p of pages)fs.writeFileSync(path.join(root,`data/context-workspace/pages/${ids[p.id]}.md`),`${p.id==='scoped'?'# Claims to Confirm\n\n':''}## Role record\n\n- **Period:** ${p.id==='held'?'Unconfirmed: ':''}January 2020 – Present.\n- **Scope:** Approximately 20 engineers.\n\n# Work\n\nLed delivery improvements.`);
 const records=careerChronology(root);assert.equal(records.length,1);assert.equal(records[0].company,'Example');
});

test('publication rejects missing/conflicting dates, generic tailoring and invented evidence',()=>{
 assert.doesNotThrow(()=>validateCvPublication(payload,{dataRoot:'unused',report:`## Job Description\n${job}`,brief}));
 for(const change of[
  p=>p.experience[0].dates='',
  p=>p.experience=[],
  p=>p.experience[0].dates='Jan 2022 – Present',
  p=>delete p.tailoring,
  p=>p.tailoring.requirements[0].evidence[0].source='reference.md',
  p=>p.tailoring.requirements[0].evidence[0].quote='Invented performance improvement',
  p=>p.tailoring.requirements[0].placements[0].claim='A claim absent from the actual CV',
  p=>p.tailoring.requirements[0].jdQuote='An unrelated benefit or navigation link',
 ]){const p=structuredClone(payload);change(p);assert.throws(()=>validateCvPublication(p,{dataRoot:'unused',report:`## Job Description\n${job}`,brief}),/publication blocked/);}
 const conflicting={...brief,chronology:[...brief.chronology,{...brief.chronology[0],period:parseCareerPeriod('Jan 2021 – Present')}]};
 assert.throws(()=>validateCvPublication(payload,{dataRoot:'unused',report:job,brief:conflicting}),/conflicting source periods/);
});

test('real gaps remain explicit without claiming the missing skill',()=>{
 const p=structuredClone(payload);p.tailoring.requirements[0]={requirement:quotes[0],jdQuote:quotes[0],match:'gap',gap:'No direct evidence of this requirement.',evidence:[],placements:[]};
 assert.equal(validateCvPublication(p,{dataRoot:'unused',report:job,brief}).gaps.length,1);
 delete p.tailoring.requirements[0].gap;assert.throws(()=>validateCvPublication(p,{dataRoot:'unused',report:job,brief}),/remaining gap/);
});

test('readiness rejects missing review, changed PDF, report and career context',t=>{
 const root=fixture(t);fs.mkdirSync(path.join(root,'data'));const pdf=path.join(root,'output/1.pdf');
 fs.writeFileSync(path.join(root,'data/pdf-index.tsv'),'1\toutput/1.pdf\t\ta4\t2026-11-01\tcv\n');
 assert.throws(()=>reviewedCvForReport(root,1));reviewedCvFixture(root,1,pdf);assert.doesNotThrow(()=>reviewedCvForReport(root,1));
 fs.appendFileSync(pdf,'changed');assert.throws(()=>reviewedCvForReport(root,1),/stale: pdf/);
 const f=reviewedCvFixture(root,1,pdf);fs.appendFileSync(f.reportFile,'changed');assert.throws(()=>reviewedCvForReport(root,1),/stale: report/);
 reviewedCvFixture(root,1,pdf);fs.mkdirSync(path.join(root,'modes'));fs.writeFileSync(path.join(root,'modes/_context.md'),'New career evidence.');assert.throws(()=>reviewedCvForReport(root,1),/career evidence changed/);
});

test('actual PDF review detects missing dates/text, page overflow and out-of-bounds text',async()=>{
 const browser=await chromium.launch({headless:true});try{
  const page=await browser.newPage();const sentence='A complete source-backed statement describing engineering leadership and delivery outcomes for this example application.';
  await page.setContent(`<p>Ada Example</p><p>Jan 2020 – Present</p><p>${sentence.repeat(4)}</p>`);
  const buffer=await page.pdf();const p={candidate:{name:'Ada Example'},summary:sentence};assert.equal((await reviewFinalPdf(buffer,p)).pages.length,1);
  await assert.rejects(reviewFinalPdf(buffer,{...p,experience:[{company:'Missing Company',role:'Manager',dates:'Jan 2022 – Present'}]}),/missing expected text/);
  await assert.rejects(reviewFinalPdf(buffer,{...p,tailoring:{requirements:[{placements:[{section:'skills',claim:'Critical proof missing from the rendered skills section'}]}]}}),/missing expected text/);
  await page.setContent(`<p>${sentence.repeat(4)}</p><div style="break-before:page">${sentence.repeat(4)}</div><div style="break-before:page">${sentence.repeat(4)}</div>`);
  await assert.rejects(reviewFinalPdf(await page.pdf(),{}),/maximum is 2/);
  await page.setContent(`<style>@page {size:8in 11in;margin:0}</style><p>${sentence.repeat(4)}</p><p style="position:absolute;left:-60px">Outside page</p>`);
  await assert.rejects(reviewFinalPdf(await page.pdf({preferCSSPageSize:true}),{}),/outside the page bounds/);
 }finally{await browser.close();}
});
