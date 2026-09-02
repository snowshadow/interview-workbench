import { Upload, X } from "lucide-react";
import {
  MAX_INTERVIEW_DURATION_MINUTES,
  MIN_INTERVIEW_DURATION_MINUTES,
} from "../../interview-domain.js";
import { formatFileSize } from "../../lib/resume-files.js";

export function InterviewFormDialog({
  form,
  jdLibrary,
  onChange,
  onClose,
  onResumeFileChange,
  onSelectJd,
  onSubmit,
  roundStatusOptions = [],
  statusOptions,
  submitting = false,
}) {
  const isCreateApplication = form.mode === "create-application";
  const isEditApplication = form.mode === "edit-application";
  const isCreateRound = form.mode === "create-round";
  const isRoundOnly = isCreateRound || form.mode === "edit-round";

  const heading = isCreateApplication
    ? "新建面试流程"
    : isEditApplication
      ? "编辑应聘流程"
      : isCreateRound
        ? "安排下一轮"
        : "编辑当前轮次";
  const subtitle = isCreateApplication
    ? "建立候选人流程，并顺带安排首轮"
    : isEditApplication
      ? "修改各轮共享的候选人、岗位与流程状态"
      : isCreateRound
        ? "简单设定轮次、时间和本轮重点"
        : "修改当前轮次，不影响候选人共享资料";

  return (
    <div
      className="dialog-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <form
        className={`interview-form-dialog ${isRoundOnly ? "round-form-dialog" : ""}`}
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
      >
        <div className="dialog-header">
          <div>
            <h2>{heading}</h2>
            <p>{subtitle}</p>
          </div>
          <button className="icon-button" type="button" onClick={onClose} title="关闭" aria-label="关闭">
            <X size={18} />
          </button>
        </div>

        {isRoundOnly ? (
          <RoundFields
            autoFocus
            form={form}
            includeLifecycle={!isCreateRound}
            onChange={onChange}
            roundStatusOptions={roundStatusOptions}
          />
        ) : (
          <div className="interview-form-body">
            <section className="form-section">
              <h3>流程信息</h3>
              <div className="form-grid form-grid-basic">
                <label>
                  <span>候选人姓名</span>
                  <input
                    autoFocus
                    required
                    value={form.name}
                    onChange={(event) => onChange({ name: event.target.value })}
                    placeholder="例如：张宇"
                  />
                </label>
                <label>
                  <span>应聘流程状态</span>
                  <input
                    list="application-status-options"
                    maxLength={24}
                    placeholder="选择或输入状态"
                    required
                    value={form.applicationStatus}
                    onChange={(event) => onChange({ applicationStatus: event.target.value })}
                  />
                  <datalist id="application-status-options">
                    {statusOptions.map((status) => (
                      <option key={status} value={status} />
                    ))}
                  </datalist>
                </label>
              </div>
            </section>

            {isCreateApplication ? (
              <section className="form-section">
                <h3>首轮面试</h3>
                <RoundFields
                  form={form}
                  onChange={onChange}
                  roundStatusOptions={roundStatusOptions}
                />
              </section>
            ) : null}

            <section className="form-section">
              <h3>岗位与 JD</h3>
              <div className="form-grid form-grid-role">
                <label>
                  <span>已保存 JD</span>
                  <select value={form.selectedJdId} onChange={(event) => onSelectJd(event.target.value)}>
                    <option value="">新建或不关联 JD</option>
                    {jdLibrary.map((jd) => (
                      <option key={jd.id} value={jd.id}>
                        {jd.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>岗位名称</span>
                  <input
                    value={form.jdDraftName}
                    onChange={(event) => onChange({ jdDraftName: event.target.value })}
                    placeholder="例如：大模型应用研发工程师"
                  />
                </label>
                <label>
                  <span>岗位简称</span>
                  <input
                    maxLength={40}
                    value={form.roleShortName}
                    onChange={(event) => onChange({ roleShortName: event.target.value })}
                    placeholder="例如：评测"
                  />
                </label>
              </div>
              <label>
                <span>岗位 JD / 能力要求</span>
                <textarea
                  value={form.roleMarkdown}
                  onChange={(event) => onChange({ roleMarkdown: event.target.value })}
                  placeholder="粘贴岗位 JD 或能力要求 Markdown"
                />
              </label>
              <label className="checkbox-field">
                <input
                  type="checkbox"
                  checked={form.saveJdToLibrary}
                  onChange={(event) => onChange({ saveJdToLibrary: event.target.checked })}
                />
                <span>将本次 JD 保存或同步到 JD 库</span>
              </label>
            </section>

            <section className="form-section">
              <h3>候选人准备</h3>
              <div className="resume-upload-field">
                <div>
                  <span>简历附件</span>
                  <p>
                    {form.resumeFile
                      ? `${form.resumeFile.name} · ${formatFileSize(form.resumeFile.size)}`
                      : "尚未上传"}
                  </p>
                </div>
                <div className="resume-upload-actions">
                  <input
                    className="file-input"
                    id="interview-form-resume-upload"
                    type="file"
                    accept=".pdf,.doc,.docx,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                    onChange={onResumeFileChange}
                  />
                  <label className="file-button" htmlFor="interview-form-resume-upload">
                    <Upload size={16} />
                    {form.resumeFile ? "替换" : "上传"}
                  </label>
                  {form.resumeFile ? (
                    <button
                      type="button"
                      className="icon-button"
                      title="移除简历"
                      aria-label="移除简历"
                      onClick={() => onChange({ resumeFile: null, resumeFileChanged: true })}
                    >
                      <X size={17} />
                    </button>
                  ) : null}
                </div>
              </div>
              <label>
                <span>面试准备 / 提纲</span>
                <textarea
                  value={form.resumeMarkdown}
                  onChange={(event) => onChange({ resumeMarkdown: event.target.value })}
                  placeholder="粘贴简历分析或面试提纲 Markdown"
                />
              </label>
            </section>
          </div>
        )}

        <div className="dialog-footer">
          <button type="button" onClick={onClose}>
            取消
          </button>
          <button className="primary" type="submit" disabled={submitting}>
            {submitting
              ? "保存中..."
              : isCreateApplication
                ? "创建流程"
                : isCreateRound
                  ? "安排下一轮"
                  : "保存修改"}
          </button>
        </div>
      </form>
    </div>
  );
}

function RoundFields({
  autoFocus = false,
  form,
  includeLifecycle = false,
  onChange,
  roundStatusOptions,
}) {
  return (
    <div className={includeLifecycle ? "interview-form-body round-form-body" : "round-fields"}>
      <div className="form-grid form-grid-round">
        <label>
          <span>轮次名称</span>
          <input
            autoFocus={autoFocus}
            required
            value={form.roundLabel}
            onChange={(event) => onChange({ roundLabel: event.target.value })}
            placeholder="例如：二面 / 技术加面"
          />
        </label>
        <label>
          <span>面试时间</span>
          <input
            type="datetime-local"
            value={form.scheduledAt}
            onChange={(event) => onChange({ scheduledAt: event.target.value })}
          />
        </label>
        <label>
          <span>计划时长（分钟）</span>
          <input
            max={MAX_INTERVIEW_DURATION_MINUTES}
            min={MIN_INTERVIEW_DURATION_MINUTES}
            required
            step="1"
            type="number"
            value={form.durationMinutes}
            onChange={(event) => onChange({ durationMinutes: event.target.value })}
          />
        </label>
        {includeLifecycle ? (
          <label>
            <span>轮次状态</span>
            <select
              value={form.roundStatus}
              onChange={(event) => onChange({ roundStatus: event.target.value })}
            >
              {roundStatusOptions.map((status) => <option key={status} value={status}>{status}</option>)}
            </select>
          </label>
        ) : null}
        {includeLifecycle ? (
          <label>
            <span>本轮结果（不改变流程状态）</span>
            <input
              list="round-outcome-options"
              maxLength={24}
              value={form.outcome}
              onChange={(event) => onChange({ outcome: event.target.value })}
              placeholder="例如：通过 / 待定"
            />
            <datalist id="round-outcome-options">
              <option value="通过" />
              <option value="待定" />
              <option value="未通过" />
            </datalist>
          </label>
        ) : null}
      </div>
      <label className="round-focus-field">
        <span>本轮重点</span>
        <textarea
          value={form.roundFocus}
          onChange={(event) => onChange({ roundFocus: event.target.value })}
          placeholder="本轮需要确认的能力、风险或问题"
        />
      </label>
    </div>
  );
}
