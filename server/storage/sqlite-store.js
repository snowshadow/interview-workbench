import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const DEFAULT_STATUSES = [
  "未面",
  "已安排",
  "面试中",
  "已面待定",
  "一面通过",
  "未通过",
  "放弃/归档",
];

export class SqliteStore {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
    fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(config.attachmentDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(config.backupDir, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(config.databaseFile);
    this.db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    this.createSchema();
    this.migrateLegacyStore();
    this.recoverInterruptedJobs();
    trySetPrivateMode(config.databaseFile);
    trySetPrivateMode(config.legacyStoreFile);
  }

  close() {
    this.db.close();
  }

  createSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS status_options (
        value TEXT PRIMARY KEY,
        sort_order INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS jd_library (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS attachments (
        id TEXT PRIMARY KEY,
        interview_id TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        size INTEGER NOT NULL,
        relative_path TEXT NOT NULL,
        preview_text TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS interviews (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        session_started_at TEXT,
        scheduled_at TEXT,
        interview_status TEXT NOT NULL,
        resume_markdown TEXT NOT NULL DEFAULT '',
        role_markdown TEXT NOT NULL DEFAULT '',
        resume_notes_json TEXT NOT NULL DEFAULT '[]',
        selected_jd_id TEXT NOT NULL DEFAULT '',
        jd_draft_name TEXT NOT NULL DEFAULT '',
        last_processed_line_count INTEGER NOT NULL DEFAULT 0,
        speaker_labels_json TEXT NOT NULL DEFAULT '{}',
        deleted_at TEXT
      );
      CREATE TABLE IF NOT EXISTS transcript_lines (
        id TEXT PRIMARY KEY,
        interview_id TEXT NOT NULL REFERENCES interviews(id) ON DELETE CASCADE,
        position INTEGER NOT NULL,
        run_id TEXT NOT NULL DEFAULT '',
        text TEXT NOT NULL,
        start_time REAL,
        end_time REAL,
        speaker TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS transcript_interview_position
        ON transcript_lines(interview_id, position);
      CREATE TABLE IF NOT EXISTS analysis_cards (
        id TEXT PRIMARY KEY,
        interview_id TEXT NOT NULL REFERENCES interviews(id) ON DELETE CASCADE,
        position INTEGER NOT NULL,
        job_id TEXT,
        created_at TEXT NOT NULL,
        status TEXT NOT NULL,
        markdown TEXT NOT NULL DEFAULT '',
        transcript_slice TEXT NOT NULL DEFAULT '',
        segment_start INTEGER NOT NULL DEFAULT 0,
        segment_end INTEGER NOT NULL DEFAULT 0,
        attempts INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS cards_interview_position
        ON analysis_cards(interview_id, position);
      CREATE TABLE IF NOT EXISTS asked_questions (
        interview_id TEXT NOT NULL REFERENCES interviews(id) ON DELETE CASCADE,
        position INTEGER NOT NULL,
        question TEXT NOT NULL,
        PRIMARY KEY (interview_id, question)
      );
      CREATE TABLE IF NOT EXISTS analysis_jobs (
        id TEXT PRIMARY KEY,
        interview_id TEXT NOT NULL REFERENCES interviews(id) ON DELETE CASCADE,
        card_id TEXT NOT NULL REFERENCES analysis_cards(id) ON DELETE CASCADE,
        idempotency_key TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 3,
        payload_json TEXT NOT NULL,
        result_markdown TEXT,
        detected_questions_json TEXT NOT NULL DEFAULT '[]',
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS jobs_status_created
        ON analysis_jobs(status, created_at);
      CREATE TABLE IF NOT EXISTS interview_artifacts (
        id TEXT PRIMARY KEY,
        interview_id TEXT NOT NULL REFERENCES interviews(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        markdown TEXT NOT NULL,
        source_harness TEXT NOT NULL DEFAULT '',
        source_session_id TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(interview_id, kind)
      );
      CREATE INDEX IF NOT EXISTS artifacts_interview_updated
        ON interview_artifacts(interview_id, updated_at DESC);
      CREATE TABLE IF NOT EXISTS harness_sessions (
        id TEXT PRIMARY KEY,
        interview_id TEXT NOT NULL REFERENCES interviews(id) ON DELETE CASCADE,
        harness TEXT NOT NULL,
        session_id TEXT NOT NULL,
        label TEXT NOT NULL DEFAULT '',
        cwd TEXT NOT NULL DEFAULT '',
        is_primary INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(interview_id, harness, session_id)
      );
      CREATE INDEX IF NOT EXISTS harness_sessions_interview
        ON harness_sessions(interview_id, harness, is_primary DESC);
    `);
    this.setMeta("schema_version", "2");
    DEFAULT_STATUSES.forEach((status, index) => this.addStatus(status, index));
  }

  migrateLegacyStore() {
    if (this.getMeta("legacy_json_migrated") || !fs.existsSync(this.config.legacyStoreFile)) return;
    const raw = fs.readFileSync(this.config.legacyStoreFile, "utf8");
    if (!raw.trim()) {
      this.setMeta("legacy_json_migrated", new Date().toISOString());
      return;
    }
    const legacy = JSON.parse(raw);
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backup = path.join(this.config.backupDir, `interview-store-${timestamp}.json`);
    fs.copyFileSync(this.config.legacyStoreFile, backup);
    trySetPrivateMode(backup);

    this.transaction(() => {
      this.importStore(legacy, { replace: true });
      this.setMeta("legacy_json_migrated", new Date().toISOString());
      this.setMeta("legacy_json_backup", path.relative(this.config.dataDir, backup));
    });
    this.logger.info("store.migrated", {
      interviews: Array.isArray(legacy.interviews) ? legacy.interviews.length : 0,
      backup,
    });
  }

  getStore() {
    const interviews = this.db
      .prepare("SELECT * FROM interviews WHERE deleted_at IS NULL ORDER BY updated_at DESC")
      .all()
      .map((row) => this.hydrateInterview(row));
    const active = this.getMeta("active_interview_id");
    return {
      schemaVersion: 2,
      activeInterviewId: interviews.some((item) => item.id === active)
        ? active
        : interviews[0]?.id || "",
      interviews,
      jdLibrary: this.db
        .prepare("SELECT * FROM jd_library ORDER BY updated_at DESC")
        .all()
        .map(mapJd),
      statusOptions: this.db
        .prepare("SELECT value FROM status_options ORDER BY sort_order, created_at")
        .all()
        .map((row) => row.value),
    };
  }

  importStore(store, { replace = false } = {}) {
    const interviews = Array.isArray(store?.interviews) ? store.interviews : [];
    if (replace) {
      this.db.exec(
        "DELETE FROM analysis_jobs; DELETE FROM analysis_cards; DELETE FROM transcript_lines; DELETE FROM asked_questions; DELETE FROM interview_artifacts; DELETE FROM harness_sessions; DELETE FROM interviews; DELETE FROM jd_library;",
      );
    }
    for (const [index, status] of normalizeStatuses(store?.statusOptions, interviews).entries()) {
      this.addStatus(status, index);
    }
    for (const jd of Array.isArray(store?.jdLibrary) ? store.jdLibrary : []) this.upsertJd(jd);
    for (const interview of interviews) this.upsertInterviewSnapshot(interview);
    if (store?.activeInterviewId) this.setMeta("active_interview_id", store.activeInterviewId);
    return this.getStore();
  }

  createInterview(payload) {
    const now = new Date().toISOString();
    const interview = {
      id: cleanId(payload.id) || crypto.randomUUID(),
      name: cleanText(payload.name || payload.candidateName, 160) || "未命名面试",
      createdAt: now,
      updatedAt: now,
      sessionStartedAt: normalizeDate(payload.sessionStartedAt),
      scheduledAt: normalizeDate(payload.scheduledAt || payload.interviewTime),
      interviewStatus: cleanText(payload.interviewStatus || payload.status, 24) || "未面",
      resumeMarkdown: cleanText(payload.resumeMarkdown || payload.resumeAnalysis, 500000),
      roleMarkdown: cleanText(payload.roleMarkdown || payload.jdMarkdown, 500000),
      resumeFile: payload.resumeFile || null,
      resumeNotes: Array.isArray(payload.resumeNotes) ? payload.resumeNotes : [],
      selectedJdId: cleanText(payload.selectedJdId, 160),
      jdDraftName: cleanText(payload.jdDraftName || payload.jdName, 300),
      lines: Array.isArray(payload.lines) ? payload.lines : [],
      cards: Array.isArray(payload.cards) ? payload.cards : [],
      askedQuestions: Array.isArray(payload.askedQuestions) ? payload.askedQuestions : [],
      lastProcessedLineCount: Number(payload.lastProcessedLineCount || 0),
      speakerLabels: isObject(payload.speakerLabels) ? payload.speakerLabels : {},
      artifacts: Array.isArray(payload.artifacts) ? payload.artifacts : [],
      harnessSessions: Array.isArray(payload.harnessSessions) ? payload.harnessSessions : [],
    };
    this.transaction(() => {
      this.upsertInterviewSnapshot(interview);
      this.setMeta("active_interview_id", interview.id);
    });
    return this.getInterview(interview.id);
  }

  getInterview(id) {
    const row = this.db
      .prepare("SELECT * FROM interviews WHERE id = ? AND deleted_at IS NULL")
      .get(id);
    return row ? this.hydrateInterview(row) : null;
  }

  getInterviewContext(id) {
    const row = this.db
      .prepare("SELECT * FROM interviews WHERE id = ? AND deleted_at IS NULL")
      .get(id);
    return row ? this.hydrateInterview(row, { includeLines: false }) : null;
  }

  listInterviews({ query = "", status = "", limit = 50 } = {}) {
    const normalizedQuery = cleanText(query, 160).toLowerCase();
    const normalizedStatus = cleanText(status, 24);
    const rows = this.db
      .prepare(`
        SELECT id, name, interview_status, scheduled_at, session_started_at, created_at, updated_at,
          jd_draft_name, selected_jd_id,
          (SELECT COUNT(*) FROM transcript_lines WHERE interview_id = interviews.id) AS transcript_line_count,
          (SELECT COUNT(*) FROM interview_artifacts WHERE interview_id = interviews.id) AS artifact_count
        FROM interviews
        WHERE deleted_at IS NULL
          AND (? = '' OR interview_status = ?)
          AND (? = '' OR LOWER(name) LIKE '%' || ? || '%' OR LOWER(jd_draft_name) LIKE '%' || ? || '%')
        ORDER BY COALESCE(scheduled_at, updated_at) DESC
        LIMIT ?
      `)
      .all(
        normalizedStatus,
        normalizedStatus,
        normalizedQuery,
        normalizedQuery,
        normalizedQuery,
        Math.min(200, Math.max(1, Number(limit) || 50)),
      );
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      interviewStatus: row.interview_status,
      scheduledAt: row.scheduled_at || "",
      sessionStartedAt: row.session_started_at || null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      roleName: row.jd_draft_name,
      selectedJdId: row.selected_jd_id,
      transcriptLineCount: row.transcript_line_count,
      artifactCount: row.artifact_count,
    }));
  }

  getTranscriptChunk(interviewId, { offset = 0, limit = 200 } = {}) {
    if (!this.getInterviewContext(interviewId)) return null;
    const safeOffset = Math.max(0, Number(offset) || 0);
    const safeLimit = Math.min(500, Math.max(1, Number(limit) || 200));
    const total = this.db
      .prepare("SELECT COUNT(*) AS count FROM transcript_lines WHERE interview_id = ?")
      .get(interviewId).count;
    const lines = this.db
      .prepare("SELECT * FROM transcript_lines WHERE interview_id = ? ORDER BY position LIMIT ? OFFSET ?")
      .all(interviewId, safeLimit, safeOffset)
      .map(mapLine);
    return {
      interviewId,
      offset: safeOffset,
      limit: safeLimit,
      total,
      nextOffset: safeOffset + lines.length < total ? safeOffset + lines.length : null,
      lines,
    };
  }

  patchInterview(id, patch) {
    const current = this.getInterview(id);
    if (!current) return null;
    const merged = {
      ...current,
      ...pick(patch, [
        "name",
        "sessionStartedAt",
        "scheduledAt",
        "interviewStatus",
        "resumeMarkdown",
        "roleMarkdown",
        "resumeNotes",
        "selectedJdId",
        "jdDraftName",
        "lastProcessedLineCount",
        "speakerLabels",
        "askedQuestions",
      ]),
      updatedAt: new Date().toISOString(),
    };
    this.transaction(() => {
      this.upsertInterviewRow(merged);
      if (Array.isArray(patch.askedQuestions)) this.replaceQuestions(id, patch.askedQuestions);
      this.addStatus(merged.interviewStatus);
    });
    return this.getInterview(id);
  }

  softDeleteInterview(id) {
    const result = this.db
      .prepare("UPDATE interviews SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL")
      .run(new Date().toISOString(), new Date().toISOString(), id);
    return result.changes > 0;
  }

  appendLines(interviewId, lines) {
    if (!this.getInterview(interviewId)) return null;
    const currentCount = this.db
      .prepare("SELECT COUNT(*) AS count FROM transcript_lines WHERE interview_id = ?")
      .get(interviewId).count;
    const insert = this.db.prepare(`
      INSERT OR IGNORE INTO transcript_lines
        (id, interview_id, position, run_id, text, start_time, end_time, speaker, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    let position = Number(currentCount);
    this.transaction(() => {
      for (const line of lines) {
        const text = cleanText(line.text, 20000);
        if (!text) continue;
        const id = cleanText(line.id, 1000) || lineId(line);
        const result = insert.run(
          id,
          interviewId,
          position,
          cleanText(line.runId, 160),
          text,
          finiteOrNull(line.startTime),
          finiteOrNull(line.endTime),
          cleanText(line.speaker, 80),
          new Date().toISOString(),
        );
        if (result.changes) position += 1;
      }
      this.db.prepare("UPDATE interviews SET updated_at = ? WHERE id = ?").run(
        new Date().toISOString(),
        interviewId,
      );
    });
    return this.getInterview(interviewId);
  }

  saveAttachment(interviewId, file) {
    if (!this.getInterview(interviewId)) return null;
    if (!isObject(file)) throw new Error("Invalid attachment");
    const data = decodeDataUrl(file.dataUrl);
    if (!data.length || data.length > 10 * 1024 * 1024) {
      throw new Error("Resume attachment must be between 1 byte and 10MB");
    }
    const type = cleanText(file.type, 160) || "application/octet-stream";
    const name = cleanText(file.name, 300) || "resume";
    if (!isAllowedResume(name, type)) throw new Error("Only PDF, DOC, and DOCX resumes are supported");
    const existing = this.db.prepare("SELECT * FROM attachments WHERE interview_id = ?").get(interviewId);
    const id = existing?.id || crypto.randomUUID();
    const extension = safeExtension(name, type);
    const relativePath = path.join("attachments", `${id}${extension}`);
    const absolutePath = path.join(this.config.dataDir, relativePath);
    fs.writeFileSync(absolutePath, data, { mode: 0o600 });
    if (existing && existing.relative_path !== relativePath) safeUnlink(path.join(this.config.dataDir, existing.relative_path));
    this.db.prepare(`
      INSERT INTO attachments (id, interview_id, name, type, size, relative_path, preview_text, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(interview_id) DO UPDATE SET
        name=excluded.name, type=excluded.type, size=excluded.size,
        relative_path=excluded.relative_path, preview_text=excluded.preview_text,
        updated_at=excluded.updated_at
    `).run(
      id,
      interviewId,
      name,
      type,
      data.length,
      relativePath,
      cleanText(file.previewText, 500000),
      new Date().toISOString(),
    );
    return this.getAttachmentForInterview(interviewId);
  }

  removeAttachment(interviewId) {
    const existing = this.db.prepare("SELECT * FROM attachments WHERE interview_id = ?").get(interviewId);
    if (!existing) return false;
    this.db.prepare("DELETE FROM attachments WHERE interview_id = ?").run(interviewId);
    safeUnlink(path.join(this.config.dataDir, existing.relative_path));
    return true;
  }

  getAttachment(id) {
    const row = this.db.prepare(`
      SELECT attachments.* FROM attachments
      JOIN interviews ON interviews.id = attachments.interview_id
      WHERE attachments.id = ? AND interviews.deleted_at IS NULL
    `).get(id);
    if (!row) return null;
    return { ...mapAttachment(row), absolutePath: path.join(this.config.dataDir, row.relative_path) };
  }

  getAttachmentForInterview(interviewId) {
    const row = this.db.prepare("SELECT * FROM attachments WHERE interview_id = ?").get(interviewId);
    return row ? mapAttachment(row) : null;
  }

  upsertJd(jd) {
    const now = new Date().toISOString();
    const value = {
      id: cleanId(jd?.id) || crypto.randomUUID(),
      name: cleanText(jd?.name, 300) || "未命名 JD",
      content: cleanText(jd?.content, 500000),
      createdAt: normalizeDate(jd?.createdAt) || now,
      updatedAt: normalizeDate(jd?.updatedAt) || now,
    };
    this.db.prepare(`
      INSERT INTO jd_library (id, name, content, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name, content=excluded.content, updated_at=excluded.updated_at
    `).run(value.id, value.name, value.content, value.createdAt, value.updatedAt);
    return value;
  }

  addStatus(status, sortOrder = null) {
    const value = cleanText(status, 24);
    if (!value) return;
    const order = sortOrder ?? this.db.prepare("SELECT COUNT(*) AS count FROM status_options").get().count;
    this.db.prepare("INSERT OR IGNORE INTO status_options (value, sort_order, created_at) VALUES (?, ?, ?)")
      .run(value, order, new Date().toISOString());
  }

  upsertArtifact(interviewId, artifact) {
    if (!this.getInterviewContext(interviewId)) return null;
    const now = new Date().toISOString();
    const kind = cleanSlug(artifact?.kind, 80);
    const markdown = cleanText(artifact?.markdown, 1000000);
    if (!kind) throw new Error("Artifact kind is required");
    if (!markdown) throw new Error("Artifact markdown is required");
    const existing = this.db
      .prepare("SELECT * FROM interview_artifacts WHERE interview_id = ? AND kind = ?")
      .get(interviewId, kind);
    const value = {
      id: existing?.id || cleanId(artifact?.id) || crypto.randomUUID(),
      interviewId,
      kind,
      title: cleanText(artifact?.title, 200) || artifactTitle(kind),
      markdown,
      sourceHarness: cleanSlug(artifact?.sourceHarness, 40),
      sourceSessionId: cleanText(artifact?.sourceSessionId, 200),
      createdAt: existing?.created_at || normalizeDate(artifact?.createdAt) || now,
      updatedAt: now,
    };
    this.db.prepare(`
      INSERT INTO interview_artifacts
        (id, interview_id, kind, title, markdown, source_harness, source_session_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(interview_id, kind) DO UPDATE SET
        title=excluded.title, markdown=excluded.markdown,
        source_harness=excluded.source_harness, source_session_id=excluded.source_session_id,
        updated_at=excluded.updated_at
    `).run(
      value.id,
      value.interviewId,
      value.kind,
      value.title,
      value.markdown,
      value.sourceHarness,
      value.sourceSessionId,
      value.createdAt,
      value.updatedAt,
    );
    this.db.prepare("UPDATE interviews SET updated_at = ? WHERE id = ?").run(now, interviewId);
    return this.listArtifacts(interviewId).find((item) => item.kind === kind);
  }

  listArtifacts(interviewId) {
    return this.db
      .prepare("SELECT * FROM interview_artifacts WHERE interview_id = ? ORDER BY updated_at DESC")
      .all(interviewId)
      .map(mapArtifact);
  }

  linkHarnessSession(interviewId, session) {
    if (!this.getInterviewContext(interviewId)) return null;
    const now = new Date().toISOString();
    const harness = cleanSlug(session?.harness, 40);
    const sessionId = cleanText(session?.sessionId, 200);
    if (!harness || !sessionId) throw new Error("Harness and sessionId are required");
    const makePrimary = session?.isPrimary !== false;
    const existing = this.db.prepare(
      "SELECT * FROM harness_sessions WHERE interview_id = ? AND harness = ? AND session_id = ?",
    ).get(interviewId, harness, sessionId);
    const value = {
      id: existing?.id || cleanId(session?.id) || crypto.randomUUID(),
      interviewId,
      harness,
      sessionId,
      label: cleanText(session?.label, 160),
      cwd: cleanText(session?.cwd, 1000),
      isPrimary: makePrimary,
      createdAt: existing?.created_at || normalizeDate(session?.createdAt) || now,
      updatedAt: now,
    };
    this.transaction(() => {
      if (makePrimary) {
        this.db.prepare(
          "UPDATE harness_sessions SET is_primary = 0, updated_at = ? WHERE interview_id = ? AND harness = ?",
        ).run(now, interviewId, harness);
      }
      this.db.prepare(`
        INSERT INTO harness_sessions
          (id, interview_id, harness, session_id, label, cwd, is_primary, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(interview_id, harness, session_id) DO UPDATE SET
          label=excluded.label, cwd=excluded.cwd, is_primary=excluded.is_primary,
          updated_at=excluded.updated_at
      `).run(
        value.id,
        value.interviewId,
        value.harness,
        value.sessionId,
        value.label,
        value.cwd,
        value.isPrimary ? 1 : 0,
        value.createdAt,
        value.updatedAt,
      );
    });
    return this.listHarnessSessions(interviewId).find(
      (item) => item.harness === harness && item.sessionId === sessionId,
    );
  }

  listHarnessSessions(interviewId) {
    return this.db
      .prepare("SELECT * FROM harness_sessions WHERE interview_id = ? ORDER BY is_primary DESC, updated_at DESC")
      .all(interviewId)
      .map(mapHarnessSession);
  }

  createAnalysisJob({ interviewId, card, payload, idempotencyKey, maxAttempts = 3 }) {
    const existing = this.db
      .prepare("SELECT * FROM analysis_jobs WHERE idempotency_key = ?")
      .get(idempotencyKey);
    if (existing) return mapJob(existing);
    const now = new Date().toISOString();
    const jobId = crypto.randomUUID();
    this.transaction(() => {
      this.db.prepare(`
        INSERT INTO analysis_cards
          (id, interview_id, position, job_id, created_at, status, markdown,
           transcript_slice, segment_start, segment_end, attempts)
        VALUES (?, ?, 0, ?, ?, 'queued', ?, ?, ?, ?, 0)
      `).run(
        card.id,
        interviewId,
        jobId,
        card.createdAt || now,
        "等待分析...",
        cleanText(card.transcriptSlice, 500000),
        Number(card.segmentStart || 0),
        Number(card.segmentEnd || 0),
      );
      this.db.prepare("UPDATE analysis_cards SET position = position + 1 WHERE interview_id = ? AND id <> ?")
        .run(interviewId, card.id);
      this.db.prepare(`
        INSERT INTO analysis_jobs
          (id, interview_id, card_id, idempotency_key, status, attempts, max_attempts,
           payload_json, detected_questions_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'queued', 0, ?, ?, '[]', ?, ?)
      `).run(jobId, interviewId, card.id, idempotencyKey, maxAttempts, JSON.stringify(payload), now, now);
    });
    return this.getJob(jobId);
  }

  getJob(id) {
    const row = this.db.prepare("SELECT * FROM analysis_jobs WHERE id = ?").get(id);
    return row ? mapJob(row) : null;
  }

  listRunnableJobs(limit = 10) {
    return this.db
      .prepare("SELECT * FROM analysis_jobs WHERE status IN ('queued','retrying') ORDER BY created_at LIMIT ?")
      .all(limit)
      .map(mapJob);
  }

  updateJob(id, patch) {
    const current = this.getJob(id);
    if (!current) return null;
    const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
    this.transaction(() => {
      this.db.prepare(`
        UPDATE analysis_jobs SET status=?, attempts=?, result_markdown=?,
          detected_questions_json=?, error=?, updated_at=? WHERE id=?
      `).run(
        next.status,
        Number(next.attempts || 0),
        next.markdown || null,
        JSON.stringify(next.detectedQuestions || []),
        next.error || null,
        next.updatedAt,
        id,
      );
      this.db.prepare("UPDATE analysis_cards SET status=?, markdown=?, attempts=? WHERE job_id=?")
        .run(
          next.status === "done" ? "done" : next.status === "error" ? "error" : next.status,
          next.status === "done" ? next.markdown || "" : next.error || jobPlaceholder(next),
          Number(next.attempts || 0),
          id,
        );
      if (next.status === "done") {
        const card = this.db.prepare("SELECT * FROM analysis_cards WHERE job_id = ?").get(id);
        this.db.prepare(`
          UPDATE interviews SET last_processed_line_count = MAX(last_processed_line_count, ?), updated_at = ?
          WHERE id = ?
        `).run(card?.segment_end || 0, next.updatedAt, next.interviewId);
      }
    });
    return this.getJob(id);
  }

  retryJob(id) {
    const current = this.getJob(id);
    if (!current || !["error", "cancelled"].includes(current.status)) return null;
    return this.updateJob(id, { status: "queued", attempts: 0, error: "" });
  }

  recoverInterruptedJobs() {
    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE analysis_jobs SET status='retrying', error='Recovered after restart', updated_at=?
      WHERE status IN ('running','retrying')
    `).run(now);
    this.db.prepare(`
      UPDATE analysis_cards SET status='retrying', markdown='服务重启，正在恢复分析任务...'
      WHERE job_id IN (SELECT id FROM analysis_jobs WHERE status='retrying')
    `).run();
  }

  backup() {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const target = path.join(this.config.backupDir, `workbench-${timestamp}.sqlite`);
    this.db.exec("PRAGMA wal_checkpoint(FULL)");
    fs.copyFileSync(this.config.databaseFile, target);
    trySetPrivateMode(target);
    return target;
  }

  exportStore() {
    const store = this.getStore();
    return {
      ...store,
      exportedAt: new Date().toISOString(),
      interviews: store.interviews.map((interview) => {
        if (!interview.resumeFile) return interview;
        const attachment = this.getAttachment(interview.resumeFile.id);
        if (!attachment || !fs.existsSync(attachment.absolutePath)) return interview;
        const data = fs.readFileSync(attachment.absolutePath).toString("base64");
        return {
          ...interview,
          resumeFile: {
            ...interview.resumeFile,
            dataUrl: `data:${interview.resumeFile.type};base64,${data}`,
          },
        };
      }),
    };
  }

  importBackup(store) {
    if (!isObject(store) || !Array.isArray(store.interviews)) {
      throw new Error("备份文件格式无效");
    }
    this.backup();
    return this.transaction(() => this.importStore(store, { replace: true }));
  }

  transaction(callback) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = callback();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  hydrateInterview(row, { includeLines = true } = {}) {
    const lines = includeLines
      ? this.db
        .prepare("SELECT * FROM transcript_lines WHERE interview_id = ? ORDER BY position")
        .all(row.id)
        .map(mapLine)
      : undefined;
    const cards = this.db
      .prepare("SELECT * FROM analysis_cards WHERE interview_id = ? ORDER BY position")
      .all(row.id)
      .map(mapCard);
    const askedQuestions = this.db
      .prepare("SELECT question FROM asked_questions WHERE interview_id = ? ORDER BY position")
      .all(row.id)
      .map((item) => item.question);
    return {
      id: row.id,
      name: row.name,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      sessionStartedAt: row.session_started_at || null,
      scheduledAt: row.scheduled_at || "",
      interviewStatus: row.interview_status,
      resumeMarkdown: row.resume_markdown,
      roleMarkdown: row.role_markdown,
      resumeFile: this.getAttachmentForInterview(row.id),
      resumeNotes: parseJson(row.resume_notes_json, []),
      selectedJdId: row.selected_jd_id,
      jdDraftName: row.jd_draft_name,
      ...(includeLines ? { lines } : {}),
      cards,
      askedQuestions,
      lastProcessedLineCount: row.last_processed_line_count,
      speakerLabels: parseJson(row.speaker_labels_json, {}),
      artifacts: this.listArtifacts(row.id),
      harnessSessions: this.listHarnessSessions(row.id),
    };
  }

  upsertInterviewSnapshot(interview) {
    const normalized = normalizeInterview(interview);
    this.upsertInterviewRow(normalized);
    this.addStatus(normalized.interviewStatus);
    if (interview.resumeFile?.dataUrl) this.saveAttachment(normalized.id, interview.resumeFile);
    this.replaceLines(normalized.id, normalized.lines);
    this.replaceCards(normalized.id, normalized.cards);
    this.replaceQuestions(normalized.id, normalized.askedQuestions);
    this.replaceArtifacts(normalized.id, normalized.artifacts);
    this.replaceHarnessSessions(normalized.id, normalized.harnessSessions);
  }

  upsertInterviewRow(interview) {
    const value = normalizeInterview(interview);
    this.db.prepare(`
      INSERT INTO interviews
        (id, name, created_at, updated_at, session_started_at, scheduled_at,
         interview_status, resume_markdown, role_markdown, resume_notes_json,
         selected_jd_id, jd_draft_name, last_processed_line_count, speaker_labels_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name=excluded.name, updated_at=excluded.updated_at,
        session_started_at=excluded.session_started_at, scheduled_at=excluded.scheduled_at,
        interview_status=excluded.interview_status, resume_markdown=excluded.resume_markdown,
        role_markdown=excluded.role_markdown, resume_notes_json=excluded.resume_notes_json,
        selected_jd_id=excluded.selected_jd_id, jd_draft_name=excluded.jd_draft_name,
        last_processed_line_count=excluded.last_processed_line_count,
        speaker_labels_json=excluded.speaker_labels_json, deleted_at=NULL
    `).run(
      value.id,
      value.name,
      value.createdAt,
      value.updatedAt,
      value.sessionStartedAt || null,
      value.scheduledAt || null,
      value.interviewStatus,
      value.resumeMarkdown,
      value.roleMarkdown,
      JSON.stringify(value.resumeNotes),
      value.selectedJdId,
      value.jdDraftName,
      value.lastProcessedLineCount,
      JSON.stringify(value.speakerLabels),
    );
  }

  replaceLines(interviewId, lines) {
    this.db.prepare("DELETE FROM transcript_lines WHERE interview_id = ?").run(interviewId);
    const insert = this.db.prepare(`
      INSERT INTO transcript_lines
        (id, interview_id, position, run_id, text, start_time, end_time, speaker, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    lines.forEach((line, position) => insert.run(
      cleanText(line.id, 1000) || lineId(line),
      interviewId,
      position,
      cleanText(line.runId, 160),
      cleanText(line.text, 20000),
      finiteOrNull(line.startTime),
      finiteOrNull(line.endTime),
      cleanText(line.speaker, 80),
      normalizeDate(line.createdAt) || new Date().toISOString(),
    ));
  }

  replaceCards(interviewId, cards) {
    this.db.prepare("DELETE FROM analysis_cards WHERE interview_id = ?").run(interviewId);
    const insert = this.db.prepare(`
      INSERT INTO analysis_cards
        (id, interview_id, position, job_id, created_at, status, markdown,
         transcript_slice, segment_start, segment_end, attempts)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    cards.forEach((card, position) => insert.run(
      cleanText(card.id, 160) || crypto.randomUUID(),
      interviewId,
      position,
      cleanText(card.jobId, 160) || null,
      normalizeDate(card.createdAt) || new Date().toISOString(),
      cleanText(card.status, 40) || "done",
      cleanText(card.markdown, 500000),
      cleanText(card.transcriptSlice, 500000),
      Number(card.segmentStart ?? 0),
      Number(card.segmentEnd ?? card.snapshotLineCount ?? 0),
      Number(card.attempts || 0),
    ));
  }

  replaceQuestions(interviewId, questions) {
    this.db.prepare("DELETE FROM asked_questions WHERE interview_id = ?").run(interviewId);
    const insert = this.db.prepare(
      "INSERT OR IGNORE INTO asked_questions (interview_id, position, question) VALUES (?, ?, ?)",
    );
    questions.forEach((question, position) => {
      const value = cleanText(question, 1000);
      if (value) insert.run(interviewId, position, value);
    });
  }

  replaceArtifacts(interviewId, artifacts) {
    this.db.prepare("DELETE FROM interview_artifacts WHERE interview_id = ?").run(interviewId);
    for (const artifact of artifacts) this.upsertArtifact(interviewId, artifact);
  }

  replaceHarnessSessions(interviewId, sessions) {
    this.db.prepare("DELETE FROM harness_sessions WHERE interview_id = ?").run(interviewId);
    const insert = this.db.prepare(`
      INSERT INTO harness_sessions
        (id, interview_id, harness, session_id, label, cwd, is_primary, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const session of sessions) {
      const harness = cleanSlug(session?.harness, 40);
      const sessionId = cleanText(session?.sessionId, 200);
      if (!harness || !sessionId) continue;
      const now = new Date().toISOString();
      insert.run(
        cleanId(session?.id) || crypto.randomUUID(),
        interviewId,
        harness,
        sessionId,
        cleanText(session?.label, 160),
        cleanText(session?.cwd, 1000),
        session?.isPrimary === false ? 0 : 1,
        normalizeDate(session?.createdAt) || now,
        normalizeDate(session?.updatedAt) || now,
      );
    }
  }

  getMeta(key) {
    return this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key)?.value || "";
  }

  setMeta(key, value) {
    this.db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .run(key, String(value));
  }
}

function normalizeInterview(interview) {
  const now = new Date().toISOString();
  return {
    id: cleanId(interview?.id) || crypto.randomUUID(),
    name: cleanText(interview?.name, 160) || "未命名面试",
    createdAt: normalizeDate(interview?.createdAt) || now,
    updatedAt: normalizeDate(interview?.updatedAt) || now,
    sessionStartedAt: normalizeDate(interview?.sessionStartedAt),
    scheduledAt: normalizeDate(interview?.scheduledAt),
    interviewStatus: cleanText(interview?.interviewStatus, 24) || inferStatus(interview),
    resumeMarkdown: cleanText(interview?.resumeMarkdown, 500000),
    roleMarkdown: cleanText(interview?.roleMarkdown, 500000),
    resumeNotes: Array.isArray(interview?.resumeNotes) ? interview.resumeNotes : [],
    selectedJdId: cleanText(interview?.selectedJdId, 160),
    jdDraftName: cleanText(interview?.jdDraftName, 300),
    lines: Array.isArray(interview?.lines) ? interview.lines : [],
    cards: Array.isArray(interview?.cards) ? interview.cards : [],
    askedQuestions: Array.isArray(interview?.askedQuestions) ? interview.askedQuestions : [],
    lastProcessedLineCount: Math.max(0, Number(interview?.lastProcessedLineCount || 0)),
    speakerLabels: isObject(interview?.speakerLabels) ? interview.speakerLabels : {},
    artifacts: Array.isArray(interview?.artifacts) ? interview.artifacts : [],
    harnessSessions: Array.isArray(interview?.harnessSessions) ? interview.harnessSessions : [],
  };
}

function normalizeStatuses(options, interviews) {
  const result = [];
  const seen = new Set();
  for (const value of [...DEFAULT_STATUSES, ...(Array.isArray(options) ? options : []), ...(Array.isArray(interviews) ? interviews.map((item) => item.interviewStatus) : [])]) {
    const status = cleanText(value, 24);
    if (status && !seen.has(status)) {
      seen.add(status);
      result.push(status);
    }
  }
  return result;
}

function mapLine(row) {
  return {
    id: row.id,
    runId: row.run_id,
    text: row.text,
    startTime: row.start_time,
    endTime: row.end_time,
    speaker: row.speaker,
  };
}

function mapCard(row) {
  return {
    id: row.id,
    jobId: row.job_id || undefined,
    createdAt: row.created_at,
    status: row.status,
    markdown: row.markdown,
    transcriptSlice: row.transcript_slice,
    segmentStart: row.segment_start,
    segmentEnd: row.segment_end,
    snapshotLineCount: row.segment_end,
    attempts: row.attempts,
  };
}

function mapJob(row) {
  return {
    id: row.id,
    interviewId: row.interview_id,
    cardId: row.card_id,
    idempotencyKey: row.idempotency_key,
    status: row.status,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    payload: parseJson(row.payload_json, {}),
    markdown: row.result_markdown || undefined,
    detectedQuestions: parseJson(row.detected_questions_json, []),
    error: row.error || undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapAttachment(row) {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    size: row.size,
    url: `/api/attachments/${encodeURIComponent(row.id)}`,
    previewText: row.preview_text,
    updatedAt: row.updated_at,
  };
}

function mapJd(row) {
  return {
    id: row.id,
    name: row.name,
    content: row.content,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapArtifact(row) {
  return {
    id: row.id,
    interviewId: row.interview_id,
    kind: row.kind,
    title: row.title,
    markdown: row.markdown,
    sourceHarness: row.source_harness,
    sourceSessionId: row.source_session_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapHarnessSession(row) {
  return {
    id: row.id,
    interviewId: row.interview_id,
    harness: row.harness,
    sessionId: row.session_id,
    label: row.label,
    cwd: row.cwd,
    isPrimary: Boolean(row.is_primary),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function lineId(line) {
  return [line.runId || "run", line.speaker || "na", line.startTime ?? "x", line.endTime ?? "x", line.text || ""].join(":");
}

function decodeDataUrl(value) {
  const match = String(value || "").match(/^data:[^;,]+;base64,(.+)$/s);
  return match ? Buffer.from(match[1], "base64") : Buffer.alloc(0);
}

function isAllowedResume(name, type) {
  return /\.(pdf|doc|docx)$/i.test(name) || [
    "application/pdf",
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ].includes(type);
}

function safeExtension(name, type) {
  const extension = path.extname(name).toLowerCase();
  if ([".pdf", ".doc", ".docx"].includes(extension)) return extension;
  if (type === "application/pdf") return ".pdf";
  if (type === "application/msword") return ".doc";
  return ".docx";
}

function cleanText(value, maxLength) {
  if (value == null) return "";
  return String(value).trim().slice(0, maxLength);
}

function cleanId(value) {
  return cleanText(value, 160).replace(/[^a-zA-Z0-9._:-]/g, "");
}

function cleanSlug(value, maxLength) {
  return cleanText(value, maxLength).toLowerCase().replace(/[^a-z0-9._-]/g, "");
}

function artifactTitle(kind) {
  return {
    "resume-screening": "Resume screening",
    "interview-preparation": "Interview preparation",
    "interview-summary": "Interview summary",
  }[kind] || kind;
}

function normalizeDate(value) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

function finiteOrNull(value) {
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

function inferStatus(interview) {
  return interview?.lines?.length || interview?.cards?.length || interview?.sessionStartedAt
    ? "已面待定"
    : "未面";
}

function parseJson(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function pick(object, keys) {
  return Object.fromEntries(keys.filter((key) => key in (object || {})).map((key) => [key, object[key]]));
}

function isObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function safeUnlink(file) {
  try {
    fs.unlinkSync(file);
  } catch {
    // Missing files are already removed.
  }
}

function trySetPrivateMode(file) {
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // Some platforms do not implement POSIX permissions.
  }
}

function jobPlaceholder(job) {
  if (job.status === "retrying") return `网络不稳定，正在重试...（${job.attempts}/${job.maxAttempts}）`;
  if (job.status === "running") return `正在分析...（${job.attempts}/${job.maxAttempts}）`;
  return "等待分析...";
}
