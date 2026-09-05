import assert from "node:assert/strict";
import test from "node:test";
import { annotationPlacement, enqueueApplicationSave, normalizeSelectionRects, orderedNotes, preservePendingAnnotations, upsertNote } from "../src/lib/resume-annotations.js";
import { SqliteStore } from "../server/storage/sqlite-store.js";
import { applicationMetadataChanges } from "../src/lib/store-normalize.js";
import { cleanupTestConfig, createTestConfig, silentLogger } from "./helpers.js";

test("text selection rectangles remain attached through page scaling and merge adjacent text runs", () => {
  const page = { left: 100, right: 700, top: 40, bottom: 840, width: 600, height: 800 };
  const rects = [{ left: 160, right: 250, top: 120, bottom: 136 }, { left: 252, right: 400, top: 120, bottom: 136 },
    { left: 160, right: 280, top: 146, bottom: 162 }];
  const stored = normalizeSelectionRects(rects, page);
  assert.equal(stored.length, 2);
  assert.deepEqual(stored[0], { x: .1, y: .1, width: .4, height: .02 });
  const doubledPage = Object.fromEntries(Object.entries(page).map(([key, value]) => [key, value * 2]));
  const doubledRects = rects.map(rect => Object.fromEntries(Object.entries(rect).map(([key, value]) => [key, value * 2])));
  assert.deepEqual(normalizeSelectionRects(doubledRects, doubledPage), stored);
  assert.deepEqual(normalizeSelectionRects([{ left: 0, right: 20, top: 0, bottom: 10 }], page), []);
});

test("annotation placement stays within the reader and flips above a passage near its bottom", () => {
  const normal = annotationPlacement({ left: 300, right: 400, top: 400, bottom: 420 }, { width: 700, height: 500 }, { width: 288, height: 160 });
  assert.ok(normal.y + 160 < 400);
  assert.equal(normal.visible, true);
  const narrow = annotationPlacement({ left: 270, right: 290, top: 100, bottom: 120 }, { width: 300, height: 400 }, { width: 288, height: 160 });
  assert.equal(narrow.width, 276);
  assert.ok(narrow.x >= 12 && narrow.x + narrow.width <= 288);
  assert.equal(annotationPlacement({ left: 20, right: 40, top: -80, bottom: -60 }, { width: 500, height: 400 }, {}).visible, false);
});

test("editing preserves legacy anchors and other notes; empty input cannot erase a saved annotation", () => {
  const old = [{ id: "legacy", coordinateMode: "content", x: .3, y: .6, text: "原有标注", createdAt: "2026-07-10" },
    { id: "page", coordinateMode: "page", pageNumber: 2, x: .2, y: .1, text: "第二页标注" }];
  const next = upsertNote(old, { id: "legacy", text: "修改后的内容" });
  assert.equal(next.length, 2);
  assert.deepEqual(next[0], { ...old[0], text: "修改后的内容" });
  assert.strictEqual(next[1], old[1]);
  assert.strictEqual(upsertNote(next, { id: "legacy", text: "  " }), next);
  assert.deepEqual(orderedNotes([...next].reverse()).map(note => note.id), ["legacy", "page"]);
});

test("autosave queues prevent older requests from overwriting newer edits and recover after failure", async () => {
  const queues = new Map();
  const order = [];
  let finishFirst;
  const first = enqueueApplicationSave(queues, "app", async () => { order.push("start-first"); await new Promise(resolve => { finishFirst = resolve; }); order.push("finish-first"); });
  const latest = enqueueApplicationSave(queues, "app", async () => { order.push("save-latest"); });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(order, ["start-first"]);
  finishFirst();
  await Promise.all([first, latest]);
  assert.deepEqual(order, ["start-first", "finish-first", "save-latest"]);
  const failed = enqueueApplicationSave(queues, "app", async () => { throw new Error("offline"); });
  const recovered = enqueueApplicationSave(queues, "app", async () => "saved");
  await assert.rejects(failed, /offline/);
  assert.equal(await recovered, "saved");
  assert.equal(queues.size, 0);
});

test("a delayed annotation save cannot revert a newer status or application edit", async () => {
  const config = createTestConfig("annotation-status-race-");
  const store = new SqliteStore(config, silentLogger);
  try {
    store.createApplication({ id: "app", name: "状态并发验证", applicationStatus: "一面通过" });
    const before = store.getApplication("app");
    const notes = [{ id: "note", text: "刚编辑的标注", x: .2, y: .3 }];
    const pending = applicationMetadataChanges(before, { ...before, resumeNotes: notes });
    store.patchApplication("app", { applicationStatus: "二面通过", roleShortName: "评测" });
    await enqueueApplicationSave(new Map(), "app", async () => store.patchApplication("app", pending));
    const saved = store.getApplication("app");
    assert.equal(saved.applicationStatus, "二面通过");
    assert.equal(saved.roleShortName, "评测");
    assert.deepEqual(saved.resumeNotes, notes);
  } finally { store.close(); cleanupTestConfig(config); }
});

test("remote refresh preserves unsaved annotations across rounds without reviving archived applications", () => {
  const notes = [{ id: "note", text: "还未保存的修改" }];
  const local = { applications: [{ id: "app", resumeNotes: notes }, { id: "archived", resumeNotes: notes }] };
  const remote = { applications: [{ id: "app", resumeNotes: [], applicationStatus: "二面通过" }, { id: "other", resumeNotes: [] }],
    interviews: [{ id: "round-1", applicationId: "app", resumeNotes: [] }, { id: "round-2", applicationId: "app", resumeNotes: [] }] };
  const result = preservePendingAnnotations(remote, local, new Set(["app", "archived"]));
  assert.deepEqual(result.applications.map(app => app.id), ["app", "other"]);
  assert.deepEqual(result.applications[0].resumeNotes, notes);
  assert.equal(result.applications[0].applicationStatus, "二面通过");
  assert.deepEqual(result.applications[1].resumeNotes, []);
  assert.ok(result.interviews.every(round => round.resumeNotes === notes));
  assert.deepEqual(remote.applications[0].resumeNotes, []);
  assert.strictEqual(preservePendingAnnotations(remote, local, new Set()), remote);
});

test("PDF quote and rectangle annotations survive application persistence, multiple rounds and export", () => {
  const config = createTestConfig("annotation-roundtrip-");
  const store = new SqliteStore(config, silentLogger);
  try {
    const application = store.createApplication({ id: "annotation-app", name: "标注测试" });
    store.createInterviewRound(application.id, { id: "annotation-round-1" });
    store.createInterviewRound(application.id, { id: "annotation-round-2" });
    const notes = [{ id: "note-1", text: "你本人负责的部分是什么？", quote: "Built evaluation pipelines",
      coordinateMode: "page", pageNumber: 2, x: .6, y: .25, rects: [{ x: .1, y: .24, width: .5, height: .02 }] }];
    store.patchApplication(application.id, { resumeNotes: notes });
    assert.deepEqual(store.getApplication(application.id).resumeNotes, notes);
    assert.deepEqual(store.getInterview("annotation-round-1").resumeNotes, notes);
    assert.deepEqual(store.getInterview("annotation-round-2").resumeNotes, notes);
    assert.deepEqual(store.exportStore().applications.find(item => item.id === application.id).resumeNotes, notes);
  } finally { store.close(); cleanupTestConfig(config); }
});
