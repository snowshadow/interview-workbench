import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeStore,
  withLocalTranscripts,
} from "../src/lib/store-normalize.js";

test("normalizeStore preserves a genuinely empty workbench", () => {
  const store = normalizeStore({
    activeInterviewId: "",
    applications: [],
    interviews: [],
  });
  assert.equal(store.activeInterviewId, "");
  assert.equal(store.activeApplicationId, "");
  assert.deepEqual(store.applications, []);
  assert.deepEqual(store.interviews, []);
});

test("remote refresh keeps unpersisted local transcript tail", () => {
  const application = { id: "application-1", name: "候选人" };
  const remote = normalizeStore({
    activeInterviewId: "round-1",
    applications: [application],
    interviews: [{
      id: "round-1",
      applicationId: application.id,
      lines: [{ id: "line-1", text: "已落库" }],
    }],
  });
  const local = normalizeStore({
    activeInterviewId: "round-1",
    applications: [application],
    interviews: [{
      id: "round-1",
      applicationId: application.id,
      lines: [
        { id: "line-1", text: "已落库" },
        { id: "line-2", text: "尚未落库" },
      ],
    }],
  });
  const merged = withLocalTranscripts(remote, local);
  assert.deepEqual(merged.interviews[0].lines.map((line) => line.id), ["line-1", "line-2"]);
});
