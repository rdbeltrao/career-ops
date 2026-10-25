// SPDX-License-Identifier: AGPL-3.0-only
import { PdfEngine, sfntCovers } from '../vendor/bentopdf/core.js';
import { readParagraphs, paragraphText, replacementRuns, removeParagraphWhitespace } from './model.mjs';
import { analyzeCvSections, isPageUnderlay } from './sections.mjs';
import { planPdfPagination, groupFlowRows } from './pagination.mjs';
import { appendPage, inspectParagraphLines, generatedPageMarkerIndices, removeTrailingPages } from './page-engine.mjs';

const bottom = box => box.top - box.h;
const rect = box => ({ x:box.x, top:box.top ?? box.y + box.h, w:box.w, h:box.h });
function union(boxes) {
  const x=Math.min(...boxes.map(box=>box.x)),top=Math.max(...boxes.map(box=>box.top));
  return {x,top,w:Math.max(...boxes.map(box=>box.x+box.w))-x,h:top-Math.min(...boxes.map(bottom))};
}
const near = (a,b) => Math.abs(a.x-b.x)<1 && Math.abs(a.top-b.top)<1;
export function describePath(engine,handle) {
  const M=engine.M,count=M._FPDFPath_CountSegments(handle),ptr=M._malloc(24),points=[];let closed=false,isRect=false;
  try {
    if(count===4||count===5){
      for(let index=0;index<count;index++){const segment=M._FPDFPath_GetPathSegment(handle,index);const type=M._FPDFPathSegment_GetType(segment);if(type===1||!M._FPDFPathSegment_GetPoint(segment,ptr,ptr+4)){points.length=0;break;}points.push([M.HEAPF32[ptr>>2],M.HEAPF32[(ptr+4)>>2]]);closed ||= !!M._FPDFPathSegment_GetClose(segment);}
      const equal=(a,b)=>Math.abs(a[0]-b[0])<.001&&Math.abs(a[1]-b[1])<.001;
      if(points.length>1&&equal(points[0],points.at(-1))){points.pop();closed=true;}
      const matrix=M._FPDFPageObj_GetMatrix(handle,ptr)?Array.from(M.HEAPF32.subarray(ptr>>2,(ptr>>2)+6)):null;
      const aligned=matrix&&((Math.abs(matrix[1])<.001&&Math.abs(matrix[2])<.001)||(Math.abs(matrix[0])<.001&&Math.abs(matrix[3])<.001));
      isRect=closed&&aligned&&points.length===4&&new Set(points.map(point=>point[0].toFixed(3))).size===2&&new Set(points.map(point=>point[1].toFixed(3))).size===2&&points.every((point,index)=>{const next=points[(index+1)%4];return Math.abs(point[0]-next[0])<.001||Math.abs(point[1]-next[1])<.001;});
    }
  } finally {M._free(ptr);}
  return {segmentCount:count,isRect:!!isRect,fillColor:engine.objectFill(handle),pathStyle:engine.pathStyle(handle)};
}
function objectsOnPage(engine) {
  return Array.from({length:engine.objectCount()},(_,index)=>{
    const object=engine.objectAt(index),bounds=engine.objectBounds(object.handle);
    if(!bounds)throw new Error('This PDF contains an object without readable layout bounds.');
    return {...object,box:rect(bounds),...(object.type===2?describePath(engine,object.handle):{})};
  });
}
function paragraphsOnPage(engine,objects) {
  const byHandle=new Map(objects.map(object=>[object.handle,object.index]));
  return readParagraphs(engine).map(paragraph=>({...paragraph,objectIndices:[...new Set([...engine.paragraphObjects(paragraph.id),...(paragraph.whitespaceObjects??[])])]
    .map(handle=>byHandle.get(handle)).filter(Number.isInteger)}));
}

function annotationBoxes(engine) {
  const M=engine.M,out=[],ptr=M._malloc(16);
  try {for(let index=0;index<(M._FPDFPage_GetAnnotCount?.(engine.page)??0);index++){
    const handle=M._FPDFPage_GetAnnot(engine.page,index);
    try {if(!M._FPDFAnnot_GetRect(handle,ptr))throw new Error('This PDF contains an annotation without readable bounds.');
      const [left,top,right,bottom]=M.HEAPF32.subarray(ptr>>2,(ptr>>2)+4);out.push({box:{x:left,top,w:right-left,h:top-bottom}});
    } finally {M._FPDFPage_CloseAnnot(handle);}
  }} finally {M._free(ptr);}return out;
}
const overlaps=(a,b)=>Math.min(a.x+a.w,b.x+b.w)-Math.max(a.x,b.x)>0.5&&Math.min(a.top,b.top)-Math.max(bottom(a),bottom(b))>0.5;

/** A subset font can retain valid Unicode extraction while painting missing-glyph boxes. */
export function ensureRenderableRuns(engine,paragraph,runs) {
  const fonts=new Map(),result=[];
  for(const run of runs){
    const source=Number.isInteger(run.sourceIndex)?run.sourceIndex:paragraph.runs.findIndex(original=>original.family===run.family);
    let bytes=fonts.get(source);
    if(bytes===undefined){bytes=source>=0?engine.runFontData(paragraph.id,source):null;fonts.set(source,bytes);}
    const known=new Set(paragraph.runs.filter((original,index)=>index===source&&original.family===run.family).flatMap(original=>[...original.text]));
    const local=PdfEngine.localFonts.get(`${run.family}|${run.bold?'1':'0'}${run.italic?'1':'0'}`);
    const covers=char=>/\s/u.test(char)||known.has(char)||!!((local??bytes)&&sfntCovers(local??bytes,[char.codePointAt(0)]));
    let chunk='',fallback=null;
    const push=()=>{if(!chunk)return;result.push(fallback?{...run,text:chunk,family:'Noto Sans',sourceIndex:-1,bold:!!run.bold,italic:!!run.italic}:{...run,text:chunk});chunk='';};
    for(const token of run.text.match(/\S+\s*|\s+/gu)??[]){const missing=[...token].some(char=>!covers(char));
      if(missing){const font=PdfEngine.localFonts.get(`Noto Sans|${run.bold?'1':'0'}${run.italic?'1':'0'}`);if(!font||!sfntCovers(font,[...token].map(char=>char.codePointAt(0))))throw new Error('The local editor fonts cannot render a character in this text. Choose another character and retry.');}
      if(fallback!==null&&fallback!==missing)push();fallback=missing;chunk+=token;
    }push();
  }
  return result;
}

/** Capture logical order before edits can make paragraph rectangles overlap. */
export function captureFlow(engine) {
  const pages=[];
  for(let pageIndex=0;pageIndex<engine.pageCount;pageIndex++) {
    engine.loadPage(pageIndex);
    if(engine.M._FPDFPage_GetRotation(engine.page)!==0)throw new Error('Automatic pagination does not support rotated PDF pages.');
    const objects=objectsOnPage(engine),paragraphs=paragraphsOnPage(engine,objects);
    const markerIndices=generatedPageMarkerIndices(engine);
    pages.push({pageIndex,width:engine.pageWidth,height:engine.pageHeight,objects,paragraphs,markerIndices,generated:markerIndices.length>0,annotations:annotationBoxes(engine)});
  }
  const sections=analyzeCvSections(pages).sections;
  const unsafe=sections.flatMap(section=>section.reasons).find(reason=>/ambiguous section columns|shared PDF object|unknown bounds|ambiguous identities|artwork-only/.test(reason));
  if(unsafe)throw new Error('This PDF has ambiguous columns or shared artwork that cannot be repaginated safely.');
  const paragraphSections=new Map();
  for(const section of sections)for(const fragment of section.fragments)for(const id of fragment.paragraphIds)paragraphSections.set(`${fragment.pageIndex}:${id}`,section);
  const repeated=new Map();
  for(const page of pages)for(const p of page.paragraphs)if(p.box.top>page.height-65||bottom(p.box)<45){
    const key=paragraphText(p);const list=repeated.get(key)??new Set();list.add(page.pageIndex);repeated.set(key,list);
  }
  const blocks=[];
  for(const page of pages) {
    const underlays=page.objects.filter(object=>isPageUnderlay(object,page));
    const left=Math.max(12,Math.min(...page.paragraphs.filter(paragraph=>!paragraph.invisible).map(paragraph=>paragraph.box.x),48));
    page.contentRight=underlays.length?Math.max(...underlays.map(object=>object.box.x+object.box.w)):page.width-left;
    const fixedBoxes=[],claimed=new Set([...page.markerIndices,...underlays.map(object=>object.index)]);page.backgrounds=[];
    const pageBlocks=[];
    for(const [index,paragraph] of page.paragraphs.entries()) {
      const text=paragraphText(paragraph),section=paragraphSections.get(`${page.pageIndex}:${paragraph.id}`);
      const fixed=!text.trim()||paragraph.invisible||
        ((paragraph.box.top>page.height-65||bottom(paragraph.box)<45)&&(repeated.get(text)?.size>1||/^(?:page\s*)?\d+(?:\s*(?:of|\/)\s*\d+)?$/i.test(text.trim())));
      if(fixed){fixedBoxes.push(rect(paragraph.box));for(const id of paragraph.objectIndices)claimed.add(id);continue;}
      // Font ascent/descent padding can overlap neighboring paragraphs even
      // when their glyphs do not. Flow uses actual owned ink; identity retains
      // the native paragraph rectangle so selection and draft recovery stay stable.
      const objectIndices=paragraph.objectIndices;
      for(const id of objectIndices)claimed.add(id);
      pageBlocks.push({id:`paragraph:${page.pageIndex}:${index}`,pageIndex:page.pageIndex,sectionId:section?.id??'body',
        kind:section?.title===text.trim()?'heading':'paragraph',paragraphIds:[paragraph.id],objectIndices:[...objectIndices],
        handles:objectIndices.map(index=>page.objects[index].handle),wrapWidth:page.contentRight-paragraph.box.x,box:union(objectIndices.map(index=>page.objects[index].box)),originalBox:rect(paragraph.box),text,paragraph});
    }
    for(const object of page.objects) {
      if(claimed.has(object.index))continue;
      if(object.box.w>=page.width*.95&&object.box.h>=page.height*.95){engine.loadPage(page.pageIndex);page.backgrounds.push({type:object.type,color:engine.objectFill(object.handle)});continue;}
      const section=sections.find(section=>section.fragments.some(fragment=>fragment.pageIndex===page.pageIndex&&fragment.objectIndices.includes(object.index)));
      const candidates=pageBlocks.filter(block=>!section||block.sectionId===section.id);
      const ranked=candidates.map(block=>({block,distance:Math.max(bottom(object.box)-block.box.top,bottom(block.box)-object.box.top,0)})).sort((a,b)=>a.distance-b.distance||b.block.box.top-a.block.box.top);
      if(!ranked.length||(!section&&(object.box.top<45||bottom(object.box)>page.height-30))){fixedBoxes.push(object.box);continue;}
      const target=ranked[0].block;target.objectIndices.push(object.index);target.handles.push(object.handle);target.box=union([target.box,object.box]);
    }
    for(const group of groupFlowRows(pageBlocks))if(group.memberIds)for(const id of group.memberIds){const block=pageBlocks.find(item=>item.id===id);block.wrapWidth=block.box.w;}
    pageBlocks.sort((a,b)=>b.box.top-a.box.top||a.box.x-b.box.x);
    const top=pageBlocks.length?Math.max(...pageBlocks.map(block=>block.box.top)):page.height-48;
    const margin=Math.max(24,Math.min(72,page.height-top));
    page.contentTop=top;page.contentBottom=Math.max(margin,...fixedBoxes.filter(box=>box.top<page.height/2).map(box=>box.top+8));
    page.fixedBoxes=fixedBoxes;
    for(let index=0;index<pageBlocks.length;index++) {
      const block=pageBlocks[index],previous=pageBlocks[index-1];
      block.gapBefore=previous?Math.max(0,bottom(previous.box)-block.box.top):(page.pageIndex?8:0);
      blocks.push(block);
    }
  }
  const last=pages.at(-1);
  const outerMargin=Math.max(24,Math.min(72,...pages.map(page=>page.height-Math.max(...page.objects.filter(object=>!page.markerIndices.includes(object.index)&&object.box.h<page.height*.95).map(object=>object.box.top),page.height-48))));
  const counter=pages.flatMap(page=>page.paragraphs.filter(paragraph=>(bottom(paragraph.box)<45||paragraph.box.top>page.height-65)&&counterPattern.test(paragraphText(paragraph))).map(paragraph=>({paragraph,page}))).at(0);
  const counterBox=counter?{...rect(counter.paragraph.box),top:counter.paragraph.box.top+(counter.paragraph.box.top>counter.page.height-65?last.height-counter.page.height:0)}:null;
  return {pages,blocks,sections,continuationPage:{width:last.width,height:last.height,contentTop:counterBox&&counterBox.top>last.height-65?Math.min(last.height-outerMargin,bottom(counterBox)-12):last.height-outerMargin,contentBottom:outerMargin,fixedBoxes:counterBox?[counterBox]:[]}};
}

function updateBlock(engine,block,runs,format) {
  engine.loadPage(block.pageIndex);
  const original=block.paragraph;
  runs=ensureRenderableRuns(engine,original,runs);
  const preview=engine.previewParagraph(original.id,runs,format??original.format);
  if(!preview?.lines?.length)throw new Error('Could not lay out the updated text.');
  const paragraph=engine.editStep('Reflow CV text',()=>{
    // The native surgical path can ignore wrapping or use the page edge instead
    // of the CV margin. Every replacement gets the same bounded native layout.
    const previous=[...new Set([...engine.paragraphObjects(original.id),...(original.whitespaceObjects??[])])];
    const updated=engine.addParagraph(original.box.x,original.box.top,Math.min(block.wrapWidth,engine.pageWidth-original.box.x-2),runs,format??original.format);
    if(!updated)return null;
    for(const handle of previous)if(!engine.historyRemoveObject(handle))throw new Error('Could not replace all original paragraph objects.');
    if(!engine.generateContent())throw new Error('Could not rebuild the wrapped paragraph.');
    return updated;
  });
  if(!paragraph)throw new Error('Could not update the paragraph.');
  const text=runs.map(run=>run.text).join(''),objects=objectsOnPage(engine);
  const handles=new Set(engine.paragraphObjects(paragraph.id));
  const oldTextHandles=new Set(block.paragraph.objectIndices.map(index=>block.sourceObjects[index]?.handle));
  const decorations=block.handles.filter(handle=>!oldTextHandles.has(handle)&&objects.some(object=>object.handle===handle));
  block.handles=[...handles,...decorations];block.paragraph=paragraph;block.text=text;block.edited=true;block.previewLines=preview.lines;
  block.renderRuns=runs;block.editPreview=engine.previewParagraph(paragraph.id,runs,format??original.format);
  block.box=union(objects.filter(object=>handles.has(object.handle)||decorations.includes(object.handle)).map(object=>object.box));
  block.lineFragments=inspectParagraphLines(engine,paragraph).map(line=>({...line,handles:line.objectIndices.map(index=>objects[index].handle)}));
}

const counterPattern=/^(\s*(?:page\s*)?)(\d+)(\s*(?:of|\/)\s*)(\d+)(\s*)$/i;
function counters(engine){return readParagraphs(engine).filter(paragraph=>(bottom(paragraph.box)<45||paragraph.box.top>engine.pageHeight-65)&&counterPattern.test(paragraphText(paragraph)));}
function updateCounters(engine,flow,addedPages,removedPages){
  const total=engine.pageCount-removedPages.length;
  const template=flow.pages.flatMap(page=>page.paragraphs.filter(paragraph=>(bottom(paragraph.box)<45||paragraph.box.top>page.height-65)&&counterPattern.test(paragraphText(paragraph))).map(paragraph=>({paragraph,pageIndex:page.pageIndex}))).find(item=>item.pageIndex<total);
  if(!template)return;
  engine.loadPage(template.pageIndex);
  const source=counters(engine).find(paragraph=>near(paragraph.box,template.paragraph.box));
  const makeText=index=>paragraphText(template.paragraph).replace(counterPattern,(_,prefix,current,separator,count,suffix)=>`${prefix}${index+1}${separator}${total}${suffix}`);
  const prepared=new Map();
  for(const page of addedPages)prepared.set(page.index,ensureRenderableRuns(engine,source??template.paragraph,replacementRuns(source??template.paragraph,makeText(page.index))));
  for(let pageIndex=0;pageIndex<engine.pageCount;pageIndex++){
    engine.loadPage(pageIndex);const existing=counters(engine);
    if(removedPages.includes(pageIndex)){
      for(const paragraph of existing)for(const handle of new Set([...engine.paragraphObjects(paragraph.id),...(paragraph.whitespaceObjects??[])]))if(!engine.historyRemoveObject(handle))throw new Error('Could not remove a generated page counter.');
    }else if(existing.length){
      for(const paragraph of existing){const text=makeText(pageIndex);if(text===paragraphText(paragraph))continue;const runs=ensureRenderableRuns(engine,paragraph,replacementRuns(paragraph,text));if(!engine.commitParagraph(paragraph.id,runs,paragraph.format))throw new Error('Could not update the page counter.');removeParagraphWhitespace(engine,paragraph);}
    }else if(prepared.has(pageIndex)){
      const original=template.paragraph,offset=original.box.top>flow.pages[template.pageIndex].height-65?engine.pageHeight-flow.pages[template.pageIndex].height:0,created=engine.addParagraph(original.box.x,original.box.top+offset,Math.min(engine.pageWidth-original.box.x-10,Math.max(original.box.w,100)),prepared.get(pageIndex),original.format);
      if(!created)throw new Error('Could not create the continuation page counter.');
      const dy=original.lines?.[0]?.y+offset-created.lines?.[0]?.y;
      if(Number.isFinite(dy))for(const handle of engine.paragraphObjects(created.id))engine.translateObject(handle,0,dy);
    }
    if(!engine.generateContent())throw new Error('Could not save the page counter.');
  }
}

/** Apply one accepted change to a scratch/transaction engine; never writes files. */
export async function reflowDocument(engine,{edits=[],sectionOrder=null,maxPages=20}={}) {
  const previousPins=engine.pinnedPages,activePage=engine.pageIndex;
  engine.pinnedPages=new Set(Array.from({length:engine.pageCount},(_,index)=>index));
  try {
    const flow=captureFlow(engine);
    for(const block of flow.blocks)block.sourceObjects=flow.pages[block.pageIndex].objects;
    for(const edit of edits) {
      const block=flow.blocks.find(block=>block.pageIndex===edit.identity.pageIndex&&block.text===edit.identity.text&&near(block.originalBox,edit.identity.box));
      if(!block)throw new Error('This paragraph is outside the editable document flow.');
      const runs=edit.runs??replacementRuns(block.paragraph,edit.text);
      updateBlock(engine,block,runs,edit.format??block.paragraph.format);
    }
    const indexed=new Map();
    for(const page of flow.pages){engine.loadPage(page.pageIndex);indexed.set(page.pageIndex,new Map(objectsOnPage(engine).map(object=>[object.handle,object.index])));}
    for(const block of flow.blocks) {
      block.objectIndices=block.handles.map(handle=>indexed.get(block.pageIndex).get(handle)).filter(Number.isInteger);
      if(!block.objectIndices.length)throw new Error('A complete paragraph could not be retained during pagination.');
      const page=flow.pages[block.pageIndex];
      if(block.edited||block.paragraph.lines?.length>1||block.box.h>page.contentTop-page.contentBottom){
        engine.loadPage(block.pageIndex);
        const lines=block.lineFragments??inspectParagraphLines(engine,block.paragraph);
        for(const line of lines)if(line.handles)line.objectIndices=line.handles.map(handle=>indexed.get(block.pageIndex).get(handle));
        block.lineFragments=lines;
        if(lines.length>1||block.box.h>page.contentTop-page.contentBottom) {
          const used=new Set(lines.flatMap(line=>line.objectIndices));
          const extra=block.objectIndices.filter(index=>!used.has(index));
          block.parts=lines.map((line,index)=>({id:`${block.id}:line:${index}`,pageIndex:block.pageIndex,sectionId:block.sectionId,kind:'line',
            box:index===0&&extra.length?union([rect(line.box),...objectsOnPage(engine).filter(object=>extra.includes(object.index)).map(object=>object.box)]):rect(line.box),objectIndices:[...line.objectIndices,...(index===0?extra:[])],paragraphIds:[],lineIndex:index,gapBefore:index?Math.max(0,bottom(lines[index-1].box)-line.box.top):0}));
        }
      }
    }
    let ordered=flow.blocks;
    if(sectionOrder){const rank=new Map(sectionOrder.map((title,index)=>[title,index]));const titles=new Map(flow.sections.map(section=>[section.id,section.title]));ordered=[...ordered].sort((a,b)=>(rank.get(titles.get(a.sectionId))??-1)-(rank.get(titles.get(b.sectionId))??-1));}
    const grouped=groupFlowRows(ordered);
    const plan=planPdfPagination({pages:flow.pages,blocks:grouped,continuationPage:flow.continuationPage,maxPages});
    for(const block of flow.blocks){const moving=block.edited||plan.moves.some(move=>move.fromPage===block.pageIndex&&move.objectIndices.some(index=>block.objectIndices.includes(index)));if(moving&&flow.pages[block.pageIndex].annotations.some(annotation=>overlaps(annotation.box,block.originalBox)))throw new Error('This PDF contains a link or annotation in moving content. Its text cannot be moved safely.');}
    if(plan.pages.length>maxPages)throw new Error('This edit would exceed the 20-page document limit. Shorten the text and try again.');
    if(plan.addedPages.length&&flow.pages.some(page=>page.backgrounds.some(background=>background.type!==2||!background.color||background.color.a>0&&[background.color.r,background.color.g,background.color.b].some(channel=>channel<250))))throw new Error('This PDF has a page background that cannot be reproduced on continuation pages.');
    for(const page of plan.addedPages){const index=appendPage(engine,{width:page.width,height:page.height});engine.pinnedPages.add(index);}
    const captured=plan.moves.map(move=>{engine.loadPage(move.fromPage);return {...move,handles:move.objectIndices.map(index=>engine.objectAt(index)?.handle)};});
    const moved=new Set();
    for(const move of captured)for(const handle of move.handles){if(!handle||moved.has(handle))throw new Error('Pagination encountered a shared PDF object.');moved.add(handle);}
    for(const move of captured){engine.loadPage(move.fromPage);for(const handle of move.handles)if(!engine.M._FPDFPage_RemoveObject(engine.page,handle))throw new Error('Could not move the complete paragraph.');engine._pageDirty=true;}
    for(const move of captured){engine.loadPage(move.toPage);for(const handle of move.handles){engine.M._FPDFPage_InsertObject(engine.page,handle);engine.translateObject(handle,move.dx,move.dy);}engine._pageDirty=true;}
    for(const page of plan.pages){engine.loadPage(page.index);if(!engine.generateContent())throw new Error('Could not save the repaginated page.');}
    updateCounters(engine,flow,plan.addedPages,plan.removedPages);
    if(plan.removedPages.length)removeTrailingPages(engine,Math.min(...plan.removedPages));
    engine._spliceOk=false;
    const bytes=await engine.saveSpliced();
    if(!bytes)throw new Error('Could not prepare the repaginated PDF.');
    const liveLines=[];
    for(const block of flow.blocks.filter(block=>block.edited)){
      const placements=plan.placements.filter(placement=>placement.blockId===block.id||placement.parentBlockId===block.id||placement.blockId.startsWith(`${block.id}:line:`));
      for(const [lineIndex,line] of (block.lineFragments??[]).entries()){
        const placement=placements.find(item=>line.objectIndices.some(index=>item.objectIndices.includes(index)));
        if(placement)liveLines.push({blockId:block.id,lineIndex,pageIndex:placement.toPage,x:line.box.x+placement.dx,baseline:line.baseline+placement.dy,top:line.box.top+placement.dy,h:line.box.h});
      }
    }
    return {bytes,pages:plan.pages,liveLines,editedLayouts:flow.blocks.filter(block=>block.edited).map(block=>({blockId:block.id,runs:block.renderRuns,preview:block.editPreview})),generatedPages:plan.pages.filter(page=>page.generated).map(page=>page.index),plan};
  } finally {engine.pinnedPages=previousPins;if(engine.doc&&activePage<engine.pageCount)engine.loadPage(activePage);}
}
