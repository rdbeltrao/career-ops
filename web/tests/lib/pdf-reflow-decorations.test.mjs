import assert from 'node:assert/strict';
import test, { before } from 'node:test';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { PdfEngine } from '../../public/vendor/bentopdf/core.js';
import { captureFlow, preparePdfForReflow, reflowDocument } from '../../public/pdf-editor/reflow.mjs';
import { paragraphText, readParagraphs } from '../../public/pdf-editor/model.mjs';
import { competencyLabels, bulletLabels } from '../fixtures/decorated-cv.mjs';

let fixture;
before(async () => {
  for (const [style, key] of [['Regular', '00'], ['Bold', '10'], ['Italic', '01'], ['BoldItalic', '11']]) {
    PdfEngine.localFonts.set(`Noto Sans|${key}`, new Uint8Array(await fs.readFile(new URL(`../../public/vendor/bentopdf/fonts/NotoSans-${style}.ttf`, import.meta.url))));
  }
  // Fictional Chrome PDF from decorated-cv.mjs using the actual CV stylesheet.
  // Regenerate with PDF_DECORATED_FIXTURE=1 node tests/fixtures/visual-pdf.mjs;
  // native unit/raster regressions deliberately require no installed browser.
  fixture = new Uint8Array(await fs.readFile(new URL('../fixtures/pdf-decorated-cv.pdf', import.meta.url)));
});

function words(engine) {
  const all = [];
  for (let index = 0; index < engine.pageCount; index++) {
    engine.loadPage(index);
    all.push(...readParagraphs(engine).flatMap(paragraph => paragraphText(paragraph).match(/[\p{L}\p{N}]+/gu) ?? []));
  }
  return all.sort();
}
const inkBox = box => ({ x: box.x, top: box.top ?? box.y + box.h, w: box.w, h: box.h });
const bottom = box => box.top - box.h;
function imageRegion(image, box, pageHeight, scale = 3) {
  const x = Math.round(box.x * scale), y = Math.round((pageHeight - box.top) * scale);
  const width = Math.round(box.w * scale), height = Math.round(box.h * scale);
  return { width, height, pixels: Array.from({ length: height }, (_, row) => image.data.slice(((y + row) * image.width + x) * 4, ((y + row) * image.width + x + width) * 4)) };
}
function regionDifference(a, b) {
  assert.equal(a.width, b.width); assert.equal(a.height, b.height);
  let different = 0, total = 0;
  for (let row = 0; row < a.height; row++) for (let index = 0; index < a.width * 4; index += 4) {
    total++;
    if (Math.max(...[0, 1, 2].map(channel => Math.abs(a.pixels[row][index + channel] - b.pixels[row][index + channel]))) > 50) different++;
  }
  return different / total;
}
// Native Unicode character/font ownership. Keep only real objects belonging to
// this paragraph; generated CR/LF can otherwise shift the phrase index.
function paragraphCharacters(engine,paragraph){
 const M=engine.M,tp=M._FPDFText_LoadPage(engine.page),handles=new Set(engine.paragraphObjects(paragraph.id)),out=[];
 try{
  for(let i=0;i<M._FPDFText_CountChars(tp);i++){
   const object=M._FPDFText_GetTextObject(tp,i);if(!handles.has(object))continue;
   const cp=M._FPDFText_GetUnicode(tp,i);out.push({char:String.fromCodePoint(cp),cp,font:M._FPDFTextObj_GetFont(object)});
  }
  return out;
 }finally{M._FPDFText_ClosePage(tp)}
}

// Glyph paths at a common 1000 units/em. Native fonts sometimes expose paths
// normalized to 1em despite the size argument; mirror native synth's scale probe.
function glyphPath(engine,font,cp){
 const M=engine.M,p=M._malloc(8),gp=M._FPDFFont_GetGlyphPath(font,cp,1000),result=[];
 try{
  if(!gp)throw new Error(`No native outline for U+${cp.toString(16)}`);
  for(let i=0;i<M._FPDFGlyphPath_CountGlyphSegments(gp);i++){
   const segment=M._FPDFGlyphPath_GetGlyphPathSegment(gp,i);
   M._FPDFPathSegment_GetPoint(segment,p,p+4);
   result.push({type:M._FPDFPathSegment_GetType(segment),x:M.HEAPF32[p>>2],y:M.HEAPF32[(p+4)>>2],close:!!M._FPDFPathSegment_GetClose(segment)});
  }
  const maximum=Math.max(...result.flatMap(segment=>[Math.abs(segment.x),Math.abs(segment.y)]));
  if(maximum<10)for(const segment of result){segment.x*=1000;segment.y*=1000;}
  return result;
 }finally{M._free(p)}
}

function outlineSegments(path,steps=32){
 let current={x:0,y:0},start=current;const lines=[];
 const append=point=>{lines.push([current,point]);current=point;};
 for(let i=0;i<path.length;i++){
  const first=path[i];
  if(first.type===2){current=first;start=first;continue;}
  let final=first;
  if(first.type===1){
   const second=path[++i],third=path[++i],from=current;final=third;
   if(!second||!third||second.type!==1||third.type!==1)throw new Error('Malformed cubic outline');
   for(let j=1;j<=steps;j++){
    const t=j/steps,u=1-t;
    append({x:u*u*u*from.x+3*u*u*t*first.x+3*u*t*t*second.x+t*t*t*third.x,y:u*u*u*from.y+3*u*u*t*first.y+3*u*t*t*second.y+t*t*t*third.y});
   }
  }else if(first.type===0)append(first);
  else throw new Error(`Unknown native path type ${first.type}`);
  if(final.close)append(start);
 }
 return lines;
}
function pointDistanceSquared(point,a,b){
 const x=b.x-a.x,y=b.y-a.y,length=x*x+y*y;
 const t=length?Math.max(0,Math.min(1,((point.x-a.x)*x+(point.y-a.y)*y)/length)):0;
 return (point.x-a.x-t*x)**2+(point.y-a.y-t*y)**2;
}
function outlineDistance(first,second){
 const a=outlineSegments(first),b=outlineSegments(second);
 if(!a.length||!b.length)throw new Error('Cannot compare empty glyph outlines');
 const directed=(source,target)=>{
  let max=0,sum=0,count=0;
  for(const segment of source)for(const point of segment){
   let min=Infinity;for(const [p,q]of target)min=Math.min(min,pointDistanceSquared(point,p,q));
   const distance=Math.sqrt(min);max=Math.max(max,distance);sum+=distance;count++;
  }
  return {max,mean:sum/count};
 };
 const ab=directed(a,b),ba=directed(b,a);
 return {max:Math.max(ab.max,ba.max),mean:(ab.mean+ba.mean)/2};
}
function phraseGlyphs(engine,paragraph,phrase){
 const chars=paragraphCharacters(engine,paragraph),text=chars.map(char=>char.char).join(''),at=text.indexOf(phrase);
 if(at<0)throw new Error(`Missing fictional test phrase: ${phrase}`);
 // Fixture phrase uses BMP characters; surrogate-pair offsets are not needed.
 return chars.slice(at,at+phrase.length).filter(char=>! /\s/u.test(char.char)).map(char=>({...char,path:glyphPath(engine,char.font,char.cp)}));
}


test('flow captures native object ownership after a regenerated pattern page reloads its model',async()=>{
  const engine=await PdfEngine.create();
  try{
    engine.open(await preparePdfForReflow(fixture));
    const before=captureFlow(engine),target=before.blocks.find(block=>block.text.startsWith('Hands-on, thoughtful'));
    const text=target.text+'.';
    const result=await reflowDocument(engine,{edits:[{identity:{pageIndex:target.pageIndex,text:target.text,box:target.originalBox},text}]});
    engine.open(result.bytes);
    const refreshed=captureFlow(engine);
    assert.equal(refreshed.blocks.length,before.blocks.length);
    assert.ok(refreshed.blocks.every(block=>block.objectIndices.length>0));
    assert.deepEqual(refreshed.blocks.map(block=>block.text),before.blocks.map(block=>block===target?text:block.text));
  }finally{engine.close();}
});

test('actual CV chip backgrounds belong to their own text and preserve native paint order on a section move', async () => {
  const engine = await PdfEngine.create();
  try {
    engine.open(await preparePdfForReflow(fixture));
    const before = captureFlow(engine);
    const chips = competencyLabels.map(label => before.blocks.find(block => block.text === label));
    assert.ok(chips.every(Boolean));
    for (const chip of chips) {
      const backgrounds = chip.objectIndices.map(index => before.pages[chip.pageIndex].objects[index]).filter(object => object.type === 2);
      assert.equal(backgrounds.length, 2, `${chip.text} owns exactly its background and border`);
      assert.ok(chip.box.w < 150, `${chip.text} must not absorb neighboring chip backgrounds`);
      assert.ok(backgrounds.every(object => object.box.x <= chip.originalBox.x + 1 && object.box.x + object.box.w >= chip.originalBox.x + chip.originalBox.w - 1));
    }
    engine.loadPage(0);
    const raster = engine.renderPage(3);
    const regions = chips.map(chip => imageRegion(raster, chip.box, engine.pageHeight));
    const originalWords = words(engine);
    const order = before.sections.map(section => section.title);
    const competency = order.splice(order.indexOf('CORE COMPETENCIES'), 1)[0]; order.push(competency);
    const result = await reflowDocument(engine, { sectionOrder: order });
    for (const chip of chips) {
      const placements = result.plan.placements.filter(move => move.fromPage === chip.pageIndex && move.objectIndices.some(index => chip.objectIndices.includes(index)));
      assert.equal(placements.length, 1, `${chip.text} stays one text/background group`);
      assert.ok(chip.objectIndices.every(index => placements[0].objectIndices.includes(index)));
    }
    engine.open(result.bytes);
    assert.deepEqual(words(engine), originalWords, 'Every selectable word survives a move, including repeated job/list content');
    for (const [index, chip] of chips.entries()) {
      const placement = result.plan.placements.find(move => move.fromPage === chip.pageIndex && move.objectIndices.includes(chip.objectIndices[0]));
      engine.loadPage(placement.toPage);
      const moved = { ...chip.box, x: chip.box.x + placement.dx, top: chip.box.top + placement.dy };
      const after = imageRegion(engine.renderPage(3), moved, engine.pageHeight);
      assert.ok(regionDifference(regions[index], after) < 0.12, `${chip.text} retains text/background raster alignment and paint order`);
    }
  } finally { engine.close(); }
});

test('native bullets follow their own list line through section moves without changing relative geometry', async () => {
  const engine = await PdfEngine.create();
  try {
    engine.open(await preparePdfForReflow(fixture)); const flow = captureFlow(engine);
    const lists = flow.blocks.filter(block => block.text.includes(bulletLabels[0]));
    assert.ok(lists.length >= 3, 'Fixture covers repeated native list structures across pages');
    const before = lists.map(block => ({ block, objects: block.objectIndices.map(index => flow.pages[block.pageIndex].objects[index]) }));
    const order = flow.sections.map(section => section.title);
    const experience = order.splice(order.indexOf('WORK EXPERIENCE'), 1)[0]; order.push(experience);
    const result = await reflowDocument(engine, { sectionOrder: order });
    for (const { block, objects } of before) {
      const bullets = objects.filter(object => object.type === 2 && object.box.w < 5 && object.box.h < 5);
      assert.equal(bullets.length, 4);
      for (const bullet of bullets) {
        const lineText = objects.filter(object => object.type === 1 && Math.min(object.box.top, bullet.box.top) >= Math.max(bottom(object.box), bottom(bullet.box)));
        assert.ok(lineText.length > 0);
        const placement = result.plan.placements.find(move => move.fromPage === block.pageIndex && move.objectIndices.includes(bullet.index));
        assert.ok(placement, 'Each bullet is retained');
        for (const text of lineText) {
          const textPlacement = result.plan.placements.find(move => move.fromPage === block.pageIndex && move.objectIndices.includes(text.index));
          assert.equal(textPlacement.toPage, placement.toPage);
          assert.ok(Math.abs(textPlacement.dy - placement.dy) < 0.01, 'Bullet and its baseline text share the exact translation');
        }
      }
    }
  } finally { engine.close(); }
});

test('one-character summary edit retains font styles, wrapped geometry and nearby decorated content', async () => {
  const engine = await PdfEngine.create();
  try {
    engine.open(await preparePdfForReflow(fixture)); const before = captureFlow(engine);
    engine.loadPage(0);
    const originalRaster=engine.renderPage(2);
    const headerHash=createHash('sha256').update(originalRaster.data.slice(0,originalRaster.width*Math.floor(originalRaster.height*.12)*4)).digest('hex');
    const target = before.blocks.find(block => block.text.startsWith('Hands-on, thoughtful'));
    const strong = target.paragraph.runs.filter(run => run.bold).map(run => ({ text: run.text, family: run.family }));
    assert.ok(strong.length > 0);
    const result = await reflowDocument(engine, { edits: [{ identity: { pageIndex: target.pageIndex, text: target.text, box: target.originalBox }, text: target.text.replace('calm', 'calr') }] });
    engine.open(result.bytes); engine.loadPage(0);
    const updatedRaster=engine.renderPage(2);
    assert.equal(createHash('sha256').update(updatedRaster.data.slice(0,updatedRaster.width*Math.floor(updatedRaster.height*.12)*4)).digest('hex'),headerHash,'An unrelated header and its gradient remain pixel-identical');
    const edited = readParagraphs(engine).find(paragraph => paragraphText(paragraph).startsWith('Hands-on, thoughtful'));
    assert.ok(edited);
    assert.equal(edited.lines.length, target.paragraph.lines.length, 'A same-length change must retain the existing wrap width and line count');
    assert.ok(Math.abs(edited.lines[0].y - target.paragraph.lines[0].y) < 0.5, 'The first baseline remains anchored');
    for (const old of strong) {
      const current = edited.runs.find(run => run.text.includes(old.text.trim()));
      assert.ok(current && current.bold && current.family === old.family, `Unchanged styled span retains its original font: ${old.text}`);
    }
    const after = captureFlow(engine);
    for (const label of competencyLabels) {
      const old = before.blocks.find(block => block.text === label), current = after.blocks.find(block => block.text === label);
      assert.ok(current);
      assert.ok(Math.abs(current.box.x - old.box.x) < 0.1, 'Chip horizontal position remains stable');
      assert.ok(Math.abs(current.box.top - old.box.top) < 2, 'A one-character edit does not restack chip rows');
    }
  } finally { engine.close(); }
});

test('a plain company/date row uses available horizontal space without wrapping a short company edit', async()=>{
  const engine=await PdfEngine.create();
  try{
    engine.open(await preparePdfForReflow(fixture));const flow=captureFlow(engine);
    const company=flow.blocks.find(block=>block.text==='Fixture Beta'),date=flow.blocks.find(block=>block.pageIndex===company.pageIndex&&block.text==='2021 - 2024');
    assert.ok(company.wrapWidth>300,'Plain text can grow in the existing gap before its date');
    const result=await reflowDocument(engine,{edits:[{identity:{pageIndex:company.pageIndex,text:company.text,box:company.originalBox},text:'Fabixture Beta'}]});
    engine.open(result.bytes);engine.loadPage(company.pageIndex);
    const paragraphs=readParagraphs(engine),updated=paragraphs.find(paragraph=>paragraphText(paragraph)==='Fabixture Beta'),unchanged=paragraphs.find(paragraph=>paragraphText(paragraph)===date.text);
    assert.equal(updated.lines.length,1);
    assert.ok(Math.abs(updated.lines[0].y-company.baseline)<.1);
    assert.ok(Math.abs(unchanged.lines[0].y-date.baseline)<.1);
  }finally{engine.close();}
});

test('same-family styled source fonts keep their original glyph outlines through a small edit and expansion', async()=>{
  const engine=await PdfEngine.create(),initialKeys=[...PdfEngine.localFonts.keys()].sort();
  try{
    for(const expand of [false,true]){
      engine.open(await preparePdfForReflow(fixture));const flow=captureFlow(engine);
      const target=flow.blocks.find(block=>block.text.startsWith('Led engineering'));
      engine.loadPage(target.pageIndex);
      const expected=phraseGlyphs(engine,target.paragraph,'design teams'),otherFont=paragraphCharacters(engine,target.paragraph)[0].font;
      const wrong=expected.map(char=>glyphPath(engine,otherFont,char.cp));
      const text=expand?target.text.repeat(18):target.text.replace('reliable','relialle');
      const result=await reflowDocument(engine,{edits:[{identity:{pageIndex:target.pageIndex,text:target.text,box:target.originalBox},text}]});
      engine.open(result.bytes);engine.loadPage(target.pageIndex);
      const paragraph=readParagraphs(engine).find(paragraph=>paragraphText(paragraph).startsWith('Led engineering'));
      const actual=phraseGlyphs(engine,paragraph,'design teams');
      assert.equal(actual.length,expected.length);
      // Native synthesis approximates cubic source paths with quadratic curves;
      // at 1000 units/em, <2 units is <0.02pt at this fixture's font size.
      for(const [index,glyph]of expected.entries()){
        assert.ok(outlineDistance(glyph.path,actual[index].path).max<2,'The edited word retains its original glyph shape');
        assert.ok(outlineDistance(wrong[index],actual[index].path).max>20,'A same-name neighboring font is visibly different and must not replace the source');
      }
      assert.ok(result.editedLayouts[0].runs.every(run=>!run.family.startsWith('COF ')),'The main editor overlay receives original source families after scratch aliases are released');
      assert.deepEqual([...PdfEngine.localFonts.keys()].sort(),initialKeys,'Temporary source fonts do not accumulate in the global provider');
    }
  }finally{engine.close();}
});
