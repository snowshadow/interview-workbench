import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  APPLICATION_STATUS_PRESETS,
  DEFAULT_APPLICATION_STATUS,
  DEFAULT_INTERVIEW_DURATION_MINUTES,
  MAX_INTERVIEW_DURATION_MINUTES,
  MIN_INTERVIEW_DURATION_MINUTES,
  ROUND_STATUS_OPTIONS,
  isValidInterviewDurationMinutes,
  normalizeStatusLabel,
  resolveInterviewDurationMinutes,
} from "../../src/interview-domain.js";

const STATUS_COLORS = new Set(["gray", "blue", "green", "amber", "red", "purple"]);
const DEFAULT_STATUS_OPTIONS = APPLICATION_STATUS_PRESETS;
const DEFAULT_STATUSES = DEFAULT_STATUS_OPTIONS.map(({ value }) => value);
const ROUND_STATUSES = new Set(ROUND_STATUS_OPTIONS);
const LEGACY_MIRRORED_APPLICATION_ARTIFACT_KINDS = new Set([
  "resume-screening",
  "process-brief",
  "application-handoff",
  "final-summary",
]);
const LEGACY_APPLICATION_CONTEXT_KINDS = new Set([
  "process-brief",
  "application-handoff",
  "final-summary",
]);
const LEGACY_KNOWN_ARTIFACT_KINDS = new Set([
  "resume-screening",
  "interview-preparation",
  "interview-summary",
  "round-handoff",
  "process-brief",
  "application-handoff",
  "final-summary",
]);
const ARTIFACT_CONTEXT_SCHEMA_VERSION = 7;
const ASSISTANT_JOB_STATUSES = new Set(["queued", "running", "retrying", "done", "error", "cancelled"]);
export const SCHEMA_VERSION = 8;

export class SqliteStore {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
    fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(config.attachmentDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(config.backupDir, { recursive: true, mode: 0o700 });
    trySetPrivateMode(config.dataDir, 0o700);
    trySetPrivateMode(config.attachmentDir, 0o700);
    trySetPrivateMode(config.backupDir, 0o700);
    const databaseExisted = fs.existsSync(config.databaseFile) && fs.statSync(config.databaseFile).size > 0;
    this.db = new DatabaseSync(config.databaseFile);
    this.transactionDepth = 0;
    this.db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    this.backupBeforeSchemaMigration(databaseExisted);
    this.createSchema();
    this.migrateLegacyStore();
    this.recoverInterruptedJobs();
    trySetPrivateMode(config.databaseFile);
    trySetPrivateMode(config.legacyStoreFile);
  }

  close() {
    this.db.close();
  }

  backupBeforeSchemaMigration(databaseExisted) {
    if (!databaseExisted) return;
    const hasMeta = this.db.prepare(`
      SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meta'
    `).get();
    const currentVersion = hasMeta
      ? Number(this.db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()?.value || 0)
      : 0;
    if (currentVersion >= SCHEMA_VERSION) return;
    this.db.exec("PRAGMA wal_checkpoint(FULL)");
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    let target = path.join(
      this.config.backupDir,
      `workbench-pre-v${SCHEMA_VERSION}-${timestamp}.sqlite`,
    );
    if (fs.existsSync(target)) {
      target = path.join(
        this.config.backupDir,
        `workbench-pre-v${SCHEMA_VERSION}-${timestamp}-${crypto.randomUUID().slice(0, 8)}.sqlite`,
      );
    }
    fs.copyFileSync(this.config.databaseFile, target, fs.constants.COPYFILE_EXCL);
    trySetPrivateMode(target);
    this.logger?.info?.("store.pre_schema_backup", {
      target,
      fromSchemaVersion: currentVersion,
      toSchemaVersion: SCHEMA_VERSION,
    });
  }

  createSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS status_options (
        value TEXT PRIMARY KEY,
        color TEXT NOT NULL DEFAULT '',
        sort_order INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS jd_library (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        short_name TEXT NOT NULL DEFAULT '',
        content TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS applications (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        application_status TEXT NOT NULL,
        resume_markdown TEXT NOT NULL DEFAULT '',
        role_markdown TEXT NOT NULL DEFAULT '',
        resume_notes_json TEXT NOT NULL DEFAULT '[]',
        selected_jd_id TEXT NOT NULL DEFAULT '',
        jd_draft_name TEXT NOT NULL DEFAULT '',
        role_short_name TEXT NOT NULL DEFAULT '',
        deleted_at TEXT
      );
      CREATE INDEX IF NOT EXISTS applications_updated
        ON applications(updated_at DESC);
      CREATE TABLE IF NOT EXISTS attachments (
        id TEXT PRIMARY KEY,
        application_id TEXT NOT NULL UNIQUE REFERENCES applications(id) ON DELETE CASCADE,
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
        application_id TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
        round_order INTEGER NOT NULL DEFAULT 1,
        round_label TEXT NOT NULL DEFAULT '',
        round_status TEXT NOT NULL DEFAULT '待安排',
        outcome TEXT NOT NULL DEFAULT '',
        round_focus TEXT NOT NULL DEFAULT '',
        name TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        session_started_at TEXT,
        scheduled_at TEXT,
        duration_minutes INTEGER NOT NULL DEFAULT ${DEFAULT_INTERVIEW_DURATION_MINUTES}
          CHECK(
            typeof(duration_minutes) = 'integer'
            AND duration_minutes BETWEEN ${MIN_INTERVIEW_DURATION_MINUTES}
              AND ${MAX_INTERVIEW_DURATION_MINUTES}
          ),
        interview_status TEXT NOT NULL,
        resume_markdown TEXT NOT NULL DEFAULT '',
        role_markdown TEXT NOT NULL DEFAULT '',
        resume_notes_json TEXT NOT NULL DEFAULT '[]',
        selected_jd_id TEXT NOT NULL DEFAULT '',
        jd_draft_name TEXT NOT NULL DEFAULT '',
        role_short_name TEXT NOT NULL DEFAULT '',
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
      CREATE TABLE IF NOT EXISTS assistant_states (
        interview_id TEXT PRIMARY KEY REFERENCES interviews(id) ON DELETE CASCADE,
        revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),
        processed_line_count INTEGER NOT NULL DEFAULT 0 CHECK(processed_line_count >= 0),
        state_json TEXT NOT NULL,
        updated_at TEXT
      );
      CREATE TABLE IF NOT EXISTS assistant_jobs (
        id TEXT PRIMARY KEY,
        interview_id TEXT NOT NULL REFERENCES interviews(id) ON DELETE CASCADE,
        mode TEXT NOT NULL CHECK(mode IN ('summary', 'followup')),
        idempotency_key TEXT NOT NULL,
        status TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 3,
        payload_json TEXT NOT NULL,
        result_json TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(interview_id, mode, idempotency_key)
      );
      CREATE INDEX IF NOT EXISTS assistant_jobs_status_created
        ON assistant_jobs(status, created_at);
      CREATE INDEX IF NOT EXISTS assistant_jobs_interview_created
        ON assistant_jobs(interview_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS interview_artifacts (
        id TEXT PRIMARY KEY,
        interview_id TEXT NOT NULL REFERENCES interviews(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        markdown TEXT NOT NULL,
        source_harness TEXT NOT NULL DEFAULT '',
        source_session_id TEXT NOT NULL DEFAULT '',
        include_in_cross_round_context INTEGER NOT NULL DEFAULT 0
          CHECK(include_in_cross_round_context IN (0, 1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(interview_id, kind)
      );
      CREATE INDEX IF NOT EXISTS artifacts_interview_updated
        ON interview_artifacts(interview_id, updated_at DESC);
      CREATE TABLE IF NOT EXISTS application_artifacts (
        id TEXT PRIMARY KEY,
        application_id TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        markdown TEXT NOT NULL,
        source_harness TEXT NOT NULL DEFAULT '',
        source_session_id TEXT NOT NULL DEFAULT '',
        include_in_cross_round_context INTEGER NOT NULL DEFAULT 0
          CHECK(include_in_cross_round_context IN (0, 1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(application_id, kind)
      );
      CREATE INDEX IF NOT EXISTS application_artifacts_updated
        ON application_artifacts(application_id, updated_at DESC);
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
      CREATE TABLE IF NOT EXISTS provider_settings (
        id INTEGER PRIMARY KEY CHECK(id = 1),
        settings_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    const statusColumns = this.db.prepare("PRAGMA table_info(status_options)").all();
    if (!statusColumns.some((column) => column.name === "color")) {
      this.db.exec("ALTER TABLE status_options ADD COLUMN color TEXT NOT NULL DEFAULT ''");
    }
    this.migrateApplicationSchema();
    this.setMeta("schema_version", String(SCHEMA_VERSION));
    DEFAULT_STATUS_OPTIONS.forEach(({ value, color }, index) =>
      this.addStatus(value, index, color),
    );
  }

  migrateApplicationSchema() {
    const storedSchemaVersion = Number(this.getMeta("schema_version")) || 0;
    const jdColumns = this.db.prepare("PRAGMA table_info(jd_library)").all();
    if (!jdColumns.some((column) => column.name === "short_name")) {
      this.db.exec("ALTER TABLE jd_library ADD COLUMN short_name TEXT NOT NULL DEFAULT ''");
    }

    const applicationColumns = this.db.prepare("PRAGMA table_info(applications)").all();
    if (!applicationColumns.some((column) => column.name === "role_short_name")) {
      this.db.exec("ALTER TABLE applications ADD COLUMN role_short_name TEXT NOT NULL DEFAULT ''");
    }

    const interviewColumns = this.db.prepare("PRAGMA table_info(interviews)").all();
    const hasInterviewColumn = (name) => interviewColumns.some((column) => column.name === name);
    if (!hasInterviewColumn("application_id")) {
      this.db.exec("ALTER TABLE interviews ADD COLUMN application_id TEXT REFERENCES applications(id) ON DELETE CASCADE");
    }
    if (!hasInterviewColumn("round_order")) {
      this.db.exec("ALTER TABLE interviews ADD COLUMN round_order INTEGER NOT NULL DEFAULT 1");
    }
    if (!hasInterviewColumn("round_label")) {
      this.db.exec("ALTER TABLE interviews ADD COLUMN round_label TEXT NOT NULL DEFAULT ''");
    }
    if (!hasInterviewColumn("round_status")) {
      this.db.exec("ALTER TABLE interviews ADD COLUMN round_status TEXT NOT NULL DEFAULT ''");
    }
    if (!hasInterviewColumn("outcome")) {
      this.db.exec("ALTER TABLE interviews ADD COLUMN outcome TEXT NOT NULL DEFAULT ''");
    }
    if (!hasInterviewColumn("round_focus")) {
      this.db.exec("ALTER TABLE interviews ADD COLUMN round_focus TEXT NOT NULL DEFAULT ''");
    }
    if (!hasInterviewColumn("role_short_name")) {
      this.db.exec("ALTER TABLE interviews ADD COLUMN role_short_name TEXT NOT NULL DEFAULT ''");
    }
    this.transaction(() => {
      if (!hasInterviewColumn("duration_minutes")) {
        this.db.exec(`
          ALTER TABLE interviews ADD COLUMN duration_minutes INTEGER NOT NULL
            DEFAULT ${DEFAULT_INTERVIEW_DURATION_MINUTES}
            CHECK(
              typeof(duration_minutes) = 'integer'
              AND duration_minutes BETWEEN ${MIN_INTERVIEW_DURATION_MINUTES}
                AND ${MAX_INTERVIEW_DURATION_MINUTES}
            )
        `);
      }

      const interviewArtifactColumns = this.db.prepare("PRAGMA table_info(interview_artifacts)").all();
      if (!interviewArtifactColumns.some((column) => column.name === "include_in_cross_round_context")) {
        this.db.exec(`
          ALTER TABLE interview_artifacts
          ADD COLUMN include_in_cross_round_context INTEGER NOT NULL DEFAULT 0
            CHECK(include_in_cross_round_context IN (0, 1))
        `);
      }

      const applicationArtifactColumns = this.db.prepare("PRAGMA table_info(application_artifacts)").all();
      if (!applicationArtifactColumns.some((column) => column.name === "include_in_cross_round_context")) {
        this.db.exec(`
          ALTER TABLE application_artifacts
          ADD COLUMN include_in_cross_round_context INTEGER NOT NULL DEFAULT 0
            CHECK(include_in_cross_round_context IN (0, 1))
        `);
      }

      // This marker makes an interrupted migration retryable. The fail-closed
      // column default prevents private or preparatory artifacts from leaking.
      if (!this.getMeta("artifact_context_policy_v7")) {
        this.db.exec(`
          UPDATE interview_artifacts
          SET include_in_cross_round_context = CASE
            WHEN kind = 'round-handoff' THEN 1
            WHEN kind = 'interview-summary' AND NOT EXISTS (
              SELECT 1 FROM interview_artifacts AS handoff
              WHERE handoff.interview_id = interview_artifacts.interview_id
                AND handoff.kind = 'round-handoff'
            ) THEN 1
            ELSE 0
          END;
          UPDATE application_artifacts
          SET include_in_cross_round_context = CASE
            WHEN kind IN ('process-brief', 'application-handoff', 'final-summary') THEN 1
            ELSE 0
          END;
        `);
        this.setMeta("artifact_context_policy_v7", new Date().toISOString());
      }
    });

    const attachmentColumns = this.db.prepare("PRAGMA table_info(attachments)").all();
    if (!attachmentColumns.some((column) => column.name === "application_id")) {
      this.db.exec("ALTER TABLE attachments ADD COLUMN application_id TEXT REFERENCES applications(id) ON DELETE CASCADE");
    }

    // Migration is deliberately one-to-one: every legacy interview becomes its
    // own application. Candidate names and capture run IDs are never grouping keys.
    this.transaction(() => {
      this.db.exec(`
        INSERT OR IGNORE INTO applications
          (id, name, created_at, updated_at, application_status, resume_markdown,
           role_markdown, resume_notes_json, selected_jd_id, jd_draft_name,
           role_short_name, deleted_at)
        SELECT COALESCE(NULLIF(application_id, ''), id), name, created_at, updated_at,
          interview_status, resume_markdown, role_markdown, resume_notes_json,
          selected_jd_id, jd_draft_name, role_short_name, deleted_at
        FROM interviews
        ORDER BY round_order, created_at
      `);
      this.db.exec(`
        UPDATE interviews
        SET application_id = id
        WHERE application_id IS NULL OR application_id = ''
      `);
      this.db.exec(`
        UPDATE interviews
        SET round_order = CASE WHEN round_order > 0 THEN round_order ELSE 1 END,
            round_label = CASE WHEN round_label <> '' THEN round_label ELSE '一面' END,
            round_status = CASE
              WHEN round_status IN ('待安排','已安排','进行中','已结束','已取消') THEN round_status
              WHEN interview_status = '面试中' THEN '进行中'
              WHEN session_started_at IS NOT NULL
                OR EXISTS (SELECT 1 FROM transcript_lines WHERE transcript_lines.interview_id = interviews.id)
                OR interview_status NOT IN ('未面', '已安排') THEN '已结束'
              WHEN scheduled_at IS NOT NULL THEN '已安排'
              ELSE '待安排'
            END
      `);
      this.db.exec(`
        UPDATE attachments
        SET application_id = (
          SELECT application_id FROM interviews WHERE interviews.id = attachments.interview_id
        )
        WHERE application_id IS NULL OR application_id = ''
      `);
      this.promoteLegacyApplicationArtifacts({
        preserveContextFlag: storedSchemaVersion >= ARTIFACT_CONTEXT_SCHEMA_VERSION,
      });
    });
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS interviews_application_round
        ON interviews(application_id, round_order);
      CREATE UNIQUE INDEX IF NOT EXISTS interviews_application_round_active
        ON interviews(application_id, round_order) WHERE deleted_at IS NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS attachments_application
        ON attachments(application_id);
    `);
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
      try {
        this.importStore(legacy, { replace: true });
      } catch (error) {
        if (error.code !== "INVALID_STORE_FORMAT") throw error;
        this.logger.warn("store.legacy_import_skipped", {
          error: { message: error.message },
        });
      }
      this.setMeta("legacy_json_migrated", new Date().toISOString());
      this.setMeta("legacy_json_backup", path.relative(this.config.dataDir, backup));
    });
    this.logger.info("store.migrated", {
      interviews: Array.isArray(legacy.interviews) ? legacy.interviews.length : 0,
      backup,
    });
  }

  getStore({ includeAllLines = false } = {}) {
    const rows = this.db
      .prepare(`
        SELECT interviews.* FROM interviews
        JOIN applications ON applications.id = interviews.application_id
        WHERE interviews.deleted_at IS NULL AND applications.deleted_at IS NULL
        ORDER BY interviews.updated_at DESC
      `)
      .all();
    const active = this.getMeta("active_interview_id");
    const activeInterviewId = rows.some((row) => row.id === active)
      ? active
      : rows[0]?.id || "";
    // Only the active interview ships its transcript inline; other interviews
    // expose transcriptLineCount and are paged via getTranscriptChunk.
    const interviews = rows.map((row) =>
      this.hydrateInterview(row, {
        includeLines: includeAllLines || row.id === activeInterviewId,
      }),
    );
    const statusRows = this.db
      .prepare("SELECT value, color FROM status_options ORDER BY sort_order, created_at")
      .all();
    return {
      schemaVersion: SCHEMA_VERSION,
      activeInterviewId,
      applications: this.db
        .prepare("SELECT * FROM applications WHERE deleted_at IS NULL ORDER BY updated_at DESC")
        .all()
        .map((row) => this.hydrateApplication(row)),
      interviews,
      jdLibrary: this.db
        .prepare("SELECT * FROM jd_library ORDER BY updated_at DESC")
        .all()
        .map(mapJd),
      statusOptions: statusRows.map((row) => row.value),
      statusColors: Object.fromEntries(
        statusRows
          .map((row) => [row.value, normalizeStatusColor(row.color)])
          .filter(([, color]) => color),
      ),
    };
  }

  importStore(store, { replace = false, allowAssistantStateRollback = false } = {}) {
    if (replace) assertImportableStore(store);
    let interviews = Array.isArray(store?.interviews) ? store.interviews : [];
    const applications = Array.isArray(store?.applications) ? store.applications : [];
    const sourceSchemaVersion = Number(store?.schemaVersion) || 0;
    const allowLegacyArtifactContextFallback = sourceSchemaVersion < ARTIFACT_CONTEXT_SCHEMA_VERSION;
    // Older clients save complete snapshots without knowing about the assistant.
    // Preserve its state and jobs for surviving rounds before replacing rows.
    const preservedAssistantJobs = [];
    if (replace) {
      interviews = interviews.map((interview) => {
        const existing = this.db.prepare("SELECT 1 FROM assistant_states WHERE interview_id = ?")
          .get(cleanId(interview?.id));
        if (!Array.isArray(store?.assistantJobs)) {
          preservedAssistantJobs.push(...this.listAssistantJobs(cleanId(interview?.id)));
        }
        if (!existing) return interview;
        const current = this.getAssistantState(interview.id);
        const incoming = isObject(interview?.assistantState)
          ? normalizeAssistantState(interview.assistantState)
          : null;
        const preserveCurrent = !incoming || (!allowAssistantStateRollback && (
          incoming.revision <= current.revision || incoming.processedLineCount < current.processedLineCount
        ));
        return preserveCurrent ? { ...interview, assistantState: current } : interview;
      });
      this.db.exec(
        "DELETE FROM assistant_jobs; DELETE FROM assistant_states; DELETE FROM analysis_jobs; DELETE FROM analysis_cards; DELETE FROM transcript_lines; DELETE FROM asked_questions; DELETE FROM interview_artifacts; DELETE FROM application_artifacts; DELETE FROM harness_sessions; DELETE FROM attachments; DELETE FROM interviews; DELETE FROM applications; DELETE FROM jd_library;",
      );
    }
    for (const [index, status] of normalizeStatuses(
      store?.statusOptions,
      applications,
      interviews,
    ).entries()) {
      this.addStatus(status, index);
      const color = normalizeStatusColor(store?.statusColors?.[status]);
      if (color) this.setStatusColor(status, color);
    }
    for (const jd of Array.isArray(store?.jdLibrary) ? store.jdLibrary : []) this.upsertJd(jd);
    for (const application of applications) {
      this.upsertApplicationSnapshot(application, { allowLegacyArtifactContextFallback });
    }
    for (const interview of interviews) {
      this.upsertInterviewSnapshot(interview, {
        mirrorApplicationArtifacts: false,
        allowLegacyArtifactContextFallback,
        preserveArtifactTimestamps: true,
        allowAssistantStateRollback,
      });
    }
    this.promoteLegacyApplicationArtifacts({
      preserveContextFlag: sourceSchemaVersion >= ARTIFACT_CONTEXT_SCHEMA_VERSION,
    });
    for (const job of Array.isArray(store?.assistantJobs) ? store.assistantJobs : preservedAssistantJobs) {
      this.restoreAssistantJob(job);
    }
    for (const application of applications) {
      if (!application.resumeFile?.dataUrl) continue;
      try {
        this.saveAttachmentForApplication(application.id, application.resumeFile);
      } catch (error) {
        this.logger?.warn?.("store.import_attachment_skipped", {
          applicationId: application.id,
          error: { message: error.message },
        });
      }
    }
    if (store?.activeInterviewId) this.setMeta("active_interview_id", store.activeInterviewId);
    return this.getStore();
  }

  promoteLegacyApplicationArtifacts({ preserveContextFlag = false } = {}) {
    // Older integrations could save process-wide artifacts on the only
    // interview row. Fill only missing Application artifacts so an explicit,
    // newer Application-level value always wins during import.
    const contextExpression = preserveContextFlag
      ? "interview_artifacts.include_in_cross_round_context"
      : `CASE
          WHEN interview_artifacts.kind IN ('process-brief', 'application-handoff', 'final-summary') THEN 1
          ELSE 0
        END`;
    this.db.exec(`
      INSERT OR IGNORE INTO application_artifacts
        (id, application_id, kind, title, markdown, source_harness,
         source_session_id, include_in_cross_round_context, created_at, updated_at)
      SELECT lower(hex(randomblob(16))), interviews.application_id,
        interview_artifacts.kind, interview_artifacts.title,
        interview_artifacts.markdown, interview_artifacts.source_harness,
        interview_artifacts.source_session_id,
        ${contextExpression},
        interview_artifacts.created_at,
        interview_artifacts.updated_at
      FROM interview_artifacts
      JOIN interviews ON interviews.id = interview_artifacts.interview_id
      WHERE interview_artifacts.kind IN
        ('resume-screening', 'process-brief', 'application-handoff', 'final-summary')
      ORDER BY interview_artifacts.updated_at DESC,
        interviews.round_order DESC,
        interview_artifacts.created_at DESC
    `);
  }

  createApplication(payload = {}) {
    const now = new Date().toISOString();
    assertValidApplicationStatus(requestedApplicationStatus(payload));
    const applicationId = cleanId(payload.id || payload.applicationId) || crypto.randomUUID();
    if (this.db.prepare("SELECT 1 FROM applications WHERE id = ?").get(applicationId)) {
      const error = new Error("应聘流程 ID 已存在");
      error.code = "APPLICATION_ID_CONFLICT";
      throw error;
    }
    const application = normalizeApplication({
      ...payload,
      id: applicationId,
      applicationStatus: payload.applicationStatus || payload.interviewStatus || payload.status,
      createdAt: now,
      updatedAt: now,
    });
    const firstRoundPayload = isObject(payload.firstRound)
      ? { ...payload, ...payload.firstRound }
      : payload;
    const firstRoundId = cleanId(firstRoundPayload.interviewId || firstRoundPayload.id) || applicationId;
    if (this.db.prepare("SELECT 1 FROM interviews WHERE id = ?").get(firstRoundId)) {
      const error = new Error("面试轮次 ID 已存在");
      error.code = "INTERVIEW_ID_CONFLICT";
      throw error;
    }
    const firstRound = {
      id: firstRoundId,
      applicationId,
      roundOrder: 1,
      roundLabel: cleanText(firstRoundPayload.roundLabel, 80) || "一面",
      roundStatus: normalizeRoundStatus(firstRoundPayload.roundStatus, firstRoundPayload),
      outcome: cleanText(firstRoundPayload.outcome, 80),
      roundFocus: cleanText(firstRoundPayload.roundFocus, 500000),
      name: application.name,
      createdAt: now,
      updatedAt: now,
      sessionStartedAt: normalizeDate(firstRoundPayload.sessionStartedAt),
      scheduledAt: normalizeDate(firstRoundPayload.scheduledAt || firstRoundPayload.interviewTime),
      durationMinutes: requestedInterviewDurationMinutes(firstRoundPayload.durationMinutes),
      interviewStatus: application.applicationStatus,
      resumeMarkdown: application.resumeMarkdown,
      roleMarkdown: application.roleMarkdown,
      resumeFile: firstRoundPayload.resumeFile || null,
      resumeNotes: application.resumeNotes,
      selectedJdId: application.selectedJdId,
      jdDraftName: application.jdDraftName,
      roleShortName: application.roleShortName,
      lines: Array.isArray(firstRoundPayload.lines) ? firstRoundPayload.lines : [],
      cards: Array.isArray(firstRoundPayload.cards) ? firstRoundPayload.cards : [],
      askedQuestions: Array.isArray(firstRoundPayload.askedQuestions) ? firstRoundPayload.askedQuestions : [],
      lastProcessedLineCount: Number(firstRoundPayload.lastProcessedLineCount || 0),
      speakerLabels: isObject(firstRoundPayload.speakerLabels) ? firstRoundPayload.speakerLabels : {},
      artifacts: Array.isArray(firstRoundPayload.artifacts) ? firstRoundPayload.artifacts : [],
      harnessSessions: Array.isArray(firstRoundPayload.harnessSessions) ? firstRoundPayload.harnessSessions : [],
    };
    const currentActiveId = this.getMeta("active_interview_id");
    const shouldActivate = payload.activate === true || !this.getInterview(currentActiveId);
    this.transaction(() => {
      this.upsertApplicationRow(application);
      this.addStatus(application.applicationStatus);
      this.upsertInterviewSnapshot(firstRound);
      if (Array.isArray(payload.applicationArtifacts)) {
        this.replaceApplicationArtifacts(applicationId, payload.applicationArtifacts);
      }
      if (shouldActivate) this.setMeta("active_interview_id", firstRound.id);
    });
    return this.getApplicationContext(applicationId);
  }

  createInterviewRound(applicationId, payload = {}) {
    const application = this.getApplication(applicationId);
    if (!application) return null;
    const now = new Date().toISOString();
    const nextOrder = this.db.prepare(`
      SELECT COALESCE(MAX(round_order), 0) + 1 AS next_order
      FROM interviews WHERE application_id = ? AND deleted_at IS NULL
    `).get(applicationId).next_order;
    const roundOrder = normalizeRoundOrder(nextOrder, 1);
    const interviewId = cleanId(payload.id || payload.interviewId) || crypto.randomUUID();
    if (this.db.prepare("SELECT 1 FROM interviews WHERE id = ?").get(interviewId)) {
      const error = new Error("面试轮次 ID 已存在");
      error.code = "INTERVIEW_ID_CONFLICT";
      throw error;
    }
    const interview = {
      id: interviewId,
      applicationId,
      roundOrder,
      roundLabel: cleanText(payload.roundLabel, 80) || `第${roundOrder}轮`,
      roundStatus: normalizeRoundStatus(payload.roundStatus, {
        scheduledAt: payload.scheduledAt || payload.interviewTime,
      }),
      outcome: "",
      roundFocus: cleanText(payload.roundFocus, 500000),
      name: application.name,
      createdAt: now,
      updatedAt: now,
      sessionStartedAt: null,
      scheduledAt: normalizeDate(payload.scheduledAt || payload.interviewTime),
      durationMinutes: requestedInterviewDurationMinutes(payload.durationMinutes),
      interviewStatus: application.applicationStatus,
      resumeMarkdown: application.resumeMarkdown,
      roleMarkdown: application.roleMarkdown,
      resumeFile: null,
      resumeNotes: application.resumeNotes,
      selectedJdId: application.selectedJdId,
      jdDraftName: application.jdDraftName,
      roleShortName: application.roleShortName,
      // A new round may inherit only Application-owned material. Round-owned
      // evidence and sessions always start empty, even if a legacy caller sends them.
      lines: [],
      cards: [],
      askedQuestions: [],
      lastProcessedLineCount: 0,
      speakerLabels: {},
      artifacts: [],
      harnessSessions: [],
    };
    this.transaction(() => {
      this.upsertInterviewSnapshot(interview);
      this.db.prepare("UPDATE applications SET updated_at = ? WHERE id = ?").run(now, applicationId);
      if (payload.activate === true) this.setMeta("active_interview_id", interview.id);
    });
    return this.getInterview(interview.id);
  }

  createInterview(payload = {}) {
    const existingApplicationId = cleanId(payload.applicationId);
    if (existingApplicationId && this.getApplication(existingApplicationId)) {
      return this.createInterviewRound(existingApplicationId, payload);
    }
    const context = this.createApplication({
      ...payload,
      id: existingApplicationId || payload.id,
      firstRound: { ...payload, id: payload.id },
    });
    const firstRoundId = context?.rounds?.[0]?.id;
    return firstRoundId ? this.getInterview(firstRoundId) : null;
  }

  setActiveInterview(id) {
    const interview = this.getInterview(id);
    if (!interview) return null;
    this.setMeta("active_interview_id", interview.id);
    return interview;
  }

  getApplication(id) {
    const row = this.db
      .prepare("SELECT * FROM applications WHERE id = ? AND deleted_at IS NULL")
      .get(id);
    return row ? this.hydrateApplication(row) : null;
  }

  getApplicationContext(id) {
    const application = this.getApplication(id);
    if (!application) return null;
    const applicationArtifacts = this.listApplicationArtifacts(id);
    const applicationArtifactPolicy = buildApplicationArtifactContextPolicy(
      applicationArtifacts,
    );
    const rounds = this.db
      .prepare(`
        SELECT * FROM interviews
        WHERE application_id = ? AND deleted_at IS NULL
        ORDER BY round_order, created_at
      `)
      .all(id)
      .map((row) => ({
        id: row.id,
        applicationId: row.application_id,
        roundOrder: row.round_order,
        roundLabel: row.round_label,
        roundStatus: row.round_status,
        outcome: row.outcome,
        roundFocus: row.round_focus,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        sessionStartedAt: row.session_started_at || null,
        scheduledAt: row.scheduled_at || "",
        durationMinutes: resolveInterviewDurationMinutes(row.duration_minutes),
        transcriptLineCount: this.db
          .prepare("SELECT COUNT(*) AS count FROM transcript_lines WHERE interview_id = ?")
          .get(row.id).count,
        artifacts: this.listArtifacts(row.id)
          .filter(
            (artifact) =>
              artifact.includeInCrossRoundContext &&
              !isRoundArtifactShadowed(artifact, applicationArtifactPolicy),
          ),
      }));
    return {
      ...application,
      rounds,
      applicationArtifacts,
      artifacts: applicationArtifacts,
    };
  }

  listApplications({ query = "", status = "", limit = 50 } = {}) {
    const normalizedQuery = cleanText(query, 160).toLowerCase();
    const normalizedStatus = cleanText(status, 24);
    const rows = this.db.prepare(`
      SELECT applications.*,
        (SELECT COUNT(*) FROM interviews
          WHERE application_id = applications.id AND deleted_at IS NULL) AS round_count,
        (SELECT COUNT(*) FROM application_artifacts
          WHERE application_id = applications.id) AS artifact_count,
        (SELECT MIN(scheduled_at) FROM interviews
          WHERE application_id = applications.id AND deleted_at IS NULL
            AND datetime(scheduled_at) >= datetime('now')) AS next_round_at
      FROM applications
      WHERE deleted_at IS NULL
        AND (? = '' OR application_status = ?)
        AND (? = '' OR LOWER(name) LIKE '%' || ? || '%'
          OR LOWER(jd_draft_name) LIKE '%' || ? || '%'
          OR LOWER(role_short_name) LIKE '%' || ? || '%')
      ORDER BY updated_at DESC
      LIMIT ?
    `).all(
      normalizedStatus,
      normalizedStatus,
      normalizedQuery,
      normalizedQuery,
      normalizedQuery,
      normalizedQuery,
      Math.min(200, Math.max(1, Number(limit) || 50)),
    );
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      applicationStatus: row.application_status,
      interviewStatus: row.application_status,
      selectedJdId: row.selected_jd_id,
      jdDraftName: row.jd_draft_name,
      roleShortName: row.role_short_name,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      roundCount: row.round_count,
      artifactCount: row.artifact_count,
      nextRoundAt: row.next_round_at || "",
    }));
  }

  patchApplication(id, patch = {}) {
    const current = this.getApplication(id);
    if (!current) return null;
    const aliases = { ...patch };
    const statusWasProvided = hasApplicationStatusField(patch);
    if (statusWasProvided) {
      aliases.applicationStatus = requestedApplicationStatus(patch);
      assertValidApplicationStatus(aliases.applicationStatus);
    }
    const merged = normalizeApplication({
      ...current,
      ...pick(aliases, [
        "name",
        "applicationStatus",
        "resumeMarkdown",
        "roleMarkdown",
        "resumeNotes",
        "selectedJdId",
        "jdDraftName",
        "roleShortName",
      ]),
      createdAt: current.createdAt,
      updatedAt: new Date().toISOString(),
    });
    this.transaction(() => {
      this.upsertApplicationRow(merged);
      this.syncApplicationSharedFields(merged);
      this.addStatus(merged.applicationStatus);
    });
    return this.getApplication(id);
  }

  softDeleteApplication(id) {
    const now = new Date().toISOString();
    return this.transaction(() => {
      const result = this.db.prepare(`
        UPDATE applications SET deleted_at = ?, updated_at = ?
        WHERE id = ? AND deleted_at IS NULL
      `).run(now, now, id);
      if (!result.changes) return false;
      this.db.prepare(`
        UPDATE interviews SET deleted_at = ?, updated_at = ?
        WHERE application_id = ? AND deleted_at IS NULL
      `).run(now, now, id);
      return true;
    });
  }

  upsertApplicationArtifact(
    applicationId,
    artifact,
    { allowLegacyContextFallback = false } = {},
  ) {
    if (!this.getApplication(applicationId)) return null;
    const now = new Date().toISOString();
    const kind = cleanSlug(artifact?.kind, 80);
    const markdown = cleanText(artifact?.markdown, 1000000);
    if (!kind) throw new Error("Artifact kind is required");
    if (!markdown) throw new Error("Artifact markdown is required");
    const existing = this.db.prepare(`
      SELECT * FROM application_artifacts WHERE application_id = ? AND kind = ?
    `).get(applicationId, kind);
    const includeInCrossRoundContext = resolveArtifactContextFlag({
      artifact,
      existing,
      kind,
      scope: "application",
      allowLegacyContextFallback,
    });
    const value = {
      id: existing?.id || cleanId(artifact?.id) || crypto.randomUUID(),
      applicationId,
      kind,
      title: cleanText(artifact?.title, 200) || artifactTitle(kind),
      markdown,
      sourceHarness: cleanSlug(artifact?.sourceHarness, 40),
      sourceSessionId: cleanText(artifact?.sourceSessionId, 200),
      includeInCrossRoundContext,
      createdAt: existing?.created_at || normalizeDate(artifact?.createdAt) || now,
      updatedAt: now,
    };
    this.db.prepare(`
      INSERT INTO application_artifacts
        (id, application_id, kind, title, markdown, source_harness,
         source_session_id, include_in_cross_round_context, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(application_id, kind) DO UPDATE SET
        title=excluded.title, markdown=excluded.markdown,
        source_harness=excluded.source_harness,
        source_session_id=excluded.source_session_id,
        include_in_cross_round_context=excluded.include_in_cross_round_context,
        updated_at=excluded.updated_at
    `).run(
      value.id,
      value.applicationId,
      value.kind,
      value.title,
      value.markdown,
      value.sourceHarness,
      value.sourceSessionId,
      value.includeInCrossRoundContext ? 1 : 0,
      value.createdAt,
      value.updatedAt,
    );
    this.db.prepare("UPDATE applications SET updated_at = ? WHERE id = ?")
      .run(now, applicationId);
    return this.listApplicationArtifacts(applicationId).find((item) => item.kind === kind);
  }

  listApplicationArtifacts(applicationId) {
    return this.db
      .prepare("SELECT * FROM application_artifacts WHERE application_id = ? ORDER BY updated_at DESC")
      .all(applicationId)
      .map(mapApplicationArtifact);
  }

  getCrossRoundContext(interviewId, maxChars = 60000) {
    const current = this.getInterviewContext(interviewId);
    if (!current) return "";
    const sections = [];
    const allApplicationArtifacts = this.listApplicationArtifacts(current.applicationId);
    const applicationArtifactPolicy = buildApplicationArtifactContextPolicy(
      allApplicationArtifacts,
    );
    const applicationArtifacts = applicationArtifactPolicy.includedArtifacts;
    for (const artifact of applicationArtifacts) {
      sections.push(`## ${artifact.title}\n\n${artifact.markdown}`);
    }
    const priorRounds = this.db.prepare(`
      SELECT * FROM interviews
      WHERE application_id = ? AND deleted_at IS NULL AND round_order < ?
      ORDER BY round_order, created_at
    `).all(current.applicationId, current.roundOrder);
    for (const round of priorRounds) {
      const artifacts = this.listArtifacts(round.id)
        .filter((artifact) => artifact.includeInCrossRoundContext);
      for (const artifact of artifacts) {
        if (isRoundArtifactShadowed(artifact, applicationArtifactPolicy)) continue;
        const roundLabel = round.round_label || `第${round.round_order}轮`;
        sections.push(`## ${roundLabel} · ${artifact.title}\n\n${artifact.markdown}`);
      }
    }
    const safeMaxChars = Math.min(500000, Math.max(0, Number(maxChars) || 60000));
    return sections.join("\n\n").slice(0, safeMaxChars);
  }

  getInterview(id) {
    const row = this.db
      .prepare(`
        SELECT interviews.* FROM interviews
        JOIN applications ON applications.id = interviews.application_id
        WHERE interviews.id = ? AND interviews.deleted_at IS NULL AND applications.deleted_at IS NULL
      `)
      .get(id);
    return row ? this.hydrateInterview(row) : null;
  }

  getInterviewContext(id) {
    const row = this.db
      .prepare(`
        SELECT interviews.* FROM interviews
        JOIN applications ON applications.id = interviews.application_id
        WHERE interviews.id = ? AND interviews.deleted_at IS NULL AND applications.deleted_at IS NULL
      `)
      .get(id);
    return row ? this.hydrateInterview(row, { includeLines: false }) : null;
  }

  listInterviews({
    query = "",
    applicationStatus = "",
    roundStatus = "",
    status = "",
    limit = 50,
  } = {}) {
    const normalizedQuery = cleanText(query, 160).toLowerCase();
    const normalizedApplicationStatus = cleanText(applicationStatus || status, 24);
    const normalizedRoundStatus = cleanText(roundStatus, 24);
    const rows = this.db
      .prepare(`
        SELECT interviews.id, interviews.application_id, interviews.round_order,
          interviews.round_label, interviews.round_status, interviews.outcome,
          applications.name, applications.application_status AS interview_status,
          interviews.scheduled_at, interviews.session_started_at,
          interviews.duration_minutes,
          interviews.created_at, interviews.updated_at,
          applications.jd_draft_name, applications.selected_jd_id,
          applications.role_short_name,
          (SELECT COUNT(*) FROM transcript_lines WHERE interview_id = interviews.id) AS transcript_line_count,
          (SELECT COUNT(*) FROM interview_artifacts WHERE interview_id = interviews.id) AS artifact_count
        FROM interviews
        JOIN applications ON applications.id = interviews.application_id
        WHERE interviews.deleted_at IS NULL AND applications.deleted_at IS NULL
          AND (? = '' OR applications.application_status = ?)
          AND (? = '' OR interviews.round_status = ?)
          AND (? = '' OR LOWER(applications.name) LIKE '%' || ? || '%'
            OR LOWER(applications.jd_draft_name) LIKE '%' || ? || '%'
            OR LOWER(applications.role_short_name) LIKE '%' || ? || '%')
        ORDER BY COALESCE(interviews.scheduled_at, interviews.updated_at) DESC
        LIMIT ?
      `)
      .all(
        normalizedApplicationStatus,
        normalizedApplicationStatus,
        normalizedRoundStatus,
        normalizedRoundStatus,
        normalizedQuery,
        normalizedQuery,
        normalizedQuery,
        normalizedQuery,
        Math.min(200, Math.max(1, Number(limit) || 50)),
      );
    return rows.map((row) => ({
      id: row.id,
      applicationId: row.application_id,
      roundOrder: row.round_order,
      roundLabel: row.round_label,
      roundStatus: row.round_status,
      outcome: row.outcome,
      name: row.name,
      applicationStatus: row.interview_status,
      interviewStatus: row.interview_status,
      scheduledAt: row.scheduled_at || "",
      sessionStartedAt: row.session_started_at || null,
      durationMinutes: resolveInterviewDurationMinutes(row.duration_minutes),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      roleName: row.jd_draft_name,
      roleShortName: row.role_short_name,
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
    if (Object.prototype.hasOwnProperty.call(patch || {}, "durationMinutes")) {
      requestedInterviewDurationMinutes(patch.durationMinutes);
    }
    const sharedPatch = pick(patch, [
      "name",
      "resumeMarkdown",
      "roleMarkdown",
      "resumeNotes",
      "selectedJdId",
      "jdDraftName",
      "roleShortName",
    ]);
    if ("interviewStatus" in (patch || {}) || "applicationStatus" in (patch || {}) || "status" in (patch || {})) {
      sharedPatch.applicationStatus = patch.applicationStatus || patch.interviewStatus || patch.status;
    }
    const merged = {
      ...current,
      ...pick(patch, [
        "sessionStartedAt",
        "scheduledAt",
        "durationMinutes",
        "roundOrder",
        "roundLabel",
        "roundStatus",
        "outcome",
        "roundFocus",
        "lastProcessedLineCount",
        "speakerLabels",
        "askedQuestions",
      ]),
      updatedAt: new Date().toISOString(),
    };
    // The analysis cursor only moves forward; job completion owns advancing it,
    // so a stale client patch must never rewind already-analyzed segments.
    merged.lastProcessedLineCount = Math.max(
      Number(current.lastProcessedLineCount || 0),
      Number(merged.lastProcessedLineCount || 0),
    );
    this.transaction(() => {
      if (Object.keys(sharedPatch).length) this.patchApplication(current.applicationId, sharedPatch);
      const application = this.getApplication(current.applicationId);
      Object.assign(merged, sharedFieldsForInterview(application));
      this.upsertInterviewRow(merged);
      if (Array.isArray(patch.askedQuestions)) this.replaceQuestions(id, patch.askedQuestions);
      this.db.prepare("UPDATE applications SET updated_at = ? WHERE id = ?")
        .run(merged.updatedAt, current.applicationId);
    });
    return this.getInterview(id);
  }

  softDeleteInterview(id) {
    const interview = this.db.prepare(`
      SELECT id, application_id FROM interviews WHERE id = ? AND deleted_at IS NULL
    `).get(id);
    if (!interview) return false;
    const activeRoundCount = this.db.prepare(`
      SELECT COUNT(*) AS count FROM interviews
      WHERE application_id = ? AND deleted_at IS NULL
    `).get(interview.application_id).count;
    if (activeRoundCount <= 1) {
      const error = new Error("唯一一轮不能删除，请归档整个应聘流程");
      error.code = "LAST_ROUND";
      throw error;
    }
    const now = new Date().toISOString();
    return this.transaction(() => {
      const result = this.db.prepare(`
        UPDATE interviews SET deleted_at = ?, updated_at = ?
        WHERE id = ? AND deleted_at IS NULL
      `).run(now, now, id);
      this.db.prepare("UPDATE applications SET updated_at = ? WHERE id = ?")
        .run(now, interview.application_id);
      return result.changes > 0;
    });
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
    const interview = this.getInterviewContext(interviewId);
    if (!interview) return null;
    return this.saveAttachmentForApplication(interview.applicationId, file, interviewId);
  }

  saveAttachmentForApplication(applicationId, file, ownerInterviewId = "") {
    if (!this.getApplication(applicationId)) return null;
    if (!isObject(file)) throw new Error("Invalid attachment");
    const data = decodeDataUrl(file.dataUrl);
    if (!data.length || data.length > 10 * 1024 * 1024) {
      throw new Error("Resume attachment must be between 1 byte and 10MB");
    }
    const type = cleanText(file.type, 160) || "application/octet-stream";
    const name = cleanText(file.name, 300) || "resume";
    if (!isAllowedResume(name, type)) throw new Error("Only PDF, DOC, and DOCX resumes are supported");
    const format = sniffResumeFormat(data);
    if (!format) throw new Error("Resume content is not a valid PDF, DOC, or DOCX file");
    const existing = this.db.prepare("SELECT * FROM attachments WHERE application_id = ?").get(applicationId);
    const attachmentOwnerId = existing?.interview_id || cleanId(ownerInterviewId)
      || this.db.prepare(`
        SELECT id FROM interviews WHERE application_id = ? AND deleted_at IS NULL
        ORDER BY round_order, created_at LIMIT 1
      `).get(applicationId)?.id;
    if (!attachmentOwnerId) return null;
    const id = existing?.id || crypto.randomUUID();
    const extension = format.extension;
    const relativePath = path.join("attachments", `${id}${extension}`);
    const absolutePath = path.join(this.config.dataDir, relativePath);
    fs.writeFileSync(absolutePath, data, { mode: 0o600 });
    if (existing && existing.relative_path !== relativePath) safeUnlink(path.join(this.config.dataDir, existing.relative_path));
    this.db.prepare(`
      INSERT INTO attachments
        (id, application_id, interview_id, name, type, size, relative_path, preview_text, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(application_id) DO UPDATE SET
        name=excluded.name, type=excluded.type, size=excluded.size,
        relative_path=excluded.relative_path, preview_text=excluded.preview_text,
        updated_at=excluded.updated_at
    `).run(
      id,
      applicationId,
      attachmentOwnerId,
      name,
      format.type,
      data.length,
      relativePath,
      cleanText(file.previewText, 500000),
      new Date().toISOString(),
    );
    return this.getAttachmentForApplication(applicationId);
  }

  removeAttachment(interviewId) {
    const interview = this.getInterviewContext(interviewId);
    if (!interview) return false;
    const existing = this.db.prepare("SELECT * FROM attachments WHERE application_id = ?")
      .get(interview.applicationId);
    if (!existing) return false;
    this.db.prepare("DELETE FROM attachments WHERE application_id = ?").run(interview.applicationId);
    safeUnlink(path.join(this.config.dataDir, existing.relative_path));
    return true;
  }

  getAttachment(id) {
    const row = this.db.prepare(`
      SELECT attachments.* FROM attachments
      JOIN applications ON applications.id = attachments.application_id
      WHERE attachments.id = ? AND applications.deleted_at IS NULL
        AND EXISTS (
          SELECT 1 FROM interviews
          WHERE interviews.application_id = applications.id AND interviews.deleted_at IS NULL
        )
    `).get(id);
    if (!row) return null;
    return { ...mapAttachment(row), absolutePath: path.join(this.config.dataDir, row.relative_path) };
  }

  getAttachmentForInterview(interviewId) {
    const interview = this.db.prepare(`
      SELECT interviews.application_id FROM interviews
      JOIN applications ON applications.id = interviews.application_id
      WHERE interviews.id = ? AND interviews.deleted_at IS NULL AND applications.deleted_at IS NULL
    `).get(interviewId);
    if (!interview) return null;
    return this.getAttachmentForApplication(interview.application_id);
  }

  getAttachmentForApplication(applicationId) {
    if (!this.db.prepare("SELECT 1 FROM applications WHERE id = ? AND deleted_at IS NULL").get(applicationId)) {
      return null;
    }
    const row = this.db.prepare("SELECT * FROM attachments WHERE application_id = ?").get(applicationId);
    return row ? mapAttachment(row) : null;
  }

  setAttachmentPreviewText(id, previewText) {
    if (!this.getAttachment(id)) return null;
    this.db.prepare("UPDATE attachments SET preview_text = ?, updated_at = ? WHERE id = ?").run(
      cleanText(previewText, 500000),
      new Date().toISOString(),
      id,
    );
    return this.getAttachment(id);
  }

  upsertJd(jd) {
    const now = new Date().toISOString();
    const id = cleanId(jd?.id) || crypto.randomUUID();
    const current = this.db.prepare("SELECT short_name FROM jd_library WHERE id = ?").get(id);
    const hasShortName = Object.prototype.hasOwnProperty.call(jd || {}, "shortName");
    const value = {
      id,
      name: cleanText(jd?.name, 300) || "未命名 JD",
      shortName: hasShortName ? cleanText(jd?.shortName, 40) : current?.short_name || "",
      content: cleanText(jd?.content, 500000),
      createdAt: normalizeDate(jd?.createdAt) || now,
      updatedAt: normalizeDate(jd?.updatedAt) || now,
    };
    this.db.prepare(`
      INSERT INTO jd_library (id, name, short_name, content, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name=excluded.name, short_name=excluded.short_name,
        content=excluded.content, updated_at=excluded.updated_at
    `).run(
      value.id,
      value.name,
      value.shortName,
      value.content,
      value.createdAt,
      value.updatedAt,
    );
    return value;
  }

  addStatus(status, sortOrder = null, color = "") {
    const value = cleanText(status, 24);
    if (!value) return;
    const normalizedColor = normalizeStatusColor(color);
    const order = sortOrder ?? this.db.prepare("SELECT COUNT(*) AS count FROM status_options").get().count;
    this.db.prepare(`
      INSERT OR IGNORE INTO status_options (value, color, sort_order, created_at)
      VALUES (?, ?, ?, ?)
    `).run(value, normalizedColor, order, new Date().toISOString());
    if (normalizedColor) {
      this.db.prepare(`
        UPDATE status_options SET color = ?
        WHERE value = ? AND color = ''
      `).run(normalizedColor, value);
    }
  }

  setStatusColor(status, color) {
    const value = cleanText(status, 24);
    const normalizedColor = normalizeStatusColor(color);
    if (!value) throw new Error("状态名称无效");
    if (!normalizedColor) throw new Error("状态颜色无效");
    this.addStatus(value);
    this.db.prepare("UPDATE status_options SET color = ? WHERE value = ?")
      .run(normalizedColor, value);
    return { value, color: normalizedColor };
  }

  upsertArtifact(
    interviewId,
    artifact,
    {
      mirrorApplication = true,
      allowLegacyContextFallback = false,
      legacyRoundHandoffExists,
      preserveTimestamps = false,
    } = {},
  ) {
    if (!this.getInterviewContext(interviewId)) return null;
    const now = new Date().toISOString();
    const kind = cleanSlug(artifact?.kind, 80);
    const markdown = cleanText(artifact?.markdown, 1000000);
    if (!kind) throw new Error("Artifact kind is required");
    if (!markdown) throw new Error("Artifact markdown is required");
    const existing = this.db
      .prepare("SELECT * FROM interview_artifacts WHERE interview_id = ? AND kind = ?")
      .get(interviewId, kind);
    const hasExplicitContextFlag = Object.prototype.hasOwnProperty.call(
      artifact || {},
      "includeInCrossRoundContext",
    );
    const resolvedLegacyRoundHandoffExists =
      typeof legacyRoundHandoffExists === "boolean"
        ? legacyRoundHandoffExists
        : Boolean(this.db.prepare(`
          SELECT 1 FROM interview_artifacts
          WHERE interview_id = ? AND kind = 'round-handoff'
        `).get(interviewId));
    const includeInCrossRoundContext = resolveArtifactContextFlag({
      artifact,
      existing,
      kind,
      scope: "round",
      allowLegacyContextFallback,
      legacyRoundHandoffExists: resolvedLegacyRoundHandoffExists,
    });
    const value = {
      id: existing?.id || cleanId(artifact?.id) || crypto.randomUUID(),
      interviewId,
      kind,
      title: cleanText(artifact?.title, 200) || artifactTitle(kind),
      markdown,
      sourceHarness: cleanSlug(artifact?.sourceHarness, 40),
      sourceSessionId: cleanText(artifact?.sourceSessionId, 200),
      includeInCrossRoundContext,
      createdAt: existing?.created_at || normalizeDate(artifact?.createdAt) || now,
      updatedAt: preserveTimestamps
        ? normalizeDate(artifact?.updatedAt) || now
        : now,
    };
    this.db.prepare(`
      INSERT INTO interview_artifacts
        (id, interview_id, kind, title, markdown, source_harness, source_session_id,
         include_in_cross_round_context, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(interview_id, kind) DO UPDATE SET
        title=excluded.title, markdown=excluded.markdown,
        source_harness=excluded.source_harness, source_session_id=excluded.source_session_id,
        include_in_cross_round_context=excluded.include_in_cross_round_context,
        updated_at=excluded.updated_at
    `).run(
      value.id,
      value.interviewId,
      value.kind,
      value.title,
      value.markdown,
      value.sourceHarness,
      value.sourceSessionId,
      value.includeInCrossRoundContext ? 1 : 0,
      value.createdAt,
      value.updatedAt,
    );
    this.db.prepare("UPDATE interviews SET updated_at = ? WHERE id = ?").run(now, interviewId);
    if (kind === "round-handoff" && !hasExplicitContextFlag) {
      this.db.prepare(`
        UPDATE interview_artifacts SET include_in_cross_round_context = 0
        WHERE interview_id = ? AND kind = 'interview-summary'
      `).run(interviewId);
    }
    if (mirrorApplication && LEGACY_MIRRORED_APPLICATION_ARTIFACT_KINDS.has(kind)) {
      const applicationId = this.db
        .prepare("SELECT application_id FROM interviews WHERE id = ?")
        .get(interviewId)?.application_id;
      if (applicationId) {
        const mirroredArtifact = {
          kind,
          title: value.title,
          markdown: value.markdown,
          sourceHarness: value.sourceHarness,
          sourceSessionId: value.sourceSessionId,
          ...(hasExplicitContextFlag
            ? { includeInCrossRoundContext: value.includeInCrossRoundContext }
            : {}),
        };
        this.upsertApplicationArtifact(applicationId, mirroredArtifact);
      }
    }
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

  getProviderSettings() {
    const row = this.db.prepare("SELECT settings_json FROM provider_settings WHERE id = 1").get();
    return row ? parseJson(row.settings_json, {}) : {};
  }

  setProviderSettings(settings) {
    const value = isObject(settings) ? settings : {};
    this.db.prepare(`
      INSERT INTO provider_settings (id, settings_json, updated_at)
      VALUES (1, ?, ?)
      ON CONFLICT(id) DO UPDATE SET settings_json=excluded.settings_json, updated_at=excluded.updated_at
    `).run(JSON.stringify(value), new Date().toISOString());
    trySetPrivateMode(this.config.databaseFile);
    return this.getProviderSettings();
  }

  getAssistantState(interviewId) {
    const row = this.db.prepare("SELECT * FROM assistant_states WHERE interview_id = ?").get(interviewId);
    return row ? {
      ...normalizeAssistantState(parseJson(row.state_json, {})),
      revision: row.revision,
      processedLineCount: row.processed_line_count,
      updatedAt: row.updated_at || null,
    } : normalizeAssistantState({});
  }

  saveAssistantState(interviewId, state, { expectedRevision } = {}) {
    return this.transaction(() => {
      if (!this.getInterviewContext(interviewId)) return null;
      const current = this.getAssistantState(interviewId);
      const normalized = normalizeAssistantState(state);
      if (
        (expectedRevision !== undefined && Number(expectedRevision) !== current.revision) ||
        normalized.processedLineCount < current.processedLineCount
      ) {
        const error = new Error("面试进度已更新，请基于最新内容重试");
        error.code = "ASSISTANT_STATE_CONFLICT";
        throw error;
      }
      const next = {
        ...normalized,
        revision: current.revision + 1,
        updatedAt: new Date().toISOString(),
      };
      this.restoreAssistantState(interviewId, next);
      return this.getAssistantState(interviewId);
    });
  }

  restoreAssistantState(interviewId, state) {
    const value = normalizeAssistantState(state);
    this.db.prepare(`
      INSERT INTO assistant_states
        (interview_id, revision, processed_line_count, state_json, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(interview_id) DO UPDATE SET
        revision=excluded.revision, processed_line_count=excluded.processed_line_count,
        state_json=excluded.state_json, updated_at=excluded.updated_at
    `).run(interviewId, value.revision, value.processedLineCount, JSON.stringify(value), value.updatedAt);
  }

  createAssistantJob({ interviewId, mode, payload, idempotencyKey, maxAttempts = 3 }) {
    if (!["summary", "followup"].includes(mode)) throw new Error("Invalid assistant job mode");
    return this.transaction(() => {
      if (!this.getInterviewContext(interviewId)) return null;
      const key = cleanText(idempotencyKey, 1000) || crypto.randomUUID();
      const existing = this.db.prepare(`
        SELECT * FROM assistant_jobs WHERE interview_id = ? AND mode = ? AND idempotency_key = ?
      `).get(interviewId, mode, key);
      if (existing) return mapAssistantJob(existing);
      const now = new Date().toISOString();
      const id = crypto.randomUUID();
      this.db.prepare(`
        INSERT INTO assistant_jobs
          (id, interview_id, mode, idempotency_key, status, attempts, max_attempts,
           payload_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'queued', 0, ?, ?, ?, ?)
      `).run(id, interviewId, mode, key, positiveInteger(maxAttempts, 3), JSON.stringify(payload || {}), now, now);
      return this.getAssistantJob(id);
    });
  }

  getAssistantJob(id) {
    const row = this.db.prepare("SELECT * FROM assistant_jobs WHERE id = ?").get(id);
    return row ? mapAssistantJob(row) : null;
  }

  listRunnableAssistantJobs(limit = 10) {
    return this.db.prepare(`
      SELECT assistant_jobs.* FROM assistant_jobs
      JOIN interviews ON interviews.id = assistant_jobs.interview_id
      JOIN applications ON applications.id = interviews.application_id
      WHERE assistant_jobs.status IN ('queued', 'retrying')
        AND interviews.deleted_at IS NULL AND applications.deleted_at IS NULL
      ORDER BY assistant_jobs.created_at, assistant_jobs.rowid LIMIT ?
    `).all(positiveInteger(limit, 10)).map(mapAssistantJob);
  }

  listAssistantJobs(interviewId, { pendingOnly = false } = {}) {
    return this.db.prepare(`
      SELECT * FROM assistant_jobs WHERE interview_id = ?
        ${pendingOnly ? "AND status IN ('queued', 'running', 'retrying')" : ""}
      ORDER BY created_at DESC, rowid DESC
    `).all(interviewId).map(mapAssistantJob);
  }

  updateAssistantJob(id, patch) {
    const current = this.getAssistantJob(id);
    if (!current) return null;
    const next = { ...current, ...pick(patch, ["status", "attempts", "payload", "result", "error"]), updatedAt: new Date().toISOString() };
    if (!ASSISTANT_JOB_STATUSES.has(next.status)) throw new Error("Invalid assistant job status");
    this.db.prepare(`
      UPDATE assistant_jobs SET status=?, attempts=?, payload_json=?, result_json=?, error=?, updated_at=? WHERE id=?
    `).run(
      next.status,
      nonnegativeInteger(next.attempts),
      JSON.stringify(next.payload || {}),
      next.result == null ? null : JSON.stringify(next.result),
      cleanText(next.error, 20000) || null,
      next.updatedAt,
      id,
    );
    return this.getAssistantJob(id);
  }

  retryAssistantJob(id) {
    const current = this.getAssistantJob(id);
    if (!current || !["error", "cancelled"].includes(current.status)) return null;
    return this.updateAssistantJob(id, { status: "queued", attempts: 0, error: "", result: null });
  }

  restoreAssistantJob(job) {
    if (!isObject(job) || !["summary", "followup"].includes(job.mode) || !this.getInterviewContext(job.interviewId)) return;
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT OR IGNORE INTO assistant_jobs
        (id, interview_id, mode, idempotency_key, status, attempts, max_attempts,
         payload_json, result_json, error, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      cleanId(job.id) || crypto.randomUUID(),
      job.interviewId,
      job.mode,
      cleanText(job.idempotencyKey, 1000) || crypto.randomUUID(),
      ASSISTANT_JOB_STATUSES.has(job.status) ? job.status : "queued",
      nonnegativeInteger(job.attempts),
      positiveInteger(job.maxAttempts, 3),
      JSON.stringify(job.payload || {}),
      job.result == null ? null : JSON.stringify(job.result),
      cleanText(job.error, 20000) || null,
      normalizeDate(job.createdAt) || now,
      normalizeDate(job.updatedAt) || now,
    );
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
      UPDATE assistant_jobs SET status='retrying', error='Recovered after restart', updated_at=?
      WHERE status IN ('running', 'retrying')
    `).run(now);
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
    const store = this.getStore({ includeAllLines: true });
    return {
      ...store,
      exportedAt: new Date().toISOString(),
      assistantJobs: store.interviews.flatMap((interview) => this.listAssistantJobs(interview.id)),
      applications: store.applications.map((application) => {
        if (!application.resumeFile) return application;
        const attachment = this.getAttachment(application.resumeFile.id);
        if (!attachment || !fs.existsSync(attachment.absolutePath)) return application;
        const data = fs.readFileSync(attachment.absolutePath).toString("base64");
        return {
          ...application,
          resumeFile: {
            ...application.resumeFile,
            dataUrl: `data:${application.resumeFile.type};base64,${data}`,
          },
        };
      }),
    };
  }

  importBackup(store) {
    assertImportableStore(store, "备份文件格式无效");
    this.backup();
    return this.transaction(() => {
      const imported = this.importStore(store, { replace: true, allowAssistantStateRollback: true });
      this.recoverInterruptedJobs();
      return imported;
    });
  }

  transaction(callback) {
    // Reentrant: nested calls run inside a savepoint so an inner failure
    // rolls back only its own writes without aborting the outer transaction.
    if (this.transactionDepth > 0) {
      const savepoint = `sp_${this.transactionDepth}`;
      this.db.exec(`SAVEPOINT ${savepoint}`);
      this.transactionDepth += 1;
      try {
        const result = callback();
        this.db.exec(`RELEASE ${savepoint}`);
        return result;
      } catch (error) {
        this.db.exec(`ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`);
        throw error;
      } finally {
        this.transactionDepth -= 1;
      }
    }
    this.db.exec("BEGIN IMMEDIATE");
    this.transactionDepth = 1;
    try {
      const result = callback();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    } finally {
      this.transactionDepth = 0;
    }
  }

  hydrateApplication(row) {
    const rounds = this.db.prepare(`
      SELECT id, round_order, scheduled_at FROM interviews
      WHERE application_id = ? AND deleted_at IS NULL
      ORDER BY round_order, created_at
    `).all(row.id);
    const applicationArtifacts = this.listApplicationArtifacts(row.id);
    return {
      ...mapApplication(row),
      resumeFile: this.getAttachmentForApplication(row.id),
      roundCount: rounds.length,
      roundIds: rounds.map((round) => round.id),
      applicationArtifacts,
      artifacts: applicationArtifacts,
    };
  }

  hydrateInterview(row, { includeLines = true } = {}) {
    const applicationRow = this.db
      .prepare("SELECT * FROM applications WHERE id = ? AND deleted_at IS NULL")
      .get(row.application_id);
    if (!applicationRow) return null;
    const application = mapApplication(applicationRow);
    const lines = includeLines
      ? this.db
        .prepare("SELECT * FROM transcript_lines WHERE interview_id = ? ORDER BY position")
        .all(row.id)
        .map(mapLine)
      : undefined;
    const transcriptLineCount = includeLines
      ? lines.length
      : this.db
        .prepare("SELECT COUNT(*) AS count FROM transcript_lines WHERE interview_id = ?")
        .get(row.id).count;
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
      applicationId: row.application_id,
      roundOrder: row.round_order,
      roundLabel: row.round_label,
      roundStatus: row.round_status,
      outcome: row.outcome,
      roundFocus: row.round_focus,
      name: application.name,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      sessionStartedAt: row.session_started_at || null,
      scheduledAt: row.scheduled_at || "",
      durationMinutes: resolveInterviewDurationMinutes(row.duration_minutes),
      interviewStatus: application.applicationStatus,
      applicationStatus: application.applicationStatus,
      resumeMarkdown: application.resumeMarkdown,
      roleMarkdown: application.roleMarkdown,
      resumeFile: this.getAttachmentForInterview(row.id),
      resumeNotes: application.resumeNotes,
      selectedJdId: application.selectedJdId,
      jdDraftName: application.jdDraftName,
      roleShortName: application.roleShortName,
      ...(includeLines ? { lines } : {}),
      transcriptLineCount,
      cards,
      assistantState: this.getAssistantState(row.id),
      askedQuestions,
      lastProcessedLineCount: row.last_processed_line_count,
      speakerLabels: parseJson(row.speaker_labels_json, {}),
      artifacts: this.listArtifacts(row.id),
      harnessSessions: this.listHarnessSessions(row.id),
    };
  }

  upsertInterviewSnapshot(
    interview,
    {
      mirrorApplicationArtifacts = true,
      allowLegacyArtifactContextFallback = false,
      preserveArtifactTimestamps = false,
      allowAssistantStateRollback = false,
    } = {},
  ) {
    const applicationId = cleanId(interview?.applicationId) || cleanId(interview?.id) || crypto.randomUUID();
    let applicationRow = this.db.prepare("SELECT * FROM applications WHERE id = ?").get(applicationId);
    if (!applicationRow) {
      const application = normalizeApplication({
        ...interview,
        id: applicationId,
        applicationStatus: interview?.applicationStatus || interview?.interviewStatus,
      });
      this.upsertApplicationRow(application);
      this.addStatus(application.applicationStatus);
      applicationRow = this.db.prepare("SELECT * FROM applications WHERE id = ?").get(applicationId);
    }
    const application = mapApplication(applicationRow);
    const normalized = normalizeInterview({
      ...interview,
      ...sharedFieldsForInterview(application),
      applicationId,
    });
    this.upsertInterviewRow(normalized);
    this.addStatus(normalized.interviewStatus);
    if (interview.resumeFile?.dataUrl) {
      try {
        this.saveAttachment(normalized.id, interview.resumeFile);
      } catch (error) {
        // A corrupt attachment in an imported backup must not abort the whole import.
        this.logger?.warn?.("store.import_attachment_skipped", {
          interviewId: normalized.id,
          error: { message: error.message },
        });
      }
    }
    this.replaceLines(normalized.id, normalized.lines);
    this.replaceCards(normalized.id, normalized.cards);
    this.replaceQuestions(normalized.id, normalized.askedQuestions);
    this.replaceArtifacts(normalized.id, normalized.artifacts, {
      mirrorApplication: mirrorApplicationArtifacts,
      allowLegacyContextFallback: allowLegacyArtifactContextFallback,
      preserveTimestamps: preserveArtifactTimestamps,
    });
    this.replaceHarnessSessions(normalized.id, normalized.harnessSessions);
    if (isObject(interview.assistantState)) {
      const current = this.getAssistantState(normalized.id);
      const incoming = normalizeAssistantState(interview.assistantState);
      const exists = this.db.prepare("SELECT 1 FROM assistant_states WHERE interview_id = ?").get(normalized.id);
      if (!exists || allowAssistantStateRollback || (
        incoming.revision > current.revision && incoming.processedLineCount >= current.processedLineCount
      )) {
        this.restoreAssistantState(normalized.id, incoming);
      }
    }
  }

  upsertApplicationSnapshot(
    application,
    { allowLegacyArtifactContextFallback = false } = {},
  ) {
    const normalized = normalizeApplication(application);
    this.upsertApplicationRow(normalized);
    this.addStatus(normalized.applicationStatus);
    this.replaceApplicationArtifacts(
      normalized.id,
      Array.isArray(application?.applicationArtifacts)
        ? application.applicationArtifacts
        : Array.isArray(application?.artifacts) ? application.artifacts : [],
      { allowLegacyContextFallback: allowLegacyArtifactContextFallback },
    );
    return normalized;
  }

  upsertApplicationRow(application) {
    const value = normalizeApplication(application);
    this.db.prepare(`
      INSERT INTO applications
        (id, name, created_at, updated_at, application_status, resume_markdown,
         role_markdown, resume_notes_json, selected_jd_id, jd_draft_name, role_short_name)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name=excluded.name, updated_at=excluded.updated_at,
        application_status=excluded.application_status,
        resume_markdown=excluded.resume_markdown, role_markdown=excluded.role_markdown,
        resume_notes_json=excluded.resume_notes_json,
        selected_jd_id=excluded.selected_jd_id, jd_draft_name=excluded.jd_draft_name,
        role_short_name=excluded.role_short_name,
        deleted_at=NULL
    `).run(
      value.id,
      value.name,
      value.createdAt,
      value.updatedAt,
      value.applicationStatus,
      value.resumeMarkdown,
      value.roleMarkdown,
      JSON.stringify(value.resumeNotes),
      value.selectedJdId,
      value.jdDraftName,
      value.roleShortName,
    );
  }

  syncApplicationSharedFields(application) {
    this.db.prepare(`
      UPDATE interviews SET name = ?, interview_status = ?, resume_markdown = ?,
        role_markdown = ?, resume_notes_json = ?, selected_jd_id = ?, jd_draft_name = ?,
        role_short_name = ?
      WHERE application_id = ?
    `).run(
      application.name,
      application.applicationStatus,
      application.resumeMarkdown,
      application.roleMarkdown,
      JSON.stringify(application.resumeNotes),
      application.selectedJdId,
      application.jdDraftName,
      application.roleShortName,
      application.id,
    );
  }

  upsertInterviewRow(interview) {
    const value = normalizeInterview(interview);
    this.db.prepare(`
      INSERT INTO interviews
        (id, application_id, round_order, round_label, round_status, outcome, round_focus,
         name, created_at, updated_at, session_started_at, scheduled_at,
         duration_minutes,
         interview_status, resume_markdown, role_markdown, resume_notes_json,
         selected_jd_id, jd_draft_name, role_short_name,
         last_processed_line_count, speaker_labels_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        application_id=excluded.application_id, round_order=excluded.round_order,
        round_label=excluded.round_label, round_status=excluded.round_status,
        outcome=excluded.outcome, round_focus=excluded.round_focus,
        name=excluded.name, updated_at=excluded.updated_at,
        session_started_at=excluded.session_started_at, scheduled_at=excluded.scheduled_at,
        duration_minutes=excluded.duration_minutes,
        interview_status=excluded.interview_status, resume_markdown=excluded.resume_markdown,
        role_markdown=excluded.role_markdown, resume_notes_json=excluded.resume_notes_json,
        selected_jd_id=excluded.selected_jd_id, jd_draft_name=excluded.jd_draft_name,
        role_short_name=excluded.role_short_name,
        last_processed_line_count=excluded.last_processed_line_count,
        speaker_labels_json=excluded.speaker_labels_json, deleted_at=NULL
    `).run(
      value.id,
      value.applicationId,
      value.roundOrder,
      value.roundLabel,
      value.roundStatus,
      value.outcome,
      value.roundFocus,
      value.name,
      value.createdAt,
      value.updatedAt,
      value.sessionStartedAt || null,
      value.scheduledAt || null,
      value.durationMinutes,
      value.interviewStatus,
      value.resumeMarkdown,
      value.roleMarkdown,
      JSON.stringify(value.resumeNotes),
      value.selectedJdId,
      value.jdDraftName,
      value.roleShortName,
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

  replaceArtifacts(
    interviewId,
    artifacts,
    {
      mirrorApplication = true,
      allowLegacyContextFallback = false,
      preserveTimestamps = false,
    } = {},
  ) {
    this.db.prepare("DELETE FROM interview_artifacts WHERE interview_id = ?").run(interviewId);
    const legacyRoundHandoffExists = artifacts.some(
      (artifact) => cleanSlug(artifact?.kind, 80) === "round-handoff",
    );
    for (const artifact of artifacts) {
      this.upsertArtifact(interviewId, artifact, {
        mirrorApplication,
        allowLegacyContextFallback,
        legacyRoundHandoffExists,
        preserveTimestamps,
      });
    }
  }

  replaceApplicationArtifacts(
    applicationId,
    artifacts,
    { allowLegacyContextFallback = false } = {},
  ) {
    this.db.prepare("DELETE FROM application_artifacts WHERE application_id = ?").run(applicationId);
    for (const artifact of artifacts) {
      this.upsertApplicationArtifact(applicationId, artifact, {
        allowLegacyContextFallback,
      });
    }
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

function normalizeApplication(application) {
  const now = new Date().toISOString();
  return {
    id: cleanId(application?.id) || crypto.randomUUID(),
    name: cleanText(application?.name || application?.candidateName, 160) || "未命名面试",
    createdAt: normalizeDate(application?.createdAt) || now,
    updatedAt: normalizeDate(application?.updatedAt) || now,
    applicationStatus: cleanText(
      application?.applicationStatus || application?.interviewStatus || application?.status,
      24,
    ) || DEFAULT_APPLICATION_STATUS,
    resumeMarkdown: cleanText(application?.resumeMarkdown || application?.resumeAnalysis, 500000),
    roleMarkdown: cleanText(application?.roleMarkdown || application?.jdMarkdown, 500000),
    resumeNotes: Array.isArray(application?.resumeNotes) ? application.resumeNotes : [],
    selectedJdId: cleanText(application?.selectedJdId, 160),
    jdDraftName: cleanText(application?.jdDraftName || application?.jdName, 300),
    roleShortName: cleanText(application?.roleShortName, 40),
  };
}

function hasApplicationStatusField(value) {
  return ["applicationStatus", "interviewStatus", "status"].some(
    (key) => Object.prototype.hasOwnProperty.call(value || {}, key),
  );
}

function requestedApplicationStatus(value) {
  if (!hasApplicationStatusField(value)) return undefined;
  return value.applicationStatus || value.interviewStatus || value.status || "";
}

function assertValidApplicationStatus(value) {
  if (value === undefined) return;
  if (typeof value !== "string" || !normalizeStatusLabel(value)) {
    const error = new Error("应聘流程状态必须是非空文本");
    error.code = "INVALID_APPLICATION_STATUS";
    throw error;
  }
}

function normalizeInterview(interview) {
  const now = new Date().toISOString();
  const roundOrder = normalizeRoundOrder(interview?.roundOrder, 1);
  return {
    id: cleanId(interview?.id) || crypto.randomUUID(),
    applicationId: cleanId(interview?.applicationId) || cleanId(interview?.id) || crypto.randomUUID(),
    roundOrder,
    roundLabel: cleanText(interview?.roundLabel, 80) || (roundOrder === 1 ? "一面" : `第${roundOrder}轮`),
    roundStatus: normalizeRoundStatus(interview?.roundStatus, interview),
    outcome: cleanText(interview?.outcome, 80),
    roundFocus: cleanText(interview?.roundFocus, 500000),
    name: cleanText(interview?.name, 160) || "未命名面试",
    createdAt: normalizeDate(interview?.createdAt) || now,
    updatedAt: normalizeDate(interview?.updatedAt) || now,
    sessionStartedAt: normalizeDate(interview?.sessionStartedAt),
    scheduledAt: normalizeDate(interview?.scheduledAt),
    durationMinutes: requestedInterviewDurationMinutes(interview?.durationMinutes),
    interviewStatus: cleanText(interview?.interviewStatus, 24) || DEFAULT_APPLICATION_STATUS,
    resumeMarkdown: cleanText(interview?.resumeMarkdown, 500000),
    roleMarkdown: cleanText(interview?.roleMarkdown, 500000),
    resumeNotes: Array.isArray(interview?.resumeNotes) ? interview.resumeNotes : [],
    selectedJdId: cleanText(interview?.selectedJdId, 160),
    jdDraftName: cleanText(interview?.jdDraftName, 300),
    roleShortName: cleanText(interview?.roleShortName, 40),
    lines: Array.isArray(interview?.lines) ? interview.lines : [],
    cards: Array.isArray(interview?.cards) ? interview.cards : [],
    askedQuestions: Array.isArray(interview?.askedQuestions) ? interview.askedQuestions : [],
    lastProcessedLineCount: Math.max(0, Number(interview?.lastProcessedLineCount || 0)),
    speakerLabels: isObject(interview?.speakerLabels) ? interview.speakerLabels : {},
    artifacts: Array.isArray(interview?.artifacts) ? interview.artifacts : [],
    harnessSessions: Array.isArray(interview?.harnessSessions) ? interview.harnessSessions : [],
  };
}

function normalizeRoundOrder(value, fallback = 1) {
  const number = Math.trunc(Number(value));
  return number > 0 ? number : Math.max(1, Math.trunc(Number(fallback)) || 1);
}

function normalizeRoundStatus(value, round = {}) {
  const status = cleanText(value, 24);
  if (status) {
    if (!ROUND_STATUSES.has(status)) throw new Error("Invalid round status");
    return status;
  }
  if (round?.interviewStatus === "面试中") return "进行中";
  if (round?.sessionStartedAt || round?.lines?.length || round?.cards?.length) return "已结束";
  return round?.scheduledAt || round?.interviewTime ? "已安排" : "待安排";
}

function sharedFieldsForInterview(application) {
  return {
    name: application.name,
    interviewStatus: application.applicationStatus,
    applicationStatus: application.applicationStatus,
    resumeMarkdown: application.resumeMarkdown,
    roleMarkdown: application.roleMarkdown,
    resumeNotes: application.resumeNotes,
    selectedJdId: application.selectedJdId,
    jdDraftName: application.jdDraftName,
    roleShortName: application.roleShortName,
  };
}

function normalizeStatuses(options, applications, interviews) {
  const result = [];
  const seen = new Set();
  for (const value of [
    ...DEFAULT_STATUSES,
    ...(Array.isArray(options) ? options : []),
    ...(Array.isArray(applications)
      ? applications.map((item) => item.applicationStatus || item.interviewStatus)
      : []),
    ...(Array.isArray(interviews) ? interviews.map((item) => item.interviewStatus) : []),
  ]) {
    const status = cleanText(value, 24);
    if (status && !seen.has(status)) {
      seen.add(status);
      result.push(status);
    }
  }
  return result;
}

function requestedInterviewDurationMinutes(value) {
  if (value === undefined) {
    return DEFAULT_INTERVIEW_DURATION_MINUTES;
  }
  if (!isValidInterviewDurationMinutes(value)) {
    throw new Error(
      `面试时长必须是 ${MIN_INTERVIEW_DURATION_MINUTES}–${MAX_INTERVIEW_DURATION_MINUTES} 之间的整数分钟`,
    );
  }
  return value;
}

function resolveArtifactContextFlag({
  artifact,
  existing,
  kind,
  scope,
  allowLegacyContextFallback,
  legacyRoundHandoffExists = false,
}) {
  if (Object.prototype.hasOwnProperty.call(artifact || {}, "includeInCrossRoundContext")) {
    if (typeof artifact.includeInCrossRoundContext !== "boolean") {
      throw new Error("includeInCrossRoundContext must be a boolean");
    }
    return artifact.includeInCrossRoundContext;
  }
  if (existing) return Boolean(existing.include_in_cross_round_context);
  if (LEGACY_KNOWN_ARTIFACT_KINDS.has(kind)) {
    if (scope === "application") return LEGACY_APPLICATION_CONTEXT_KINDS.has(kind);
    if (kind === "round-handoff") return true;
    if (kind === "interview-summary") return !legacyRoundHandoffExists;
    return false;
  }
  if (allowLegacyContextFallback) return false;
  throw new Error("新产物类型必须明确设置 includeInCrossRoundContext");
}

function artifactContentSignature(artifact) {
  return JSON.stringify([
    artifact.kind,
    artifact.title,
    artifact.markdown,
    artifact.sourceHarness,
    artifact.sourceSessionId,
  ]);
}

function buildApplicationArtifactContextPolicy(artifacts) {
  const includedArtifacts = artifacts.filter(
    (artifact) => artifact.includeInCrossRoundContext,
  );
  return {
    includedArtifacts,
    authoritativeKinds: new Set(
      artifacts
        .filter((artifact) => LEGACY_MIRRORED_APPLICATION_ARTIFACT_KINDS.has(artifact.kind))
        .map((artifact) => artifact.kind),
    ),
    includedSignatures: new Set(includedArtifacts.map(artifactContentSignature)),
  };
}

function isRoundArtifactShadowed(artifact, applicationPolicy) {
  return (
    applicationPolicy.authoritativeKinds.has(artifact.kind) ||
    applicationPolicy.includedSignatures.has(artifactContentSignature(artifact))
  );
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

function nonnegativeInteger(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : 0;
}

function positiveInteger(value, fallback) {
  return nonnegativeInteger(value) || fallback;
}

function normalizeAssistantState(state) {
  const value = isObject(state) ? state : {};
  const evidenceIds = (items) => Array.isArray(items)
    ? [...new Set(items.map((item) => cleanText(item, 1000)).filter(Boolean))]
    : [];
  return {
    revision: nonnegativeInteger(value.revision),
    processedLineCount: nonnegativeInteger(value.processedLineCount),
    updatedAt: normalizeDate(value.updatedAt) || null,
    topics: (Array.isArray(value.topics) ? value.topics : []).filter(isObject).map((topic) => ({
      id: cleanText(topic.id, 160) || crypto.randomUUID(),
      title: cleanText(topic.title, 4000),
      origin: topic.origin === "emergent" ? "emergent" : "outline",
      summary: cleanText(topic.summary, 50000),
      status: ["unasked", "answering", "partial", "covered"].includes(topic.status) ? topic.status : "unasked",
      qas: (Array.isArray(topic.qas) ? topic.qas : []).filter(isObject).map((qa) => ({
        id: cleanText(qa.id, 160) || crypto.randomUUID(),
        question: cleanText(qa.question, 50000),
        answer: cleanText(qa.answer, 100000),
        status: ["answering", "partial", "answered"].includes(qa.status) ? qa.status : "partial",
        evidenceLineIds: evidenceIds(qa.evidenceLineIds),
        gap: cleanText(qa.gap, 20000),
      })),
    })),
    followups: (Array.isArray(value.followups) ? value.followups : []).filter(isObject).map((item) => ({
      id: cleanText(item.id, 160) || crypto.randomUUID(),
      topicId: cleanText(item.topicId, 160),
      ...(item.qaId ? { qaId: cleanText(item.qaId, 160) } : {}),
      question: cleanText(item.question, 50000),
      evidenceLineIds: evidenceIds(item.evidenceLineIds),
    })),
  };
}

function mapAssistantJob(row) {
  return {
    id: row.id,
    interviewId: row.interview_id,
    mode: row.mode,
    idempotencyKey: row.idempotency_key,
    status: row.status,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    payload: parseJson(row.payload_json, {}),
    ...(row.result_json ? { result: parseJson(row.result_json, null) } : {}),
    error: row.error || undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
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
    applicationId: row.application_id,
    name: row.name,
    type: row.type,
    size: row.size,
    url: `/api/attachments/${encodeURIComponent(row.id)}`,
    previewText: row.preview_text,
    updatedAt: row.updated_at,
  };
}

function mapApplication(row) {
  return {
    id: row.id,
    name: row.name,
    applicationStatus: row.application_status,
    interviewStatus: row.application_status,
    resumeMarkdown: row.resume_markdown,
    roleMarkdown: row.role_markdown,
    resumeNotes: parseJson(row.resume_notes_json, []),
    selectedJdId: row.selected_jd_id,
    jdDraftName: row.jd_draft_name,
    roleShortName: row.role_short_name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapJd(row) {
  return {
    id: row.id,
    name: row.name,
    shortName: row.short_name,
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
    includeInCrossRoundContext: Boolean(row.include_in_cross_round_context),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapApplicationArtifact(row) {
  return {
    id: row.id,
    applicationId: row.application_id,
    kind: row.kind,
    title: row.title,
    markdown: row.markdown,
    sourceHarness: row.source_harness,
    sourceSessionId: row.source_session_id,
    includeInCrossRoundContext: Boolean(row.include_in_cross_round_context),
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

const DOCX_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const OLE_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

function sniffResumeFormat(data) {
  if (data.length < 8) return null;
  if (data.subarray(0, 4).toString("latin1") === "%PDF") {
    return { extension: ".pdf", type: "application/pdf" };
  }
  if (data[0] === 0x50 && data[1] === 0x4b && data[2] === 0x03 && data[3] === 0x04) {
    return { extension: ".docx", type: DOCX_TYPE };
  }
  if (OLE_MAGIC.every((byte, index) => data[index] === byte)) {
    return { extension: ".doc", type: "application/msword" };
  }
  // Many legacy “.doc” resumes are RTF; word-extractor can preview them.
  if (data.subarray(0, 5).toString("latin1") === "{\\rtf") {
    return { extension: ".doc", type: "application/msword" };
  }
  return null;
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

function normalizeStatusColor(value) {
  return STATUS_COLORS.has(value) ? value : "";
}

function artifactTitle(kind) {
  return {
    "resume-screening": "Resume screening",
    "interview-preparation": "Interview preparation",
    "interview-summary": "Interview summary",
    "round-handoff": "Round handoff",
    "process-brief": "Application process brief",
    "application-handoff": "Application handoff",
    "final-summary": "Final hiring summary",
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

function assertImportableStore(store, message = "保存数据格式无效") {
  if (!isObject(store) || !Array.isArray(store.interviews)) {
    throw Object.assign(new Error(message), { code: "INVALID_STORE_FORMAT" });
  }
}

function safeUnlink(file) {
  try {
    fs.unlinkSync(file);
  } catch {
    // Missing files are already removed.
  }
}

function trySetPrivateMode(file, mode = 0o600) {
  try {
    fs.chmodSync(file, mode);
  } catch {
    // Some platforms do not implement POSIX permissions.
  }
}

function jobPlaceholder(job) {
  if (job.status === "retrying") return `网络不稳定，正在重试...（${job.attempts}/${job.maxAttempts}）`;
  if (job.status === "running") return `正在分析...（${job.attempts}/${job.maxAttempts}）`;
  return "等待分析...";
}
