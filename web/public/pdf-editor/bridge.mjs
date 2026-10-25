// SPDX-License-Identifier: AGPL-3.0-only
import { PdfEngine } from '../vendor/bentopdf/core.js';
import { paragraphText, replacementRuns, readParagraphs } from './model.mjs';
import { reflowDocument, describePath } from './reflow.mjs';
import { analyzeCvSections } from './sections.mjs';

const channel = 'career-ops-pdf-editor';
const session = new URLSearchParams(location.search).get('session');
const origin = location.origin;
const MAX_BYTES = 20 * 1024 * 1024;
const MAX_HISTORY_BYTES = 64 * 1024 * 1024;
const styleKeys = ['text','family','bold','italic','size','rgba','underline','strike','script','renderMode','strokeRgba','strokeWidth','hScale','rise','fallback','sourceIndex'];
let native;
let engine;
let loaded = false;
let stableBytes = null;
let pages = [];
let sections = [];
let selection = null;
let revision = 0;
let undo = [];
let redo = [];
let preview = null;
let queue = Promise.resolve();
let internal = false;
let dragSection = null;
let livePreview=null;
let layoutGeneration=0;
let layoutTimer;
let previewPageIndex=0;

function send(type, payload = {}, requestId) {
  parent.postMessage({ channel, session, type, ...payload, ...(requestId ? { requestId } : {}) }, origin);
}
function errorMessage(error) { return error instanceof Error ? error.message : 'The PDF editor could not finish that change.'; }
function fail(error, requestId) {
  document.getElementById('career-status').textContent = errorMessage(error);
  send('error', { message: errorMessage(error) }, requestId);
}
function enqueue(action, requestId) {
  queue = queue.then(action).catch((error) => fail(error, requestId));
  return queue;
}
function buffer(bytes) { return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength); }
function locate(pageIndex, text, box, candidates = pages[pageIndex]?.paragraphs ?? []) {
  const found = candidates.map((paragraph,index) => ({paragraph,index})).filter(({paragraph}) => paragraphText(paragraph) === text &&
    Math.abs(paragraph.box.x-box.x)<1 && Math.abs(paragraph.box.top-box.top)<1);
  return found.length === 1 ? found[0] : null;
}
function selected() { return selection ? pages[selection.pageIndex]?.paragraphs[selection.index] : null; }
function selectedIdentity() {
  const p=selected(); return p ? {pageIndex:selection.pageIndex,text:paragraphText(p),box:{...p.box}} : null;
}
function idOfSelection() { return selection ? `${selection.pageIndex}:${selection.index}` : ''; }
function emitSelection(requestId) {
  const p=selected();
  send('selection',{paragraphId:idOfSelection(),pageIndex:selection?.pageIndex??0,text:p?paragraphText(p):'',revision},requestId);
}
function cleanInline(runs,format) {
  return {runs:runs.map(run=>Object.fromEntries(styleKeys.filter(key=>run[key]!==undefined && ['string','number','boolean'].includes(typeof run[key])).map(key=>[key,run[key]]))),format:{...format}};
}
function draft() {
  const active=native?.draft();
  if(!active || preview) return null;
  const index=native.state.paragraphs.findIndex(p=>p.id===active.para.id);
  if(index<0) return null;
  return {paragraphId:`${engine.pageIndex}:${index}`,pageIndex:engine.pageIndex,text:active.runs.map(r=>r.text).join(''),original:paragraphText(active.para),modified:native.hasChanges(),inlineState:cleanInline(active.runs,active.format)};
}
function emitDraft(requestId) { const value=draft(); if(value){send('draft',value,requestId);scheduleLiveLayout();} }
function hasDraft() { return !!native?.hasChanges(); }
function annotationBoxes() {
  const M=engine.M;
  const count=M._FPDFPage_GetAnnotCount?.(engine.page)??0;
  const annotations=[];
  for(let i=0;i<count;i++) {
    const handle=M._FPDFPage_GetAnnot(engine.page,i);
    const ptr=M._malloc(16);
    try {
      if(M._FPDFAnnot_GetRect(handle,ptr)) {
        const [left,top,right,bottom]=Array.from(M.HEAPF32.subarray(ptr>>2,(ptr>>2)+4));
        annotations.push({box:{x:left,y:bottom,w:right-left,h:top-bottom}});
      }
    } finally { M._free(ptr); M._FPDFPage_CloseAnnot(handle); }
  }
  return annotations;
}
function inspectPages() {
  const activePage=engine.pageIndex;
  pages=[];
  for(let pageIndex=0;pageIndex<engine.pageCount;pageIndex++) {
    engine.loadPage(pageIndex);
    const paragraphs=readParagraphs(engine);
    const objects=Array.from({length:engine.objectCount()},(_,index)=>{
      const object=engine.objectAt(index); return {...object,box:engine.objectBounds(object.handle),...(object.type===2?describePath(engine,object.handle):{})};
    });
    const byHandle=new Map(objects.map(object=>[object.handle,object.index]));
    for(const paragraph of paragraphs) paragraph.objectIndices=[...new Set([...engine.paragraphObjects(paragraph.id),...(paragraph.whitespaceObjects??[])])].map(handle=>byHandle.get(handle)).filter(index=>Number.isInteger(index));
    pages.push({pageIndex,width:engine.pageWidth,height:engine.pageHeight,paragraphs,objects,annotations:annotationBoxes()});
  }
  engine.loadPage(Math.min(activePage,engine.pageCount-1));
  native.refresh();
  const current=pages[engine.pageIndex],previousParagraphs=current.paragraphs;
  current.paragraphs=native.state.paragraphs;
  for(const paragraph of current.paragraphs)paragraph.objectIndices=locate(engine.pageIndex,paragraphText(paragraph),paragraph.box,previousParagraphs)?.paragraph.objectIndices??[];
  sections=analyzeCvSections(pages).sections;
  // Native paragraph ids are rebuilt on page navigation; retain geometric identities for section membership.
  for(const section of sections)section.targets=section.fragments.flatMap(fragment=>pages[fragment.pageIndex].paragraphs
    .filter(paragraph=>fragment.paragraphIds.includes(paragraph.id))
    .map(paragraph=>({pageIndex:fragment.pageIndex,text:paragraphText(paragraph),box:{...paragraph.box}})));
  paintChrome();
}
function describeTarget(paragraphId,expectedText) {
  const match=typeof paragraphId==='string' && /^(\d+):(\d+)$/.exec(paragraphId);
  if(!match) throw new Error('Select text in the PDF first.');
  const pageIndex=Number(match[1]),index=Number(match[2]);
  const paragraph=pages[pageIndex]?.paragraphs[index];
  if(!paragraph?.editable || paragraphText(paragraph)!==expectedText) throw new Error('This paragraph changed. Select it again before applying the rewrite.');
  return {pageIndex,index,text:expectedText,box:{...paragraph.box}};
}
function freshTarget(identity) {
  engine.loadPage(identity.pageIndex);
  const paragraphs=readParagraphs(engine);
  const match=locate(identity.pageIndex,identity.text,identity.box,paragraphs);
  if(!match?.paragraph.editable) throw new Error('The selected paragraph is no longer available.');
  return { ...match,paragraphs };
}
function bindEditor(ed) {
  if(!ed || ed.dataset.careerBound) return;
  ed.dataset.careerBound='1';
  ed.addEventListener('input',()=>{if(!internal&&!preview) emitDraft();});
  ed.addEventListener('compositionend',()=>{if(!internal&&!preview) emitDraft();});
  // Native Enter, list indentation and atomic deletion mutate the DOM without input.
  let lastDraft='';
  const observer=new MutationObserver(()=>{
    if(internal||preview||native.state.editing?.editable!==ed)return;
    const value=draft(),signature=JSON.stringify(value);
    if(value&&signature!==lastDraft){lastDraft=signature;send('draft',value);scheduleLiveLayout();}
  });
  observer.observe(ed,{subtree:true,childList:true,characterData:true,attributes:true});
  ed.addEventListener('blur',()=>{setTimeout(()=>{if(!internal&&!preview&&hasDraft()&&!document.activeElement?.closest('.editor'))enqueue(()=>flush());},0);});
}
function openIdentity(identity,{notify=true,text,inlineState,caret}={}) {
  internal=true;
  try {
    native.cancel();
    const {paragraph,index}=freshTarget(identity);
    native.refresh();
    const match=locate(identity.pageIndex,identity.text,identity.box,native.state.paragraphs);
    if(!match) throw new Error('The selected paragraph is no longer available.');
    pages[identity.pageIndex].paragraphs=native.state.paragraphs;
    selection={pageIndex:identity.pageIndex,index:match.index};
    const ed=native.edit(match.paragraph,caret);
    bindEditor(ed);
    if(text!==undefined) {
      const supplied=inlineState?.runs;
      const runs=Array.isArray(supplied)&&supplied.map(run=>run.text??'').join('')===text ? supplied.map(run=>Object.fromEntries(styleKeys.filter(key=>run[key]!==undefined).map(key=>[key,run[key]]))) : replacementRuns(match.paragraph,text);
      native.setRuns(runs,inlineState?.format??match.paragraph.format);
    }
    paintChrome();
    if(notify) emitSelection();
  } finally { internal=false; }
}
function pushHistory(stack,bytes) {
  stack.push(bytes);
  while(stack.length>10 || (stack.length>1&&stack.reduce((sum,b)=>sum+b.byteLength,0)>MAX_HISTORY_BYTES))stack.shift();
}
async function rawSnapshot() {
  const bytes=await engine.saveSpliced();
  if(!bytes)throw new Error('Could not prepare the PDF for editing.');
  if(bytes.byteLength>MAX_BYTES)throw new Error('This edit would make the PDF larger than 20 MB.');
  return bytes;
}
async function changed(requestId) {
  stableBytes=await rawSnapshot();
  revision++;
  send('changed',{bytes:buffer(stableBytes),pageCount:engine.pageCount,revision,canUndo:undo.length>0,canRedo:redo.length>0},requestId);
  paintChrome();
}
async function restore(bytes,pageIndex=0) {
  internal=true;
  try { native.cancel(); engine.pinnedPages=undefined; engine.open(bytes); engine.loadPage(Math.min(pageIndex,engine.pageCount-1)); selection=null; inspectPages(); }
  finally { internal=false; }
}
async function transaction(mutate,requestId,{pending=draft(),afterSelection=null}={}) {
  const before=stableBytes.slice(),beforeUndo=[...undo],beforeRedo=[...redo],beforeSelection=selectedIdentity(),pageIndex=engine.pageIndex;
  internal=true;
  try {
    native.cancel();
    await rawSnapshot();
    await mutate();
    pushHistory(undo,before);redo=[];
    native.state.dirty=false;
    selection=null;inspectPages();
    await changed(requestId);
    if(afterSelection)openIdentity(afterSelection,{notify:false});
    emitSelection();
  } catch(error) {
    undo=beforeUndo;redo=beforeRedo;stableBytes=before;
    await restore(before,pageIndex);
    if(pending) {
      const identity=beforeSelection??describeTarget(pending.paragraphId,pending.original);
      openIdentity(identity,{notify:false,text:pending.text,inlineState:pending.inlineState});
    } else if(beforeSelection)openIdentity(beforeSelection,{notify:false});
    throw error;
  } finally { internal=false; }
}
async function flush(requestId) {
  if(preview)throw new Error('Accept or reject the AI preview before saving.');
  for(let attempt=0;attempt<20;attempt++){
    const active=native.draft(),pending=draft();
    if(!active||!pending||!native.hasChanges()){
      if(active){clearLiveLayout();internal=true;native.cancel();internal=false;}
      return false;
    }
    const signature=JSON.stringify(pending),identity=describeTarget(pending.paragraphId,pending.original);
    const result=await computeReflow({edits:[{identity,runs:active.runs,format:active.format}]});
    if(JSON.stringify(draft())!==signature)continue;
    clearLiveLayout();
    await transaction(()=>{engine.open(result.bytes);engine.loadPage(Math.min(identity.pageIndex,engine.pageCount-1));},requestId,{pending});
    return true;
  }
  throw new Error('The text is still changing. Finish typing and save again; your draft is retained.');
}
function decorateParagraphs() {
  if(!native||!loaded)return;
  const editingId=native.state.editing?.para?.id;
  const candidates=native.state.paragraphs.filter(p=>p.editable&&!p.invisible&&p.id!==editingId);
  const boxes=[...document.querySelectorAll('#overlay .para-layer > .para-box:not(.block-box)')];
  boxes.forEach((box,index)=>{
    const paragraph=candidates[index];if(!paragraph)return;
    box.setAttribute('role','button');box.setAttribute('aria-label',`Edit paragraph: ${paragraphText(paragraph)}`);box.tabIndex=0;
    if(!box.dataset.careerKeys){box.dataset.careerKeys='1';box.addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();requestOpen(paragraph);}});}
  });
}
function requestOpen(paragraph,caret) {
  if(internal||preview||!paragraph)return;
  const identity={pageIndex:engine.pageIndex,text:paragraphText(paragraph),box:{...paragraph.box}};
  enqueue(async()=>{const changed=await flush();if(changed){const matches=pages.flatMap(page=>page.paragraphs.filter(p=>paragraphText(p)===identity.text).map(p=>({pageIndex:page.pageIndex,text:identity.text,box:p.box})));if(matches.length!==1)throw new Error('The page layout changed. Click the paragraph again.');openIdentity(matches[0],{caret});}else openIdentity(identity,{caret});});
}
function sectionSelection(section) {
  const targets=section.targets.map(identity=>{
    const match=locate(identity.pageIndex,identity.text,identity.box);
    if(!match)throw new Error('This section changed. Select it again.');
    return {paragraphId:`${identity.pageIndex}:${match.index}`,text:identity.text,pageIndex:identity.pageIndex};
  });
  if(targets.length>24||targets.some(target=>target.text.length>4000)||targets.reduce((sum,target)=>sum+target.text.length,0)>24000)throw new Error('This section is too large for one AI rewrite. Click an individual paragraph to rewrite a smaller part.');
  send('section-selection',{sectionId:section.id,title:section.title,targets});
}
function paintChrome() {
  if(!loaded||!native)return;
  const layout=preview?.result??livePreview,count=layout?.pages.length??engine.pageCount,current=layout?previewPageIndex:engine.pageIndex;
  document.getElementById('career-page').textContent=`Page ${current+1} of ${count}`;
  document.getElementById('career-prev').disabled=current===0;
  document.getElementById('career-next').disabled=current===count-1;
  document.getElementById('career-undo').disabled=!!preview||!undo.length;
  document.getElementById('career-redo').disabled=!!preview||!redo.length;
  decorateParagraphs();
  document.querySelectorAll('.career-section,.career-drop').forEach(element=>element.remove());
  const destinations=document.getElementById('career-destinations');
  destinations.replaceChildren();
  const addDestination=(title,beforeId)=>{
    const button=document.createElement('button');button.type='button';button.textContent=title;
    button.setAttribute('aria-label',`Drop section ${title.toLowerCase()}`);
    wireDrop(button,beforeId);destinations.append(button);
  };
  for(const section of sections)addDestination(`Before ${section.title}`,section.id);
  addDestination('At end',null);
  const wrap=document.getElementById('pageWrap');
  for(const section of sections){
    const fragment=section.fragments.find(item=>item.pageIndex===engine.pageIndex);if(!fragment)continue;
    const handle=document.createElement('button');handle.className='career-section';handle.type='button';
    handle.textContent=`⠿ ${section.title}`;handle.setAttribute('aria-label',`Select section: ${section.title}`);
    handle.style.top=`${(engine.pageHeight-fragment.box.top)*native.zoomValue-24}px`;
    handle.style.left=`${Math.max(0,fragment.box.x*native.zoomValue)}px`;
    handle.disabled=!!preview;handle.draggable=false;
    handle.title=section.movable?'Drag to move the whole section':section.reasons.join(' ');
    let pointerStart=null,suppressClick=false;
    handle.addEventListener('click',()=>{if(suppressClick){suppressClick=false;return;}enqueue(async()=>{await flush();sectionSelection(section);});});
    handle.addEventListener('pointerdown',event=>{
      if(!section.movable||preview||event.button!==0)return;
      event.preventDefault();pointerStart={x:event.clientX,y:event.clientY};handle.setPointerCapture(event.pointerId);
    });
    handle.addEventListener('pointermove',event=>{
      if(!pointerStart)return;
      if(!dragSection&&Math.hypot(event.clientX-pointerStart.x,event.clientY-pointerStart.y)<5)return;
      dragSection=section.id;document.body.classList.add('moving-section');
      const target=document.elementFromPoint(event.clientX,event.clientY)?.closest('[data-section-destination]');
      document.querySelectorAll('[data-section-destination]').forEach(zone=>zone.classList.toggle('over',zone===target));
    });
    const finishDrag=event=>{
      if(!pointerStart)return;pointerStart=null;
      if(handle.hasPointerCapture(event.pointerId))handle.releasePointerCapture(event.pointerId);
      const moving=dragSection,target=document.elementFromPoint(event.clientX,event.clientY)?.closest('[data-section-destination]');
      dragSection=null;document.body.classList.remove('moving-section');
      if(moving){suppressClick=true;if(event.type==='pointerup'&&target)enqueue(()=>reorder(moving,target.dataset.sectionDestination||null));}
    };
    handle.addEventListener('pointerup',finishDrag);handle.addEventListener('pointercancel',finishDrag);
    handle.addEventListener('keydown',event=>{
      if(!event.altKey||!['ArrowUp','ArrowDown'].includes(event.key)||!section.movable)return;
      event.preventDefault();event.stopPropagation();const index=sections.findIndex(item=>item.id===section.id);
      if(event.key==='ArrowUp'&&index>0)enqueue(()=>reorder(section.id,sections[index-1].id));
      if(event.key==='ArrowDown'&&index<sections.length-1)enqueue(()=>reorder(section.id,sections[index+2]?.id??null));
    });
    wrap.append(handle);
    const zone=document.createElement('button');zone.type='button';zone.className='career-drop';zone.textContent=`Move before ${section.title}`;
    zone.style.top=`${Math.max(0,(engine.pageHeight-fragment.box.top)*native.zoomValue-10)}px`;
    zone.setAttribute('aria-label',`Move selected section before ${section.title}`);
    wireDrop(zone,section.id);
    wrap.append(zone);
  }
}
function wireDrop(zone,beforeSectionId){
  zone.dataset.sectionDestination=beforeSectionId??'';
  zone.addEventListener('dragover',event=>{if(dragSection){event.preventDefault();event.stopPropagation();zone.classList.add('over');}});
  zone.addEventListener('dragleave',()=>zone.classList.remove('over'));
  zone.addEventListener('drop',event=>{event.preventDefault();event.stopPropagation();const moving=dragSection;dragSection=null;document.body.classList.remove('moving-section');if(moving)enqueue(()=>reorder(moving,beforeSectionId));});
}
async function reorder(sectionId,beforeSectionId,requestId) {
  if(preview)throw new Error('Finish the AI preview before moving sections.');
  const anchor=id=>{const section=sections.find(item=>item.id===id);if(!section)throw new Error('Select the section again before moving it.');return {title:section.title,fragment:section.fragments[0]};};
  const movingAnchor=anchor(sectionId),beforeAnchor=beforeSectionId?anchor(beforeSectionId):null;
  await flush();
  inspectPages();
  const resolveAnchor=value=>sections.find(section=>section.title===value.title&&section.fragments[0].pageIndex===value.fragment.pageIndex&&Math.abs(section.fragments[0].box.top-value.fragment.box.top)<1)?.id;
  const movingId=resolveAnchor(movingAnchor),beforeId=beforeAnchor?resolveAnchor(beforeAnchor):null;
  if(!movingId||(beforeAnchor&&!beforeId))throw new Error('The section layout changed. Select the section again before moving it.');
  const ordered=sections.filter(section=>section.id!==movingId);
  const moving=sections.find(section=>section.id===movingId);
  const at=beforeId?ordered.findIndex(section=>section.id===beforeId):ordered.length;ordered.splice(at,0,moving);
  const result=await computeReflow({sectionOrder:ordered.map(section=>section.title)});
  await transaction(()=>engine.open(result.bytes),requestId);
  document.getElementById('career-status').textContent='Section moved. The PDF pages have adjusted automatically.';
}

function validatedTargets(targets) {
  if(!Array.isArray(targets)||targets.length===0||targets.length>100)throw new Error('Select a paragraph or section first.');
  const ids=new Set();
  return targets.map(target=>{
    if(ids.has(target.paragraphId))throw new Error('The same paragraph was included twice.');ids.add(target.paragraphId);
    const identity=describeTarget(target.paragraphId,target.expectedText);
    if(typeof target.text!=='string'||!target.text.trim()||target.text.length>12000)throw new Error('Enter between 1 and 12,000 characters for each paragraph.');
    return {identity,text:target.text};
  });
}
function removeLayoutCanvases() {
  document.getElementById('career-pages-preview')?.remove();
  document.getElementById('career-preview-description')?.remove();
  document.body.classList.remove('live-reflow','ai-preview');
  native.clearLayout();
}
function clearLiveLayout() {
  clearTimeout(layoutTimer);layoutGeneration++;livePreview=null;
  if(!preview)removeLayoutCanvases();
}
function clearPreview() {
  const active=!!preview;preview=null;
  if(active){removeLayoutCanvases();native.cancel();native.refresh();paintChrome();}
}
async function computeReflow(options) {
  const scratch=await PdfEngine.create();
  try {
    scratch.open(stableBytes);
    const result=await reflowDocument(scratch,options);
    if(result.bytes.byteLength>MAX_BYTES)throw new Error('This edit would make the PDF larger than 20 MB.');
    scratch.open(result.bytes);
    result.rasters=[];
    for(let index=0;index<scratch.pageCount;index++){scratch.loadPage(index);result.rasters.push(scratch.renderPage(native.zoomValue*devicePixelRatio));}
    return result;
  } finally {scratch.close();}
}
function displayLayout(result,kind,texts=[]) {
  document.getElementById('career-pages-preview')?.remove();document.getElementById('career-preview-description')?.remove();
  const container=document.createElement('div');container.id='career-pages-preview';
  const offsets=[];let height=0;
  for(const [index,page] of result.pages.entries()){
    offsets.push(height);const wrapper=document.createElement('div');wrapper.className='career-reflow-page';wrapper.dataset.pageIndex=String(index);
    wrapper.style.width=`${page.width*native.zoomValue}px`;wrapper.style.height=`${page.height*native.zoomValue}px`;
    const bitmap=result.rasters[index],canvas=document.createElement('canvas');canvas.width=bitmap.width;canvas.height=bitmap.height;
    canvas.style.width='100%';canvas.style.height='100%';canvas.setAttribute('role','img');canvas.setAttribute('aria-label',`PDF page ${index+1} of ${result.pages.length}`);
    canvas.getContext('2d').putImageData(new ImageData(bitmap.data,bitmap.width,bitmap.height),0,0);wrapper.append(canvas);container.append(wrapper);
    height+=page.height*native.zoomValue+24;
  }
  const wrap=document.getElementById('pageWrap');wrap.prepend(container);wrap.style.height=`${height-24}px`;
  document.body.classList.toggle('live-reflow',kind==='live');document.body.classList.toggle('ai-preview',kind==='ai');
  if(kind==='live')native.mapLayout(result.liveLines,result.pages,offsets,height,result.editedLayouts[0]);
  if(texts.length){const description=document.createElement('div');description.id='career-preview-description';description.className='career-visually-hidden';description.setAttribute('role','region');description.setAttribute('aria-label','AI rewrite preview');description.textContent=texts.join('\n\n');wrap.append(description);container.setAttribute('aria-describedby',description.id);}
  paintChrome();
}
function scheduleLiveLayout() {
  if(preview||internal||!loaded||!native.hasChanges())return;
  clearTimeout(layoutTimer);const generation=++layoutGeneration;
  layoutTimer=setTimeout(async()=>{
    const pending=draft(),active=native.draft();if(!pending||!active)return;
    try {
      const identity=describeTarget(pending.paragraphId,pending.original);
      const result=await computeReflow({edits:[{identity,runs:active.runs,format:active.format}]});
      if(generation!==layoutGeneration||preview||!native.draft())return;
      livePreview=result;previewPageIndex=Math.min(identity.pageIndex,result.pages.length-1);displayLayout(result,'live');
      document.getElementById('career-status').textContent=`Text flows across ${result.pages.length} ${result.pages.length===1?'page':'pages'}. Keep typing; Escape finishes this paragraph.`;
    } catch(error){if(generation===layoutGeneration)fail(error);}
  },180);
}
async function showPreview(targets,requestId) {
  await flush();
  const prepared=validatedTargets(targets);clearLiveLayout();
  try {
    const result=await computeReflow({edits:prepared.map(target=>({identity:target.identity,text:target.text}))});
    preview={prepared,result};previewPageIndex=Math.min(engine.pageIndex,result.pages.length-1);native.cancel();
    displayLayout(result,'ai',prepared.map(target=>target.text));send('previewed',{},requestId);
  } catch(error){clearPreview();throw error;}
}
async function replaceTargets(targets,requestId) {
  const prepared=validatedTargets(targets);clearPreview();await flush();
  const result=await computeReflow({edits:prepared.map(target=>({identity:target.identity,text:target.text}))});
  await transaction(()=>engine.open(result.bytes),requestId);
}
async function goPage(index) {
  const layout=preview?.result??livePreview;
  if(layout){if(index<0||index>=layout.pages.length)return;previewPageIndex=index;document.querySelector(`.career-reflow-page[data-page-index="${index}"]`)?.scrollIntoView({block:'start'});paintChrome();return;}
  if(index<0||index>=engine.pageCount)return;
  if(!preview)await flush();
  native.page(index);pages[index].paragraphs=native.state.paragraphs;
  if(!preview){selection=null;emitSelection();}
  paintChrome();
}
async function history(type,requestId) {
  if(preview)throw new Error('Finish the AI preview before undoing or redoing.');
  await flush();
  const from=type==='undo'?undo:redo,to=type==='undo'?redo:undo;
  if(!from.length)throw new Error(`Nothing to ${type}.`);
  const before=stableBytes.slice(),savedUndo=[...undo],savedRedo=[...redo],identity=selectedIdentity(),pageIndex=engine.pageIndex;
  try{
    native.cancel();await rawSnapshot();
    await restore(from.at(-1),pageIndex);from.pop();pushHistory(to,before);
    await changed(requestId);emitSelection();
  }catch(error){undo=savedUndo;redo=savedRedo;stableBytes=before;await restore(before,pageIndex);if(identity)openIdentity(identity,{notify:false});throw error;}
}
async function handle(message) {
  const {type,requestId}=message;
  if(type==='load'){
    if(!(message.bytes instanceof ArrayBuffer)||!message.bytes.byteLength||message.bytes.byteLength>MAX_BYTES)throw new Error('Choose a PDF smaller than 20 MB.');
    internal=true;
    try{
      clearPreview();clearLiveLayout();native.cancel();loaded=false;selection=null;
      engine.open(new Uint8Array(message.bytes));
      if(!engine.pageCount||engine.pageCount>20)throw new Error('Visual editing supports PDFs with 1 to 20 pages.');
      if(engine.documentInfo()?.signatures>0)throw new Error('Signed PDFs cannot be edited because changes invalidate their signature.');
      stableBytes=new Uint8Array(message.bytes).slice();undo=[];redo=[];revision=0;loaded=true;
      document.getElementById('empty').hidden=true;document.getElementById('pageWrap').hidden=false;
      inspectPages();native.fit();paintChrome();
      document.getElementById('career-status').textContent='Click text to type directly. Drag a section handle to reorder the complete section.';
      send('loaded',{pageCount:engine.pageCount,warnings:['Text and sections flow across PDF pages automatically. The editor adds matching pages when needed.']},requestId);
    }finally{internal=false;}
    return;
  }
  if(!loaded)throw new Error('Load a PDF before editing.');
  if(type==='select'){
    await flush();
    const match=/^(\d+):(\d+)$/.exec(message.paragraphId??'');
    const paragraph=match&&pages[Number(match[1])]?.paragraphs[Number(match[2])];
    if(!paragraph)throw new Error('Select a paragraph in the PDF first.');
    openIdentity({pageIndex:Number(match[1]),text:paragraphText(paragraph),box:paragraph.box},{notify:false});emitSelection(requestId);
  }else if(type==='restore-draft'){
    if(typeof message.text!=='string'||message.text.length>12000)throw new Error('The saved text draft is invalid.');
    const identity=describeTarget(message.paragraphId,message.expectedText);
    openIdentity(identity,{notify:false,text:message.text,inlineState:message.inlineState});emitDraft(requestId);
  }else if(type==='preview'||type==='preview-many'){
    await showPreview(type==='preview'?[message]:message.targets,requestId);
  }else if(type==='clear-preview'){
    clearPreview();send('previewed',{},requestId);
  }else if(type==='replace'||type==='replace-many'){
    await replaceTargets(type==='replace'?[message]:message.targets,requestId);
  }else if(type==='export'){
    if(!preview)await flush();
    send('exported',{bytes:buffer(stableBytes),revision},requestId);
  }else if(type==='undo'||type==='redo')await history(type,requestId);
  else if(type==='reorder-section')await reorder(message.sectionId,message.beforeSectionId??null,requestId);
  else if(type==='select-section'){
    await flush();const section=sections.find(item=>item.id===message.sectionId);if(!section)throw new Error('Section unavailable.');sectionSelection(section);send('section-selected',{},requestId);
  }else if(type==='page') {await goPage(message.pageIndex);send('page-changed',{pageIndex:engine.pageIndex},requestId);}
}
window.addEventListener('message',event=>{
  const message=event.data;
  if(event.source!==parent||event.origin!==origin||!message||message.channel!==channel||message.session!==session)return;
  if(!['load','select','restore-draft','preview','preview-many','clear-preview','replace','replace-many','export','undo','redo','reorder-section','select-section','page'].includes(message.type)||typeof message.requestId!=='string'||message.requestId.length>100)return;
  enqueue(()=>handle(message),message.requestId);
});
// All keyboard persistence/history actions use full-PDF snapshots, including native inline edits.
window.addEventListener('keydown',event=>{
  if(!loaded)return;
  const meta=event.ctrlKey||event.metaKey,key=event.key.toLowerCase();
  if(native?.state.editing&&meta&&['arrowdown','arrowup','end','home'].includes(key)){event.preventDefault();event.stopImmediatePropagation();native.moveCaretBoundary(['arrowdown','end'].includes(key),event.shiftKey);return;}
  if(meta&&['s','z','y'].includes(key)){
    event.preventDefault();event.stopImmediatePropagation();
    if(key==='s')enqueue(async()=>{await flush();send('save-request');});
    else enqueue(()=>history(key==='y'||event.shiftKey?'redo':'undo'));
  }else if(event.key==='Escape'){
    event.preventDefault();event.stopImmediatePropagation();if(!preview)enqueue(()=>flush());
  }else if(!native?.state.editing&&!event.target?.closest?.('.career-section')&&['Delete','Backspace','ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key)){
    event.stopImmediatePropagation();
  }
},true);
window.addEventListener('beforeinput',event=>{
  if(['historyUndo','historyRedo'].includes(event.inputType)){event.preventDefault();event.stopImmediatePropagation();enqueue(()=>history(event.inputType==='historyUndo'?'undo':'redo'));}
},true);
// Keep native hover/selection redraws from replacing the temporary AI preview canvas.
for(const eventType of ['pointerdown','pointermove','mousedown','mousemove','click','dblclick'])window.addEventListener(eventType,event=>{if(preview&&event.target?.closest?.('#stage'))event.stopImmediatePropagation();},true);
window.addEventListener('wheel',event=>{if(preview&&event.ctrlKey){event.preventDefault();event.stopImmediatePropagation();}},{capture:true,passive:false});
window.addEventListener('drop',event=>{if(event.dataTransfer?.files?.length){event.preventDefault();event.stopImmediatePropagation();}},true);
window.addEventListener('paste',event=>{if(!native?.state.editing){event.preventDefault();event.stopImmediatePropagation();}},true);
window.addEventListener('blur',()=>{if(loaded&&!preview&&hasDraft())enqueue(()=>flush());});

async function initialize() {
  if(!session||!/^[\w-]{8,100}$/.test(session)||parent===window)throw new Error('Open this editor from career-ops Documents.');
  const markup=await fetch('../vendor/bentopdf/native.html');if(!markup.ok)throw new Error('Could not load the local editor interface.');
  document.getElementById('native').innerHTML=await markup.text();
  document.getElementById('text-editor-app').prepend(document.getElementById('career-toolbar'));
  document.getElementById('file').disabled=true;
  document.getElementById('empty').hidden=true;
  await Promise.all([['Regular','00'],['Bold','10'],['Italic','01'],['BoldItalic','11']].map(async([style,key])=>{
    const response=await fetch(`../vendor/bentopdf/fonts/NotoSans-${style}.ttf`);if(!response.ok)throw new Error('Could not load local fonts.');
    const bytes=new Uint8Array(await response.arrayBuffer());PdfEngine.localFonts.set(`Noto Sans|${key}`,bytes);PdfEngine.fallbackFonts.set(`Noto Sans|${key}`,bytes);
  }));
  const module=await import('../vendor/bentopdf/app.js');
  if(!await module.engineReady)throw new Error('Could not initialize the PDF engine.');
  native=module.careerNative;engine=native.engine;
  native.configure({open:requestOpen,commit:()=>{if(!internal&&!preview)enqueue(()=>flush());}});
  document.getElementById('career-prev').addEventListener('click',()=>enqueue(()=>goPage((preview||livePreview?previewPageIndex:engine.pageIndex)-1)));
  document.getElementById('career-next').addEventListener('click',()=>enqueue(()=>goPage((preview||livePreview?previewPageIndex:engine.pageIndex)+1)));
  for(const type of ['undo','redo'])document.getElementById(`career-${type}`).addEventListener('click',()=>enqueue(()=>history(type)));
  document.getElementById('career-fit').addEventListener('click',()=>enqueue(async()=>{if(!preview)await flush();native.fit();if(preview){const result=await computeReflow({edits:preview.prepared.map(target=>({identity:target.identity,text:target.text}))});preview.result=result;displayLayout(result,'ai',preview.prepared.map(target=>target.text));}paintChrome();}));
  new MutationObserver(()=>decorateParagraphs()).observe(document.getElementById('overlay'),{childList:true});
  let scrollFrame;
  document.getElementById('stage').addEventListener('scroll',()=>{
    cancelAnimationFrame(scrollFrame);scrollFrame=requestAnimationFrame(()=>{
      const layout=preview?.result??livePreview;if(!layout)return;
      const stage=document.getElementById('stage'),threshold=stage.getBoundingClientRect().top+stage.clientHeight*.35;
      const visible=[...document.querySelectorAll('.career-reflow-page')].filter(page=>page.getBoundingClientRect().top<=threshold).at(-1);
      previewPageIndex=Number(visible?.dataset.pageIndex??0);
      document.getElementById('career-page').textContent=`Page ${previewPageIndex+1} of ${layout.pages.length}`;
      document.getElementById('career-prev').disabled=previewPageIndex===0;document.getElementById('career-next').disabled=previewPageIndex===layout.pages.length-1;
    });
  },{passive:true});
  send('ready');
}
initialize().catch(error=>fail(error));
let resizeTimer;
window.addEventListener('resize',()=>{
  clearTimeout(resizeTimer);resizeTimer=setTimeout(()=>{if(loaded)enqueue(async()=>{const pending=draft(),identity=selectedIdentity();native.cancel();native.fit();if(preview){const result=await computeReflow({edits:preview.prepared.map(target=>({identity:target.identity,text:target.text}))});preview.result=result;displayLayout(result,'ai',preview.prepared.map(target=>target.text));}else if(pending&&identity)openIdentity(identity,{notify:false,text:pending.text,inlineState:pending.inlineState});paintChrome();});},150);
});
