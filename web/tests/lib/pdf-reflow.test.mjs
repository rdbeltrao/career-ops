import assert from 'node:assert/strict';
import test, {before} from 'node:test';
import fs from 'node:fs/promises';
import { PdfEngine } from '../../public/vendor/bentopdf/core.js';
import { reflowDocument, captureFlow } from '../../public/pdf-editor/reflow.mjs';
import { paragraphText, replacementRuns } from '../../public/pdf-editor/model.mjs';

before(async()=>{
  for(const [style,key]of[['Regular','00'],['Bold','10'],['Italic','01'],['BoldItalic','11']])PdfEngine.localFonts.set('Noto Sans|'+key,new Uint8Array(await fs.readFile(new URL('../../public/vendor/bentopdf/fonts/NotoSans-'+style+'.ttf',import.meta.url))));
});

function cvFixture({counter=false,annotation=null,contactHeader=false}={}) {
  const stream=(contactHeader?'1 1 1 rg 40 40 532 735 re f 0 0 0 rg BT /F2 28 Tf 50 750 Td (Candidate Name) Tj /F1 20 Tf 0 -23 Td (Engineering Leader) Tj /F1 12 Tf 0 -26 Td (mail profile portfolio) Tj ET ':'')+'BT /F2 20 Tf 50 '+(contactHeader?'650':'740')+' Td (Professional Summary) Tj /F1 14 Tf 0 -30 Td (Original profile sentence.) Tj /F2 20 Tf 0 -70 Td (Work Experience) Tj /F1 14 Tf 0 -30 Td (Untouched experience sentence.) Tj /F2 20 Tf 0 -70 Td (Education) Tj /F1 14 Tf 0 -30 Td (Computer science degree.) Tj ET 0 0.4 0.9 rg 50 570 512 3 re f'+(counter?' BT /F1 12 Tf 50 20 Td (Page 1 of 1) Tj ET':'');
  const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents 6 0 R >>','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>',`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`];
  if(annotation){objects[2]=objects[2].replace('/Contents 6 0 R','/Contents 6 0 R /Annots [7 0 R]');objects.push(`<< /Type /Annot /Subtype /Link /Rect [${annotation.join(' ')}] /Border [0 0 0] /A << /S /URI /URI (https://example.test/) >> >>`);}
  let text='%PDF-1.4\n';const offsets=[0];for(const [index,object]of objects.entries()){offsets.push(Buffer.byteLength(text));text+=`${index+1} 0 obj\n${object}\nendobj\n`;}const xref=Buffer.byteLength(text);text+=`xref\n0 ${objects.length+1}\n0000000000 65535 f \n`+offsets.slice(1).map(offset=>`${String(offset).padStart(10,'0')} 00000 n \n`).join('')+`trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;return new Uint8Array(Buffer.from(text));
}
function allText(engine){return Array.from({length:engine.pageCount},(_,index)=>{engine.loadPage(index);return engine.buildModel().map(paragraphText).join(' ');}).join(' ').replace(/\s+/g,' ');}

test('long PDF paragraph paginates every line and later sections without lost text',async()=>{
  const engine=await PdfEngine.create();
  try{
    engine.open(cvFixture());const flow=captureFlow(engine),block=flow.blocks.find(block=>block.text==='Original profile sentence.');
    const text=Array.from({length:900},(_,index)=>`word${index}`).join(' ');
    const result=await reflowDocument(engine,{edits:[{identity:{pageIndex:0,text:block.text,box:block.originalBox},text}]});
    assert.ok(result.pages.length>1,'Text beyond one page appends real PDF pages');
    assert.ok(result.liveLines.some(line=>line.pageIndex>0),JSON.stringify({pages:result.pages.length,lines:result.liveLines.slice(-3),placements:result.plan.placements.map(p=>({id:p.blockId,parent:p.parentBlockId,page:p.toPage,n:p.objectIndices.length})).slice(0,6)}));
    engine.open(result.bytes);const extracted=allText(engine);
    for(const word of text.split(' '))assert.ok(extracted.includes(word),`Retains ${word}`);
    assert.match(extracted,/Untouched experience sentence/);assert.match(extracted,/Computer science degree/);
    for(let index=0;index<engine.pageCount;index++){engine.loadPage(index);for(let objectIndex=0;objectIndex<engine.objectCount();objectIndex++){const box=engine.objectBounds(engine.objectAt(objectIndex).handle);assert.ok(box.y>=0&&box.y+box.h<=engine.pageHeight+1,'No moved object remains outside its page');assert.ok(box.x+box.w<=engine.pageWidth-49,'Wrapping retains the original right margin');}}
  }finally{engine.close();}
});

test('page counters update, continuation counters render, and empty generated pages are reclaimed',async()=>{
  const engine=await PdfEngine.create();
  try{
    engine.open(cvFixture({counter:true}));const block=captureFlow(engine).blocks.find(block=>block.text==='Original profile sentence.');
    const long=Array.from({length:850},(_,index)=>`word${index}`).join(' ');
    const grown=await reflowDocument(engine,{edits:[{identity:{pageIndex:0,text:block.text,box:block.originalBox},text:long}]});
    engine.open(grown.bytes);const total=engine.pageCount;assert.ok(total>1);
    for(let index=0;index<total;index++){engine.loadPage(index);assert.match(engine.buildModel().map(paragraphText).join(' '),new RegExp(`Page ${index+1} of ${total}`));}
    const chunks=captureFlow(engine).blocks.filter(block=>block.text.includes('word'));
    const shrunk=await reflowDocument(engine,{edits:chunks.map(block=>({identity:{pageIndex:block.pageIndex,text:block.text,box:block.originalBox},text:'Short profile.'}))});
    engine.open(shrunk.bytes);assert.equal(engine.pageCount,1);assert.match(allText(engine),/Page 1 of 1/);
  }finally{engine.close();}
});

test('body links reject a layout move while harmless fixed margin links remain supported',async()=>{
  const engine=await PdfEngine.create();
  try{
    for(const [annotation,allowed]of[[[50,700,270,725],false],[[50,775,270,790],true]]){
      engine.open(cvFixture({annotation}));const block=captureFlow(engine).blocks.find(block=>block.text==='Original profile sentence.');
      const operation=reflowDocument(engine,{edits:[{identity:{pageIndex:0,text:block.text,box:block.originalBox},text:'Updated profile sentence.'}]});
      if(allowed)assert.ok((await operation).bytes.length);else await assert.rejects(operation,/link or annotation/);
    }
  }finally{engine.close();}
});


test('medium single-line replacements wrap inside the existing content margin',async()=>{
  const engine=await PdfEngine.create();
  try{
    engine.open(cvFixture());const block=captureFlow(engine).blocks.find(block=>block.text==='Original profile sentence.');
    const text='Original '.repeat(10).trim();
    const preview=engine.previewParagraph(block.paragraph.id,replacementRuns(block.paragraph,text),block.paragraph.format);
    assert.equal(preview.lines.length,1,'Reproduces the native page-edge single-line layout');
    const result=await reflowDocument(engine,{edits:[{identity:{pageIndex:0,text:block.text,box:block.originalBox},text}]});
    assert.ok(result.liveLines.length>1,'The CV margin requires wrapping before the page edge');
    engine.open(result.bytes);assert.ok(allText(engine).includes(text));
    engine.loadPage(0);for(let index=0;index<engine.objectCount();index++){const box=engine.objectBounds(engine.objectAt(index).handle);assert.ok(box.x+box.w<=562.5,'All ink retains the 50-point right margin');}
    const changed=engine.buildModel().find(paragraph=>paragraphText(paragraph).startsWith('Original Original'));
    assert.equal(changed.runs[0].size,block.paragraph.runs[0].size);
    assert.equal(changed.runs[0].family,block.paragraph.runs[0].family);
  }finally{engine.close();}
});


test('font padding does not move an unchanged linked contact header during body expansion',async()=>{
  const engine=await PdfEngine.create();
  try{
    engine.open(cvFixture({contactHeader:true,annotation:[50,695,250,711]}));
    const flow=captureFlow(engine),headers=flow.blocks.filter(block=>block.sectionId==='body'),target=flow.blocks.find(block=>block.text==='Original profile sentence.');
    assert.ok(headers[0].originalBox.top-headers[0].originalBox.h<headers[1].originalBox.top,'The fixture reproduces overlapping padded font rectangles');
    assert.ok(headers[0].box.top-headers[0].box.h>=headers[1].box.top,'Their actual glyph ink does not overlap');
    const before=headers.map(block=>({text:block.text,baseline:block.paragraph.lines[0].y}));
    const result=await reflowDocument(engine,{edits:[{identity:{pageIndex:0,text:target.text,box:target.originalBox},text:'Original profile sentence. '.repeat(100)}]});
    assert.ok(result.pages.length>1);
    assert.equal(result.plan.moves.filter(move=>headers.some(block=>move.fromPage===block.pageIndex&&move.objectIndices.some(index=>block.objectIndices.includes(index)))).length,0,'Header links and their text remain anchored');
    engine.open(result.bytes);engine.loadPage(0);const paragraphs=engine.buildModel();
    for(const original of before){const paragraph=paragraphs.find(paragraph=>paragraphText(paragraph)===original.text);assert.ok(paragraph);assert.ok(Math.abs(paragraph.lines[0].y-original.baseline)<.01,'Unedited header baselines are unchanged');}
    assert.equal(engine.M._FPDFPage_GetAnnotCount(engine.page),1);
  }finally{engine.close();}
});
