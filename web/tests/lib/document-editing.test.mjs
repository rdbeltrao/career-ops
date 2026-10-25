import test from 'node:test';
import assert from 'node:assert/strict';
import { applicationIdForDocument, editorLinks, isEditorMessage, proposalMatches } from '../../src/lib/document-editing.mjs';

test('a generated CV offers Classic and visual editing without changing the Classic route', () => {
  assert.deepEqual(editorLinks({id:'Y3YucGRm',kind:'cv',reportId:'001',applicationId:'7'}), {
    classic:'/pipeline/7/cv-studio', visual:'/documents/Y3YucGRm/edit',
  });
  assert.equal(editorLinks({id:'a/b',kind:'cover',reportId:'001'}).classic, null);
  assert.equal(editorLinks({id:'a/b',kind:'cover',reportId:'001'}).visual, '/documents/a%2Fb/edit');
  assert.equal(editorLinks({id:'x',kind:'cv',reportId:'../escape'}).classic, null);
  assert.equal(editorLinks({id:'x',kind:'cv',reportId:'1'}).classic, null);
});

test('Documents joins report identity to its owning tracker row without confusing number spaces', () => {
  const rows = [{n:'10',report:'[20](../reports/020-other.md)'},{n:'7',report:'[10](../reports/010-correct.md)'}];
  assert.equal(applicationIdForDocument({reportId:'010'},rows),'7');
  assert.equal(applicationIdForDocument({reportId:'999'},rows),null);
  assert.equal(applicationIdForDocument({reportId:'010'},[...rows,{n:'8',report:rows[1].report}]),null);
});

test('editor messages require exact source, origin, session and known event shape', () => {
  const source = {};
  const context = {source,origin:'http://localhost:3000',session:'session-1'};
  const data = {channel:'career-ops-pdf-editor',session:'session-1',type:'selection',paragraphId:'0:1',pageIndex:0,text:'Original text'};
  const event = {source,origin:context.origin,data};
  assert.equal(isEditorMessage(event,context),true);
  for(const altered of [{source:{}},{origin:'https://example.org'},{data:{...data,session:'other'}},{data:{...data,type:'delete'}},{data:{...data,text:42}},{data:{...data,paragraphId:null}}]) {
    assert.equal(isEditorMessage({...event,...altered},context),false);
  }
  assert.equal(isEditorMessage({...event,data:{...data,type:'exported',bytes:new ArrayBuffer(2)}},context),true);
  assert.equal(isEditorMessage({...event,data:{...data,type:'exported',bytes:'not bytes'}},context),false);
});

test('AI proposal cannot replace another paragraph or a changed version of the selected text', () => {
  const proposal={paragraphId:'0:1',original:'Original',text:'Rewritten'};
  assert.equal(proposalMatches(proposal,{paragraphId:'0:1',text:'Original'}),true);
  assert.equal(proposalMatches(proposal,{paragraphId:'0:2',text:'Original'}),false);
  assert.equal(proposalMatches(proposal,{paragraphId:'0:1',text:'Edited'}),false);
  assert.equal(proposalMatches(proposal,null),false);
});
