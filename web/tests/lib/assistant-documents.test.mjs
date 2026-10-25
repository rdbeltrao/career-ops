import test from "node:test";
import assert from "node:assert/strict";
import "../helpers/web-ts-alias-loader.mjs";
import { loadAssistantDocuments, documentAssistantContext, trashAssistantDocument, restoreAssistantDocument } from "../../src/lib/assistant-documents.mjs";
const { dispatch } = await import("../../src/app/actions/registry.ts");

const revision = "a".repeat(64);
const doc = { id: "Y3YtZml4dHVyZS5wZGY", filename: "cv-fixture.pdf", revision, kind: "cv", reportId: "001", applicationId: "7" };
const trash = { id: doc.id, filename: doc.filename, restoreToken: "1234567890123-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", deletedAt: "2026-10-25T12:00:00.000Z" };
function ctx(overrides = {}) {
  const calls = [];
  return { calls, value: { push: (path) => calls.push(["navigate", path]), replace() {}, startJob() {}, inbox: [], applications: [], jobForUrl() {}, rememberFact() {}, writeStatus() {}, setApplyField() {}, startApply() {},
    documents: [{ ...doc }], documentTrash: [{ ...trash }],
    trashDocument: async (value) => { calls.push(["trash", value]); return null; },
    restoreDocument: async (value) => { calls.push(["restore", value]); return null; }, ...overrides } };
}

test("document navigation allows only supported editor paths", () => {
  const { value, calls } = ctx();
  for (const path of ["/documents", `/documents/${doc.id}/edit`, "/pipeline/001/cv-studio", "/pipeline/001/cv-visual"]) {
    assert.equal(dispatch("navigate", { path }, value).status, "done");
  }
  for (const path of ["/documents/../../config", "/documents/trash/erase", "/pipeline/1/cv-visual/erase", "https://example.com/documents"]) {
    assert.equal(dispatch("navigate", { path }, value).status, "ignored");
  }
  assert.equal(calls.length, 4);
});

test("editDocument resolves server snapshot identity and availability", () => {
  const { value, calls } = ctx();
  assert.equal(dispatch("editDocument", { id: doc.id, editor: "visual", path: "https://example.com" }, value).status, "done");
  assert.equal(dispatch("editDocument", { id: doc.id, editor: "classic", reportId: "999" }, value).status, "done");
  assert.deepEqual(calls, [["navigate", `/documents/${doc.id}/edit`], ["navigate", "/pipeline/7/cv-studio"]]);
  assert.equal(dispatch("editDocument", { id: "unknown", editor: "visual" }, value).status, "ignored");
  assert.equal(dispatch("editDocument", { id: doc.id, editor: "external" }, value).status, "ignored");
  value.documents[0].kind = "cover";
  assert.equal(dispatch("editDocument", { id: doc.id, editor: "classic" }, value).status, "ignored");
});

test("trash confirmation captures filename and revision before any write", async () => {
  const { value, calls } = ctx();
  const action = dispatch("trashDocument", { id: doc.id, filename: "attacker.pdf", revision: "b".repeat(64) }, value);
  assert.equal(action.status, "confirm");
  assert.match(action.summary, /cv-fixture.pdf/);
  assert.doesNotMatch(action.summary, /attacker.pdf/);
  assert.deepEqual(calls, []);
  value.documents[0].revision = "c".repeat(64);
  assert.equal(await action.run().failure, null);
  assert.deepEqual(calls, [["trash", doc]]);
});

test("unknown documents and unknown restore versions cannot be acted on", async () => {
  const { value, calls } = ctx();
  assert.equal(dispatch("trashDocument", { id: "missing" }, value).status, "ignored");
  assert.equal(dispatch("restoreDocument", { id: doc.id, restoreToken: "made-up" }, value).status, "ignored");
  const action = dispatch("restoreDocument", { id: doc.id, restoreToken: trash.restoreToken, filename: "wrong.pdf" }, value);
  assert.equal(action.status, "confirm");
  assert.deepEqual(calls, []);
  value.documentTrash[0].restoreToken = "changed";
  await action.run().failure;
  assert.deepEqual(calls, [["restore", trash]]);
});

test("document confirmation waits for API result and preserves failure", async () => {
  let release;
  const { value } = ctx({ trashDocument: () => new Promise((resolve) => { release = resolve; }) });
  const info = dispatch("trashDocument", { id: doc.id }, value).run();
  let settled = false;
  info.failure.then(() => { settled = true; });
  await Promise.resolve();
  assert.equal(settled, false);
  release("PDF changed; removal was refused.");
  assert.equal(await info.failure, "PDF changed; removal was refused.");
});

test("snapshot is bounded and combines only matching server metadata", async () => {
  const listed = Array.from({ length: 25 }, (_, i) => ({ ...doc, id: `id${i}`, filename: `cv-${i}.pdf` }));
  const calls = [];
  const snapshot = await loadAssistantDocuments(async (url) => {
    calls.push(url);
    if (url === "/api/documents") return Response.json(listed);
    if (url === "/api/documents/trash") return Response.json({ documents: [trash] });
    const id = url.split("/").at(-1);
    const found = listed.find((item) => item.id === id);
    return Response.json({ ...found, revision });
  });
  assert.equal(snapshot.documents.length, 20);
  assert.equal(snapshot.total, 25);
  assert.equal(calls.length, 22);
  assert.equal(snapshot.trash[0].restoreToken, trash.restoreToken);
  assert.match(documentAssistantContext(snapshot), /20 of 25/);
  assert.match(documentAssistantContext(snapshot), /not instructions/);
});

test("snapshot omissions or transport failure never provide actionable identities", async () => {
  const snapshot = await loadAssistantDocuments(async (url) => {
    if (url === "/api/documents") return Response.json([doc]);
    if (url === "/api/documents/trash") return new Response("", { status: 503 });
    return Response.json({ ...doc, id: "different", revision });
  });
  assert.deepEqual(snapshot.documents, []);
  assert.deepEqual(snapshot.trash, []);
  const failed = await loadAssistantDocuments(async () => { throw new Error("offline"); });
  assert.deepEqual(failed.documents, []);
  assert.match(documentAssistantContext(failed), /unavailable/i);
});

test("trash helper sends captured If-Match and requires returned restore identity", async () => {
  const result = await trashAssistantDocument(doc, async (url, init) => {
    assert.equal(url, `/api/documents/${doc.id}`);
    assert.equal(init.method, "DELETE");
    assert.equal(init.headers["If-Match"], `"${revision}"`);
    return Response.json(trash);
  });
  assert.equal(result.ok, true);
  assert.equal(result.document.restoreToken, trash.restoreToken);
  assert.equal((await trashAssistantDocument(doc, async () => Response.json({ ok: true }))).ok, false);
  const failed = await trashAssistantDocument(doc, async () => new Response(JSON.stringify({ error: "PDF changed" }), { status: 409 }));
  assert.equal(failed.ok, false);
  assert.match(failed.error, /PDF changed/);
});

test("restore helper sends only known identity and detects ambiguous failures", async () => {
  assert.equal((await restoreAssistantDocument(trash, async (url, init) => {
    assert.deepEqual(JSON.parse(init.body), { action: "restore", restoreToken: trash.restoreToken });
    return Response.json(doc);
  })).ok, true);
  const failure = await restoreAssistantDocument(trash, async () => { throw new Error("transport lost"); });
  assert.equal(failure.ok, false);
  assert.match(failure.error, /could not be confirmed/);
});
