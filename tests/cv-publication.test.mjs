import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs';import path from 'node:path';import os from 'node:os';
import { parseCareerPeriod, careerChronology, criticalRequirements, validateCvPublication, validateCvChronology, reviewedCvForReport, reviewFinalPdf, evidenceAddressesRequirement, missingTechnologyEvidence, technologiesNamed, hasMonthLevelDates, postingRole, headlineLevelError, isLogisticsRequirement, reportReviewText, currentEvidenceHash, evidenceHashFor, citedEvidenceSources, citedChronologySources } from '../lib/cv-publication.mjs';
import { reviewedCvFixture } from './fixtures/reviewed-cv.mjs';
import { chromium } from 'playwright';

function fixture(t) { const root=fs.mkdtempSync(path.join(os.tmpdir(),'cv-review-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root; }
// Evidence must share content words with the requirement it supports, so the
// fixture statement names the team, the reliability work and the Product partnership.
const source='Led an engineering team through the migration, improved production reliability and partnered with Product on priorities.';
const job='Lead an engineering team. Improve production reliability. Partner with Product on priorities.';
const quotes=['Lead an engineering team','Improve production reliability','Partner with Product on priorities'];
const payload={candidate:{name:'Ada Example'},summary:source,experience:[{company:'Example',role:'Manager',dates:'Jan 2020 – Present',bullets:[source]}],tailoring:{requirements:quotes.map(requirement=>({requirement,jdQuote:requirement,match:'supported',evidence:[{source:'facts.md',quote:source}],placements:[{section:'summary',claim:source}]}))}};
const brief={chronology:[{company:'Example',dates:'January 2020 – Present',period:parseCareerPeriod('January 2020 – Present'),source:'facts.md'}],criticalRequirements:[],evidence:[{source:'facts.md',text:source}]};

test('critical requirements tolerate empty YAML summaries and reject malformed content', () => {
 const report = yaml => `## Machine Summary\n\n\`\`\`yaml\n${yaml}\n\`\`\``;
 for (const yaml of ['', '# No requirements recorded yet']) assert.deepEqual(criticalRequirements(report(yaml)), []);
 assert.deepEqual(criticalRequirements(report('requirement_importance:\n  - requirement: Lead delivery\n    jd_signal: Lead an engineering team\n    importance: critical'), job), [
  { requirement: 'Lead delivery', jdSignal: 'Lead an engineering team', jdQuote: 'Lead an engineering team', importance: 'critical' },
 ]);
 assert.throws(() => criticalRequirements(report('requirement_importance: [unclosed')), { name: 'YAMLException' });
});

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

test('publication requires archive quotes even when analysis contains translated signals',t=>{
 const root=fixture(t);fs.mkdirSync(path.join(root,'jds'));
 fs.writeFileSync(path.join(root,'jds/example.md'),job);
 const report=`## Job Description (archived verbatim)\nSee jds/example.md for the full archive.\n## Machine Summary\n\`\`\`yaml\nrequirement_importance:\n${quotes.map((requirement,i)=>`  - requirement: ${requirement}\n    jd_signal: Translated analysis signal number ${i}\n    importance: critical`).join('\n')}\n\`\`\``;
 assert.doesNotThrow(()=>validateCvPublication(payload,{dataRoot:root,report,brief}));
 const p=structuredClone(payload);p.tailoring.requirements.forEach((entry,i)=>{entry.jdQuote=`Translated analysis signal number ${i}`;});
 assert.throws(()=>validateCvPublication(p,{dataRoot:root,report,brief}),error=>{
  for(let i=1;i<=3;i++)assert.ok(error.message.includes(`Requirement ${i}: quote must occur in the archived job description.`));return true;
 });
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
  await assert.rejects(reviewFinalPdf(await page.pdf(),{}),/Final PDF has 3 pages; the cap is 2/);
  await page.setContent(`<style>@page {size:8in 11in;margin:0}</style><p>${sentence.repeat(4)}</p><p style="position:absolute;left:-60px">Outside page</p>`);
  await assert.rejects(reviewFinalPdf(await page.pdf({preferCSSPageSize:true}),{}),/outside the page bounds/);
 }finally{await browser.close();}
});

const machineReport=(items,role='Engineering Manager')=>`**Role:** ${role}\n## Job Description\n${job}\n## Machine Summary\n\`\`\`yaml\nrole: ${role}\nrequirement_importance:\n${items.map(([requirement,signal,importance])=>`  - requirement: ${requirement}\n    jd_signal: ${signal}\n    importance: ${importance}`).join('\n')}\n\`\`\``;

test('critical requirements return every critical and high requirement in sort order, capped at eight',()=>{
 const items=[['Low one','Partner with Product on priorities','low'],['High one','Improve production reliability','high'],['Meaningful one','Lead an engineering team','meaningful'],['Critical one','Lead an engineering team','critical'],['High two','Improve production reliability','high'],['Critical two','Partner with Product on priorities','critical']];
 assert.deepEqual(criticalRequirements(machineReport(items),job).map(x=>x.requirement),['Critical one','Critical two','High one','High two']);
 const many=Array.from({length:12},(_,i)=>[`Critical ${i}`,'Lead an engineering team','critical']);
 assert.equal(criticalRequirements(machineReport(many),job).length,8);
});

test('every supplied critical requirement must be addressed; high requirements are optional but validated when present',()=>{
 const supplied=[{requirement:quotes[0],jdSignal:quotes[0],jdQuote:quotes[0],importance:'critical'},{requirement:quotes[1],jdSignal:quotes[1],jdQuote:quotes[1],importance:'critical'},{requirement:quotes[2],jdSignal:quotes[2],jdQuote:quotes[2],importance:'high'}];
 const full={...brief,criticalRequirements:supplied};
 const report=`## Job Description\n${job}`;
 assert.doesNotThrow(()=>validateCvPublication(payload,{dataRoot:'unused',report,brief:full}));
 const twoCritical=structuredClone(payload);twoCritical.tailoring.requirements.pop();
 assert.doesNotThrow(()=>validateCvPublication(twoCritical,{dataRoot:'unused',report,brief:full}),'the high requirement is optional');
 const missingCritical=structuredClone(payload);missingCritical.tailoring.requirements.splice(1,1);
 assert.throws(()=>validateCvPublication(missingCritical,{dataRoot:'unused',report,brief:full}),new RegExp(`Critical requirement not addressed: ${quotes[1]}`));
 const badHigh=structuredClone(payload);badHigh.tailoring.requirements[2].jdQuote='Not in the posting at all';
 assert.throws(()=>validateCvPublication(badHigh,{dataRoot:'unused',report,brief:full}),/Requirement 3: quote must occur in the archived job description/);
 const stranger=structuredClone(payload);stranger.tailoring.requirements.push({...stranger.tailoring.requirements[0],requirement:'Something the brief never listed',jdQuote:quotes[0]});
 assert.throws(()=>validateCvPublication(stranger,{dataRoot:'unused',report,brief:full}),/Requirement 4: must address the supplied critical requirements/);
 const five=Array.from({length:5},(_,i)=>({requirement:`Critical ${i}`,jdSignal:quotes[0],jdQuote:quotes[0],importance:'critical'}));
 assert.throws(()=>validateCvPublication(payload,{dataRoot:'unused',report,brief:{...brief,criticalRequirements:five}}),error=>{
  for(let i=0;i<5;i++)assert.ok(error.message.includes(`Critical requirement not addressed: Critical ${i}`));return true;
 });
});

test('evidence must address the requirement it is quoted for, not merely exist in a source',()=>{
 assert.equal(evidenceAddressesRequirement('Led an engineering team through the migration','Lead an engineering team'),true);
 assert.equal(evidenceAddressesRequirement('Improved production reliability','Lead an engineering team','Improve production reliability'),true,'the jd_signal counts');
 assert.equal(evidenceAddressesRequirement('Managing engineers day to day','Engineering management'),true,'stems fold leading/lead and managing/management');
 assert.equal(evidenceAddressesRequirement('Experience with years of strong work','5+ years of strong experience with Python'),false,'stop words and requirement boilerplate never count');
 assert.equal(missingTechnologyEvidence(['PHP, including Laravel and Symfony; server-side application design and REST APIs.'],'5+ years software development, ideally Python'),'evidence names none of the required technologies (python)');
 assert.equal(missingTechnologyEvidence(['Core technologies: React, React Native, Node.js.'],'Excellent knowledge of Node.js, JavaScript, and TypeScript'),null,'one named technology is enough');
 assert.equal(missingTechnologyEvidence(['Built an engineering team with clear career paths'],'Grown engineers to the next level through hard conversations'),null,'no technology asked, nothing to block');
 assert.deepEqual([...technologiesNamed('Strong proficiency in C#/.NET and Golang; k8s a plus')].sort(),['.net','c#','go','kubernetes']);
 assert.deepEqual([...technologiesNamed('We go to market fast')],[],'the word go in prose is not the language');
 const weak=structuredClone(payload);weak.tailoring.requirements[0].evidence[0].quote='improved production reliability and partnered with Product';
 const result=validateCvPublication(weak,{dataRoot:'unused',report:`## Job Description\n${job}`,brief});
 assert.ok(result.weakEvidence.some(x=>/Requirement 1: evidence shares no wording/.test(x)),'a quote with no shared wording is reported, not blocked');
 const tech=structuredClone(payload);tech.tailoring.requirements[0].requirement='Lead an engineering team working in Python';
 assert.throws(()=>validateCvPublication(tech,{dataRoot:'unused',report:`## Job Description\n${job}`,brief}),/Requirement 1: evidence names none of the required technologies \(python\)/);
 const invented=structuredClone(payload);invented.tailoring.requirements[0].evidence[0].quote='Led an engineering team at an invented employer';
 assert.throws(()=>validateCvPublication(invented,{dataRoot:'unused',report:`## Job Description\n${job}`,brief}),error=>{
  assert.match(error.message,/evidence must quote an eligible career source/);assert.doesNotMatch(error.message,/does not address/);return true;
 });
});

test('every experience entry needs month-level start and end dates',()=>{
 for(const ok of['January 2020 – March 2023','Jan 2020 - Present','01/2020 – 03/2023','1/2020 – Present','2020-01 – 2023-03','2020-01 – Present','März 2020 – heute'])assert.equal(hasMonthLevelDates(ok),true,ok);
 for(const bad of['2020 – 2023','2020 – Present','January 2020 – 2023','2020-13 – Present','13/2020 – Present','January 2020','',undefined])assert.equal(hasMonthLevelDates(bad),false,String(bad));
 const yearOnly={...brief,chronology:[{company:'Example',dates:'2020 – Present',period:parseCareerPeriod('2020 – Present'),source:'facts.md'}]};
 const p=structuredClone(payload);p.experience[0].dates='2020 – Present';
 assert.throws(()=>validateCvPublication(p,{dataRoot:'unused',report:`## Job Description\n${job}`,brief:yearOnly}),/^(?=[^]*Example: dates must name the month and year)(?![^]*must match)/);
 const period=structuredClone(payload);delete period.experience[0].dates;period.experience[0].period='Jan 2020 – Present';
 assert.doesNotThrow(()=>validateCvPublication(period,{dataRoot:'unused',report:`## Job Description\n${job}`,brief}));
});

test('headline level above the posting title is rejected; equal, lower or unreadable levels pass',()=>{
 assert.equal(postingRole('**Role:** Head of Engineering\n## Machine Summary\n```yaml\nrole: Other\n```'),'Head of Engineering');
 assert.equal(postingRole('## Machine Summary\n```yaml\ncompany: X\nrole: "Engineering Manager (m/w/d)"\n```'),'Engineering Manager (m/w/d)');
 assert.equal(postingRole('# Evaluation: nothing to read here'),null);
 assert.equal(headlineLevelError('Senior Engineering Manager','Engineering Manager'),'Headline level above the posting title: Senior Engineering Manager vs Engineering Manager');
 assert.equal(headlineLevelError('Head of Engineering','Engineering Manager (Team Lead)'),'Headline level above the posting title: Head of Engineering vs Engineering Manager (Team Lead)');
 assert.equal(headlineLevelError('VP Engineering','Director of Engineering'),'Headline level above the posting title: VP Engineering vs Director of Engineering');
 for(const [headline,role] of[['Head of Engineering','Director of Engineering'],['Director of Engineering','Head of Platform'],['Senior Engineering Manager','Senior Engineering Manager'],['Engineering Manager','Team Lead Backend'],['Engineering Manager','Lead Engineer'],['Engineering Manager','Head of Engineering'],['Sr. Engineering Manager','Senior Engineering Manager']])assert.equal(headlineLevelError(headline,role),null,`${headline} vs ${role}`);
 const p=structuredClone(payload);p.candidate.title='Senior Engineering Manager';
 assert.throws(()=>validateCvPublication(p,{dataRoot:'unused',report:machineReport([]),brief}),/Headline level above the posting title: Senior Engineering Manager vs Engineering Manager/);
 assert.doesNotThrow(()=>validateCvPublication(p,{dataRoot:'unused',report:machineReport([],'Senior Engineering Manager'),brief}));
 assert.doesNotThrow(()=>validateCvPublication(p,{dataRoot:'unused',report:`## Job Description\n${job}`,brief}),'no readable role skips the check');
});

test('final PDF review asserts contact details, skills and education survived rendering and caps pages at two',async()=>{
 const browser=await chromium.launch({headless:true});try{
  const page=await browser.newPage();const sentence='A complete source-backed statement describing engineering leadership and delivery outcomes for this example application.';
  const p={candidate:{name:'Ada Example',email:'ada@example.com',phone:'+49 162 8505 236'},summary:sentence,skills:[{category:'Core',items:'PHP, Laravel, REST APIs'},{category:'Cloud',items:['AWS','Kubernetes']}],education:[{title:'BSc Computer Science',org:'Example University'}]};
  await page.setContent(`<p>Ada Example · ada@example.com · +49 162 8505236</p><p>${sentence.repeat(4)}</p><p>Core: PHP, Laravel, REST APIs</p><p>Cloud: AWS, Kubernetes</p><p>BSc Computer Science — Example University</p>`);
  const buffer=await page.pdf();assert.equal((await reviewFinalPdf(buffer,p)).pages.length,1);
  await assert.rejects(reviewFinalPdf(buffer,{...p,candidate:{...p.candidate,email:'other@example.com'}}),/missing expected text: other@example.com/);
  await assert.rejects(reviewFinalPdf(buffer,{...p,candidate:{...p.candidate,phone:'+49 30 1234567'}}),/missing the candidate phone/);
  await assert.rejects(reviewFinalPdf(buffer,{...p,skills:[...p.skills,{category:'Data',items:'PostgreSQL, Kafka'}]}),/missing expected text: PostgreSQL/);
  await assert.rejects(reviewFinalPdf(buffer,{...p,education:[{title:'MSc Data Science',org:'Example University'}]}),/missing expected text: MSc Data Science/);
  await assert.rejects(reviewFinalPdf(buffer,{...p,education:[{title:'BSc Computer Science',org:'Another University'}]}),/missing expected text: Another University/);
  await page.setContent(`<p>${sentence.repeat(4)}</p><div style="break-before:page">${sentence.repeat(4)}</div><div style="break-before:page">${sentence.repeat(4)}</div>`);
  await assert.rejects(reviewFinalPdf(await page.pdf(),{}),/^Error: Final PDF review failed:\nFinal PDF has 3 pages; the cap is 2\./);
 }finally{await browser.close();}
});

test('technology names that are English words count only as proper names in a technology list', () => {
  const names = text => [...technologiesNamed(text)].sort();
  assert.deepEqual(names('Ability to express ideas clearly and react quickly to incidents'), []);
  assert.deepEqual(names('Spring 2026 start. Swift onboarding. Spark innovation across teams. At the helm of a platform team. We go live weekly.'), []);
  assert.deepEqual(names('Strong React and TypeScript skills'), ['react', 'typescript']);
  assert.deepEqual(names('Frontend: React, Next.js'), ['next.js', 'react']);
  assert.deepEqual(names('ReactJS and Python'), ['python', 'react']);
  assert.deepEqual(names('Experience with Go, Kubernetes and AWS'), ['aws', 'go', 'kubernetes']);
  assert.deepEqual(names('Built microservices in Go deployed on Kubernetes'), ['go', 'kubernetes']);
  assert.deepEqual(names('Golang experience'), ['go']);
  assert.deepEqual(names('Ran workloads on Amazon Web Services'), ['aws']);
  assert.equal(missingTechnologyEvidence(['Led incident response, cut MTTR by 40%'], 'Ability to react quickly to incidents'), null);
  assert.equal(missingTechnologyEvidence(['Ran workloads on Amazon Web Services'], 'AWS experience'), null);
  assert.match(missingTechnologyEvidence(['Shipped a PHP monolith'], 'Hands-on Python and Django'), /python, django|django, python/);
});

test('the technology block applies to a claim of full support only; a partial match declares its gap instead', () => {
  const requirement = '5+ years software development, ideally Python';
  const proof = 'Ten years building PHP and TypeScript web platforms end to end.';
  const techBrief = { chronology: brief.chronology, criticalRequirements: [{ requirement, jdSignal: requirement, jdQuote: requirement, importance: 'critical' }], evidence: [{ source: 'facts.md', text: `${source} ${proof}` }] };
  const report = `## Job Description\nRequirements: ${requirement}.`;
  const entry = { requirement, jdQuote: requirement, evidence: [{ source: 'facts.md', quote: proof }], placements: [{ section: 'summary', claim: proof }] };
  const partialPayload = { ...payload, summary: proof, tailoring: { requirements: [{ ...entry, match: 'partial', gap: 'No Python in production; PHP and TypeScript instead.' }] } };
  const partial = validateCvPublication(partialPayload, { dataRoot: 'unused', report, brief: techBrief });
  assert.ok(partial.gaps.some(g => /No Python in production/.test(g)), 'the partial match keeps its declared gap and is not blocked');
  const supportedPayload = { ...payload, summary: proof, tailoring: { requirements: [{ ...entry, match: 'supported' }] } };
  assert.throws(() => validateCvPublication(supportedPayload, { dataRoot: 'unused', report, brief: techBrief }), /names none of the required technologies \(python\)/);
});

test('logistics rows never enter the critical brief: a CV cannot answer where, how or for how much', () => {
  for (const text of ['Location: Berlin, hybrid', 'Full-time, regular employment', 'Applications from the EU only', '100% remote within Spain (residency/relocation requirement)', 'In-person / hub-based work mode', 'German at C1 level', 'Must be authorized to work in Germany', 'Start date: January'])
    assert.equal(isLogisticsRequirement(text), true, text);
  for (const text of ['5+ years software development, ideally Python', 'Experience leading distributed teams', 'Hands-on with Kubernetes', 'Owned hiring and performance management']) assert.equal(isLogisticsRequirement(text), false, text);
  const report = '## Machine Summary\n```yaml\nrequirement_importance:\n  - { requirement: "Location: Berlin, hybrid", jd_signal: "Berlin, hybrid", importance: critical }\n  - { requirement: "Lead distributed teams", jd_signal: "lead distributed teams", importance: critical }\n```\n';
  assert.deepEqual(criticalRequirements(report, 'lead distributed teams in Berlin, hybrid').map(x => x.requirement), ['Lead distributed teams']);
});

test('month-level dates accept the forms a CV writes and reject a season or "since" before a year', () => {
  for (const ok of ['06/2021 – 05/2023', 'Jun 2021 – May 2023', 'January 2020 to March 2023', '01.2020 – 03.2023', 'Feb 2023 − Present', 'Jan 2023 – Present (contract)', 'März 2020 – heute', '2019-03 – 2021-06']) assert.equal(hasMonthLevelDates(ok), true, ok);
  for (const bad of ['Since 2019 – Present', 'Summer 2021 – Winter 2022', 'Early 2020 – Late 2022', '2021 – 2023', '2021']) assert.equal(hasMonthLevelDates(bad), false, bad);
});

test('headline level: Senior equals Lead, Staff and Principal; Head equals the German Leiter', () => {
  assert.equal(headlineLevelError('Senior Engineering Manager', 'Lead Engineer'), null);
  assert.equal(headlineLevelError('Senior Engineering Manager', 'Staff Engineering Manager'), null);
  assert.equal(headlineLevelError('Head of Engineering', 'Leiter Softwareentwicklung (m/w/d)'), null);
  assert.match(headlineLevelError('Head of Engineering', 'Senior Engineering Manager'), /above the posting title/);
});

test('the review receipt ignores the Application Answers section, which the apply flow appends after the fill', () => {
  const before = '# Report\n\n## Machine Summary\n```yaml\nfinal_decision: Apply\n```\n\n## Job Description (archived verbatim)\nJD text\n';
  const after = '# Report\n\n## Machine Summary\n```yaml\nfinal_decision: Apply\n```\n\n## Application Answers\n\n**Date:** 2026-11-09\n- Salary: 120000\n\n## Job Description (archived verbatim)\nJD text\n';
  assert.equal(reportReviewText(after).replace(/\n{2,}/g, '\n'), reportReviewText(before).replace(/\n{2,}/g, '\n'));
  assert.equal(reportReviewText(after).includes('Salary: 120000'), false);
  assert.equal(reportReviewText('# R\n## Application Answers\n- a\n'), '# R\n');
  assert.notEqual(reportReviewText(before.replace('Apply', 'Consider')), reportReviewText(before), 'a changed verdict still changes the hash');
});

// A context library with two facts pages. The CV quotes only `cited`; `other`
// is a role the CV lists but never quotes from. Both carry a Role record period,
// so both are in the chronology.
function libraryFixture(t){
 const root=fixture(t);fs.mkdirSync(path.join(root,'data/context-workspace/pages'),{recursive:true});fs.mkdirSync(path.join(root,'data'),{recursive:true});
 const ids={root:'1'.repeat(32),cited:'2'.repeat(32),other:'3'.repeat(32)};
 const pages=[{id:'root',title:'Career',parentId:null,order:0,usage:'reference'},{id:'cited',title:'Example — Manager',parentId:'root',order:0,usage:'facts'},{id:'other',title:'Elsewhere — Engineer',parentId:'root',order:1,usage:'facts'}];
 fs.writeFileSync(path.join(root,'data/context-workspace/index.json'),JSON.stringify({version:1,rootId:ids.root,pages:pages.map(p=>({...p,id:ids[p.id],parentId:p.parentId?ids[p.parentId]:null}))}));
 const body=(period,prose)=>`## Role record\n\n- **Period:** ${period}.\n\n# Work\n\n${prose}\n`;
 const file=id=>path.join(root,`data/context-workspace/pages/${ids[id]}.md`);
 fs.writeFileSync(file('cited'),body('January 2020 – Present','Led an engineering team through the migration and improved production reliability.'));
 fs.writeFileSync(file('other'),body('March 2016 – December 2019','Built billing services in PHP.'));
 fs.writeFileSync(file('root'),'# Career\n\nIndex.\n');
 fs.writeFileSync(path.join(root,'data/pdf-index.tsv'),'1\toutput/1.pdf\t\ta4\t2026-11-01\tcv\n');
 const rel=id=>`data/context-workspace/pages/${ids[id]}.md`;
 const cvPayload={candidate:{name:'Ada Example'},experience:[{company:'Example',role:'Manager',dates:'Jan 2020 – Present'},{company:'Elsewhere',role:'Engineer',dates:'Mar 2016 – Dec 2019'}],
  tailoring:{requirements:[{requirement:'Lead an engineering team',jdQuote:'Lead an engineering team',match:'supported',evidence:[{source:rel('cited'),quote:'Led an engineering team through the migration'}],placements:[]}]}};
 return {root,file,rel,cvPayload,pdf:path.join(root,'output/1.pdf')};
}
const appendProse=(file,text)=>fs.appendFileSync(file,`\n${text}\n`);

test('receipt narrowing: an edit to an uncited Context page keeps the receipt current; a cited page or chronology edit stales it',t=>{
 const {root,file,rel,cvPayload,pdf}=libraryFixture(t);
 reviewedCvFixture(root,1,pdf,{payload:cvPayload});
 const receipt=JSON.parse(fs.readFileSync(`${pdf}.review.json`,'utf8'));
 assert.deepEqual(receipt.evidenceSources,[rel('cited')]);
 assert.deepEqual(receipt.chronologySources,[rel('cited'),rel('other')],'both employers the CV lists are chronology sources');
 assert.notEqual(receipt.evidenceSha256,currentEvidenceHash(root),'the narrow hash is not the whole-context hash');
 assert.doesNotThrow(()=>reviewedCvForReport(root,1));
 appendProse(file('other'),'Also mentored two juniors.');
 assert.doesNotThrow(()=>reviewedCvForReport(root,1),'prose on a page the CV never quotes does not stale the CV');
 appendProse(file('root'),'Reference text changed.');
 assert.doesNotThrow(()=>reviewedCvForReport(root,1),'a reference page is never evidence');
 appendProse(file('cited'),'Partnered with Product on priorities.');
 assert.throws(()=>reviewedCvForReport(root,1),/career evidence changed/);
 // Re-review after the cited edit, then change only the uncited page's dates.
 reviewedCvFixture(root,1,pdf,{payload:cvPayload});
 assert.doesNotThrow(()=>reviewedCvForReport(root,1));
 fs.writeFileSync(file('other'),fs.readFileSync(file('other'),'utf8').replace('March 2016 – December 2019','March 2016 – June 2019'));
 assert.throws(()=>reviewedCvForReport(root,1),/career evidence changed/,'a date change anywhere is a chronology change');
 // Demoting the cited page out of facts stales it too.
 reviewedCvFixture(root,1,pdf,{payload:cvPayload});
 const index=JSON.parse(fs.readFileSync(path.join(root,'data/context-workspace/index.json'),'utf8'));
 index.pages.find(p=>p.id==='2'.repeat(32)).usage='reference';
 fs.writeFileSync(path.join(root,'data/context-workspace/index.json'),JSON.stringify(index));
 assert.throws(()=>reviewedCvForReport(root,1),/career evidence changed/);
});

test('receipt narrowing: a legacy receipt without evidenceSources is judged by the whole-context rule, never passed by default',t=>{
 const {root,file,cvPayload,pdf}=libraryFixture(t);
 reviewedCvFixture(root,1,pdf,{payload:cvPayload});
 const receiptFile=`${pdf}.review.json`;
 const legacy=JSON.parse(fs.readFileSync(receiptFile,'utf8'));
 delete legacy.evidenceSources;delete legacy.chronologySources;legacy.evidenceSha256=currentEvidenceHash(root);
 fs.writeFileSync(receiptFile,JSON.stringify(legacy));
 assert.doesNotThrow(()=>reviewedCvForReport(root,1),'a legacy receipt whose whole-context hash still matches is current');
 appendProse(file('other'),'Also mentored two juniors.');
 assert.throws(()=>reviewedCvForReport(root,1),/career evidence changed/,'under the old rule an uncited page edit stales it');
 // A legacy receipt with no hash at all, and one with the wrong hash, both fail.
 for(const sha of[undefined,'0'.repeat(64)]){const broken={...legacy};if(sha===undefined)delete broken.evidenceSha256;else broken.evidenceSha256=sha;fs.writeFileSync(receiptFile,JSON.stringify(broken));assert.throws(()=>reviewedCvForReport(root,1),/career evidence changed/);}
 // An empty citation list is the whole-context rule as well.
 reviewedCvFixture(root,1,pdf,{payload:{candidate:{name:'Ada Example'}}});
 const empty=JSON.parse(fs.readFileSync(receiptFile,'utf8'));
 assert.deepEqual(empty.evidenceSources,[]);
 assert.equal(empty.evidenceSha256,currentEvidenceHash(root));
 assert.equal(evidenceHashFor(root,[]),currentEvidenceHash(root));
 appendProse(file('other'),'Another line.');
 assert.throws(()=>reviewedCvForReport(root,1),/career evidence changed/);
});

test('citedEvidenceSources and citedChronologySources read the payload shape and tolerate missing parts',()=>{
 assert.deepEqual(citedEvidenceSources(null),[]);
 assert.deepEqual(citedEvidenceSources({tailoring:{requirements:[{evidence:[{source:'b.md'},{source:' a.md '},{source:''},{quote:'x'}]},{match:'gap'},null]}}),['a.md','b.md']);
 const chronology=[{company:'Example GmbH',source:'p1.md'},{company:'Elsewhere',source:'p2.md'},{company:'Example',source:'p1.md'}];
 assert.deepEqual(citedChronologySources({experience:[{company:'Example'}]},chronology),['p1.md']);
 assert.deepEqual(citedChronologySources({},chronology),[]);
 assert.equal(evidenceHashFor('unused',['x.md'],null),evidenceHashFor('unused',[' x.md ','x.md'],null),'sources are trimmed and deduplicated before hashing');
 assert.notEqual(evidenceHashFor('unused',['x.md'],null),evidenceHashFor('unused',['y.md'],null));
});
