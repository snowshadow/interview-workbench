import assert from "node:assert/strict";
import test from "node:test";
import {
  applicationMetadataPatch,
  interviewMetadataPatch,
  mergeStatusOptions,
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

test("normalization keeps application status and round duration independent", () => {
  const store = normalizeStore({
    applications: [{ id: "application-1", name: "候选人" }],
    interviews: [
      { id: "round-1", applicationId: "application-1", durationMinutes: 90 },
      { id: "round-2", applicationId: "application-1" },
    ],
  });

  assert.equal(store.applications[0].applicationStatus, "招聘中");
  assert.equal(store.interviews[0].durationMinutes, 90);
  assert.equal(store.interviews[1].durationMinutes, 60);
  assert.equal(interviewMetadataPatch(store.interviews[0]).durationMinutes, 90);
  assert.deepEqual(
    mergeStatusOptions(["一面通过", "未面"]),
    ["招聘中", "通过", "未通过", "放弃/归档", "一面通过", "未面"],
  );
});

test("status options include every stored and in-use label without excluding historical names", () => {
  const saved = ["一面通过", "已安排", " offer ", "offer", "待发 Offer", "二面未通过"];
  const applications = [{ applicationStatus: "薪资沟通中" }, { applicationStatus: "面试中" }];
  assert.deepEqual(mergeStatusOptions(saved, applications), [
    "招聘中", "通过", "未通过", "放弃/归档", "一面通过", "已安排", "offer", "待发 Offer", "二面未通过", "薪资沟通中", "面试中",
  ]);
  assert.deepEqual(saved, ["一面通过", "已安排", " offer ", "offer", "待发 Offer", "二面未通过"]);
});

test("status options recover application labels missing from the option registry even without rounds", () => {
  const store = normalizeStore({
    statusOptions: ["offer"],
    applications: [{ id: "no-rounds", name: "未建轮次流程", applicationStatus: "二面通过" }],
    interviews: [],
  });
  assert.deepEqual(store.statusOptions, ["招聘中", "通过", "未通过", "放弃/归档", "offer", "二面通过"]);
});

test("role short names survive client normalization and application patches", () => {
  const store = normalizeStore({
    activeInterviewId: "round-1",
    applications: [{
      id: "application-1",
      name: "候选人",
      jdDraftName: "量化策略研究负责人",
      roleShortName: " 量化 ",
    }],
    interviews: [{ id: "round-1", applicationId: "application-1" }],
    jdLibrary: [{
      id: "jd-1",
      name: "量化策略研究负责人",
      shortName: " 量化 ",
      content: "JD",
    }],
  });

  assert.equal(store.applications[0].roleShortName, "量化");
  assert.equal(store.interviews[0].roleShortName, "量化");
  assert.equal(store.jdLibrary[0].shortName, "量化");
  assert.equal(applicationMetadataPatch(store.applications[0]).roleShortName, "量化");
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
