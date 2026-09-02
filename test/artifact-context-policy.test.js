import assert from "node:assert/strict";
import test from "node:test";
import { SqliteStore } from "../server/storage/sqlite-store.js";
import {
  cleanupTestConfig,
  createTestConfig,
  sampleInterview,
  silentLogger,
} from "./helpers.js";

test("an omitted policy update preserves an explicitly excluded mirrored artifact", () => {
  const config = createTestConfig("interview-artifact-update-policy-");
  const store = new SqliteStore(config, silentLogger);
  try {
    store.createApplication({
      id: "application-1",
      name: "候选人",
      firstRound: { id: "round-1" },
    });
    store.createInterviewRound("application-1", { id: "round-2", roundLabel: "二面" });
    store.upsertArtifact("round-1", {
      kind: "process-brief",
      markdown: "明确排除的流程材料 v1",
      includeInCrossRoundContext: false,
    });

    store.upsertArtifact("round-1", {
      kind: "process-brief",
      markdown: "明确排除的流程材料 v2",
    });

    assert.equal(
      store.listArtifacts("round-1")[0].includeInCrossRoundContext,
      false,
    );
    assert.equal(
      store.listApplicationArtifacts("application-1")[0].includeInCrossRoundContext,
      false,
    );
    assert.doesNotMatch(
      store.getCrossRoundContext("round-2"),
      /明确排除的流程材料/,
    );
  } finally {
    store.close();
    cleanupTestConfig(config);
  }
});

test("an explicitly included mirror appears only once with the Application copy first", () => {
  const config = createTestConfig("interview-artifact-context-dedupe-");
  const store = new SqliteStore(config, silentLogger);
  try {
    store.createApplication({
      id: "application-1",
      name: "候选人",
      firstRound: { id: "round-1", roundLabel: "一面" },
    });
    store.createInterviewRound("application-1", { id: "round-2", roundLabel: "二面" });
    store.upsertArtifact("round-1", {
      kind: "process-brief",
      title: "流程简报",
      markdown: "MIRRORED_CONTEXT_TOKEN",
      includeInCrossRoundContext: true,
      sourceHarness: "codex",
      sourceSessionId: "thread-1",
    });

    const context = store.getCrossRoundContext("round-2");
    assert.equal(context.match(/MIRRORED_CONTEXT_TOKEN/g)?.length, 1);
    assert.match(context, /^## 流程简报\n\nMIRRORED_CONTEXT_TOKEN$/);
    assert.doesNotMatch(context, /一面 · 流程简报/);
    assert.deepEqual(
      store.getApplicationContext("application-1").rounds[0].artifacts,
      [],
    );
  } finally {
    store.close();
    cleanupTestConfig(config);
  }
});

test("legacy round clients keep Application-level context defaults when omitting policy", () => {
  const config = createTestConfig("interview-artifact-legacy-default-");
  const store = new SqliteStore(config, silentLogger);
  try {
    store.createApplication({
      id: "application-1",
      name: "候选人",
      firstRound: { id: "round-1" },
    });
    store.createInterviewRound("application-1", { id: "round-2", roundLabel: "二面" });
    store.upsertArtifact("round-1", {
      kind: "process-brief",
      markdown: "旧客户端流程简报",
    });

    assert.equal(store.listArtifacts("round-1")[0].includeInCrossRoundContext, false);
    assert.equal(
      store.listApplicationArtifacts("application-1")[0].includeInCrossRoundContext,
      true,
    );
    assert.match(store.getCrossRoundContext("round-2"), /旧客户端流程简报/);
  } finally {
    store.close();
    cleanupTestConfig(config);
  }
});

test("an independently updated Application mirror supersedes its stale Round copy", () => {
  const config = createTestConfig("interview-artifact-application-authority-");
  const store = new SqliteStore(config, silentLogger);
  try {
    store.createApplication({
      id: "application-1",
      name: "候选人",
      firstRound: { id: "round-1" },
    });
    store.createInterviewRound("application-1", { id: "round-2", roundLabel: "二面" });
    store.upsertArtifact("round-1", {
      kind: "process-brief",
      markdown: "STALE_ROUND_COPY",
      includeInCrossRoundContext: true,
    });
    store.upsertApplicationArtifact("application-1", {
      kind: "process-brief",
      markdown: "CURRENT_APPLICATION_COPY",
      includeInCrossRoundContext: true,
    });

    const context = store.getCrossRoundContext("round-2");
    assert.match(context, /CURRENT_APPLICATION_COPY/);
    assert.doesNotMatch(context, /STALE_ROUND_COPY/);
    assert.deepEqual(
      store.getApplicationContext("application-1").rounds[0].artifacts,
      [],
    );
  } finally {
    store.close();
    cleanupTestConfig(config);
  }
});

test("legacy restore promotes the newest cross-round artifact independent of interview order", () => {
  const config = createTestConfig("interview-artifact-restore-order-");
  const store = new SqliteStore(config, silentLogger);
  try {
    store.importBackup({
      schemaVersion: 6,
      applications: [{
        id: "application-1",
        name: "候选人",
        applicationStatus: "招聘中",
      }],
      interviews: [
        sampleInterview({
          id: "round-2",
          applicationId: "application-1",
          roundOrder: 2,
          roundLabel: "二面",
          lines: [],
          artifacts: [{
            kind: "process-brief",
            markdown: "NEWEST_PROCESS_BRIEF",
            createdAt: "2026-02-01T00:00:00.000Z",
            updatedAt: "2026-02-02T00:00:00.000Z",
          }],
        }),
        sampleInterview({
          id: "round-1",
          applicationId: "application-1",
          roundOrder: 1,
          roundLabel: "一面",
          lines: [],
          artifacts: [{
            kind: "process-brief",
            markdown: "STALE_PROCESS_BRIEF",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-02T00:00:00.000Z",
          }],
        }),
      ],
    });

    assert.equal(
      store.listArtifacts("round-2")[0].updatedAt,
      "2026-02-02T00:00:00.000Z",
    );
    const promoted = store.listApplicationArtifacts("application-1")
      .find((artifact) => artifact.kind === "process-brief");
    assert.equal(promoted.markdown, "NEWEST_PROCESS_BRIEF");
  } finally {
    store.close();
    cleanupTestConfig(config);
  }
});
