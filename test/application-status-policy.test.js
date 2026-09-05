import assert from "node:assert/strict";
import test from "node:test";
import { SqliteStore } from "../server/storage/sqlite-store.js";
import {
  cleanupTestConfig,
  createTestConfig,
  sampleInterview,
  silentLogger,
} from "./helpers.js";

test("all existing process labels can be created and reselected without changing round lifecycle", () => {
  const config = createTestConfig("interview-application-status-write-");
  const store = new SqliteStore(config, silentLogger);
  try {
    const statuses = ["未面", "已安排", "通过", "面试中", "已面待定", "一面通过", "未通过", "放弃/归档", "二面未通过", "二面通过", "offer", "招聘中"];
    for (const [index, applicationStatus] of statuses.entries()) {
      const id = `application-${index}`;
      const roundId = `round-${index}`;
      store.createApplication({ id, name: "状态验证", applicationStatus,
        firstRound: { id: roundId, roundStatus: "已结束", outcome: "待补充证据" } });
      assert.equal(store.getApplication(id).applicationStatus, applicationStatus);
      store.patchApplication(id, { applicationStatus: "薪资沟通中" });
      store.patchApplication(id, { applicationStatus });
      assert.equal(store.getApplication(id).applicationStatus, applicationStatus);
      assert.equal(store.getInterview(roundId).interviewStatus, applicationStatus);
      assert.equal(store.getInterview(roundId).roundStatus, "已结束");
      assert.equal(store.getInterview(roundId).outcome, "待补充证据");
      assert.ok(store.listApplications({ status: applicationStatus }).some(application => application.id === id));
    }
    const legacy = store.createInterview({ id: "legacy-round", name: "兼容入口验证", interviewStatus: "已安排", roundStatus: "待安排" });
    store.patchInterview(legacy.id, { interviewStatus: "二面通过" });
    assert.equal(store.getApplication(legacy.applicationId).applicationStatus, "二面通过");
    assert.equal(store.getInterview(legacy.id).roundStatus, "待安排");
    const options = store.getStore().statusOptions;
    for (const status of [...statuses, "薪资沟通中"]) assert.ok(options.includes(status), status);
  } finally {
    store.close();
    cleanupTestConfig(config);
  }
});

test("empty and non-text process labels are still rejected without changing stored data", () => {
  const config = createTestConfig("interview-application-status-validation-");
  const store = new SqliteStore(config, silentLogger);
  try {
    store.createApplication({ id: "application-1", name: "状态验证", applicationStatus: "待发 Offer", firstRound: { id: "round-1" } });
    for (const applicationStatus of [["已安排"], "   ", null, 42, false, {}]) {
      assert.throws(() => store.createApplication({ id: "invalid", name: "无效状态验证", applicationStatus }),
        error => error.code === "INVALID_APPLICATION_STATUS");
      assert.throws(() => store.patchApplication("application-1", { applicationStatus }),
        error => error.code === "INVALID_APPLICATION_STATUS");
      assert.throws(() => store.patchInterview("round-1", { interviewStatus: applicationStatus }),
        error => error.code === "INVALID_APPLICATION_STATUS");
    }
    assert.equal(store.getApplication("invalid"), null);
    assert.equal(store.getApplication("application-1").applicationStatus, "待发 Offer");
  } finally {
    store.close();
    cleanupTestConfig(config);
  }
});

test("imported process labels remain selectable and writable after export and restart", () => {
  const config = createTestConfig("interview-application-status-import-");
  let store = new SqliteStore(config, silentLogger);
  try {
    store.importBackup({
      schemaVersion: 6,
      statusOptions: ["一面通过"],
      applications: [{
        id: "legacy-application",
        name: "历史候选人",
        applicationStatus: "一面通过",
      }],
      interviews: [sampleInterview({
        id: "legacy-round",
        applicationId: "legacy-application",
        interviewStatus: "一面通过",
      })],
    });

    assert.equal(store.getApplication("legacy-application").applicationStatus, "一面通过");
    assert.equal(
      store.listApplications({ status: "一面通过" })[0]?.id,
      "legacy-application",
    );
    store.patchApplication("legacy-application", {
      applicationStatus: "一面通过",
      roleShortName: "评测",
      resumeNotes: [{ id: "note-1", text: "历史流程仍可保存备注" }],
    });
    assert.equal(store.getApplication("legacy-application").applicationStatus, "一面通过");
    assert.equal(store.getApplication("legacy-application").resumeNotes[0].id, "note-1");
    store.patchApplication("legacy-application", { applicationStatus: "二面未通过" });
    const exported = store.exportStore();
    assert.ok(exported.statusOptions.includes("一面通过"));
    assert.ok(exported.statusOptions.includes("二面未通过"));
    store.importBackup(exported);
    store.close();
    store = new SqliteStore(config, silentLogger);
    store.createApplication({ id: "next-application", name: "复用已有状态", applicationStatus: "一面通过" });
    store.patchApplication("legacy-application", { applicationStatus: "一面通过" });
    assert.equal(store.listApplications({ status: "一面通过" }).length, 2);
    assert.equal(store.getApplication("legacy-application").resumeNotes[0].id, "note-1");
  } finally {
    store.close();
    cleanupTestConfig(config);
  }
});
