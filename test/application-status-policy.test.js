import assert from "node:assert/strict";
import test from "node:test";
import { SqliteStore } from "../server/storage/sqlite-store.js";
import {
  cleanupTestConfig,
  createTestConfig,
  sampleInterview,
  silentLogger,
} from "./helpers.js";

test("new writes reject retired round-like application statuses but keep custom process statuses", () => {
  const config = createTestConfig("interview-application-status-write-");
  const store = new SqliteStore(config, silentLogger);
  try {
    assert.throws(
      () => store.createApplication({
        id: "rejected-application",
        name: "旧状态候选人",
        applicationStatus: "未面",
        firstRound: { id: "rejected-round" },
      }),
      (error) => error.code === "RETIRED_APPLICATION_STATUS",
    );
    for (const applicationStatus of [["已安排"], "   "]) {
      assert.throws(
        () => store.createApplication({
          name: "无效状态候选人",
          applicationStatus,
        }),
        (error) => error.code === "INVALID_APPLICATION_STATUS",
      );
    }
    assert.equal(store.getApplication("rejected-application"), null);
    assert.equal(store.getInterview("rejected-round"), null);
    assert.throws(
      () => store.createApplication({
        id: "rejected-alias-application",
        name: "旧别名候选人",
        applicationStatus: "",
        interviewStatus: "已安排",
        firstRound: { id: "rejected-alias-round" },
      }),
      (error) => error.code === "RETIRED_APPLICATION_STATUS",
    );

    store.createApplication({
      id: "application-1",
      name: "候选人",
      applicationStatus: "待发 Offer",
      firstRound: { id: "round-1" },
    });
    store.patchApplication("application-1", { name: "候选人（更新）" });
    assert.equal(store.getApplication("application-1").applicationStatus, "待发 Offer");

    assert.throws(
      () => store.patchApplication("application-1", { applicationStatus: "一面通过" }),
      (error) => error.code === "RETIRED_APPLICATION_STATUS",
    );
    assert.throws(
      () => store.patchInterview("round-1", { interviewStatus: "已安排" }),
      (error) => error.code === "RETIRED_APPLICATION_STATUS",
    );
    assert.throws(
      () => store.patchApplication("application-1", { applicationStatus: "   " }),
      (error) => error.code === "INVALID_APPLICATION_STATUS",
    );
    assert.equal(store.getApplication("application-1").applicationStatus, "待发 Offer");
  } finally {
    store.close();
    cleanupTestConfig(config);
  }
});

test("legacy imports keep retired statuses readable and filterable without reopening writes", () => {
  const config = createTestConfig("interview-application-status-import-");
  const store = new SqliteStore(config, silentLogger);
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
    assert.throws(
      () => store.patchApplication("legacy-application", { applicationStatus: "二面未通过" }),
      (error) => error.code === "RETIRED_APPLICATION_STATUS",
    );
  } finally {
    store.close();
    cleanupTestConfig(config);
  }
});
