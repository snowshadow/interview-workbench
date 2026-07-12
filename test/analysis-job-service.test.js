import assert from "node:assert/strict";
import test from "node:test";
import { AnalysisJobService } from "../server/services/analysis-job-service.js";
import { SqliteStore } from "../server/storage/sqlite-store.js";
import {
  cleanupTestConfig,
  createTestConfig,
  sampleInterview,
  silentLogger,
} from "./helpers.js";

test("a failed analysis does not advance the transcript cursor", async () => {
  const fixture = createFixture({
    async analyzeInterview() {
      const error = new Error("invalid API key");
      error.statusCode = 401;
      throw error;
    },
  });
  try {
    const job = fixture.service.enqueue(jobInput());
    await fixture.service.run(job);
    assert.equal(fixture.store.getJob(job.id).status, "error");
    assert.equal(fixture.store.getInterview("candidate-1").lastProcessedLineCount, 0);
  } finally {
    fixture.close();
  }
});

test("a transient failure retries and advances the cursor only after success", async () => {
  let calls = 0;
  const fixture = createFixture({
    async analyzeInterview() {
      calls += 1;
      if (calls === 1) {
        const error = new Error("network timeout");
        error.statusCode = 503;
        throw error;
      }
      return "## 犀利追问\n- 具体指标是什么？\n\n## 查漏\n- 还没问：失败恢复机制";
    },
  });
  try {
    const job = fixture.service.enqueue(jobInput());
    await fixture.service.run(job);
    const retrying = fixture.store.getJob(job.id);
    assert.equal(retrying.status, "retrying");
    assert.equal(retrying.attempts, 1);
    assert.equal(fixture.store.getInterview("candidate-1").lastProcessedLineCount, 0);

    await fixture.service.run(retrying);
    assert.equal(fixture.store.getJob(job.id).status, "done");
    assert.equal(fixture.store.getInterview("candidate-1").lastProcessedLineCount, 2);
  } finally {
    fixture.close();
  }
});

test("submitting the same segment is idempotent", () => {
  const fixture = createFixture({
    async analyzeInterview() {
      return "unused";
    },
  });
  try {
    const first = fixture.service.enqueue(jobInput());
    const second = fixture.service.enqueue({ ...jobInput(), cardId: "another-card" });
    assert.equal(first.id, second.id);
    assert.equal(fixture.store.getInterview("candidate-1").cards.length, 1);
  } finally {
    fixture.close();
  }
});

test("a client cannot advance the segment beyond persisted transcript lines", () => {
  const fixture = createFixture({ async analyzeInterview() { return "unused"; } });
  try {
    const job = fixture.service.enqueue({ ...jobInput(), segmentStart: -100, segmentEnd: 9999 });
    assert.equal(job.payload.segmentStart, 0);
    assert.equal(job.payload.segmentEnd, 2);
  } finally {
    fixture.close();
  }
});

function createFixture(provider) {
  const config = createTestConfig();
  const store = new SqliteStore(config, silentLogger);
  store.createInterview(sampleInterview());
  const service = new AnalysisJobService({
    store,
    provider,
    logger: silentLogger,
    concurrency: 0,
  });
  return {
    store,
    service,
    close() {
      store.close();
      cleanupTestConfig(config);
    },
  };
}

function jobInput() {
  return {
    interviewId: "candidate-1",
    cardId: "card-1",
    segmentStart: 0,
    segmentEnd: 2,
    transcriptSlice: "面试官：请介绍项目\n候选人：我负责运行时",
    resumeMarkdown: "简历",
    roleMarkdown: "JD",
    askedQuestions: [],
    previousCards: [],
  };
}
