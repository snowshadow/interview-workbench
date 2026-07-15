import { Upload, X } from "lucide-react";
import { formatFileSize } from "../../lib/resume-files.js";

export function InterviewFormDialog({
  form,
  jdLibrary,
  onChange,
  onClose,
  onResumeFileChange,
  onSelectJd,
  onSubmit,
  statusOptions,
  submitting = false,
}) {
  const isCreate = form.mode === "create";

  return (
    <div
      className="dialog-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <form
        className="interview-form-dialog"
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
      >
        <div className="dialog-header">
          <div>
            <h2>{isCreate ? "新建面试" : "编辑面试资料"}</h2>
            <p>{isCreate ? "一次填好候选人与面试准备信息" : "修改当前场次的资料与准备内容"}</p>
          </div>
          <button className="icon-button" type="button" onClick={onClose} title="关闭" aria-label="关闭">
            <X size={18} />
          </button>
        </div>

        <div className="interview-form-body">
          <section className="form-section">
            <h3>基本信息</h3>
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
                <span>面试状态</span>
                <input
                  list="interview-status-options"
                  maxLength={24}
                  placeholder="选择或输入状态"
                  required
                  value={form.interviewStatus}
                  onChange={(event) => onChange({ interviewStatus: event.target.value })}
                />
                <datalist id="interview-status-options">
                  {statusOptions.map((status) => (
                    <option key={status} value={status} />
                  ))}
                </datalist>
              </label>
              <label>
                <span>计划面试时间</span>
                <input
                  type="datetime-local"
                  value={form.scheduledAt}
                  onChange={(event) => onChange({ scheduledAt: event.target.value })}
                />
              </label>
            </div>
          </section>

          <section className="form-section">
            <h3>岗位与 JD</h3>
            <div className="form-grid form-grid-jd">
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
              <span>简历预分析</span>
              <textarea
                value={form.resumeMarkdown}
                onChange={(event) => onChange({ resumeMarkdown: event.target.value })}
                placeholder="粘贴简历预分析 Markdown"
              />
            </label>
          </section>

        </div>

        <div className="dialog-footer">
          <button type="button" onClick={onClose}>
            取消
          </button>
          <button className="primary" type="submit" disabled={submitting}>
            {submitting ? "保存中..." : isCreate ? "创建场次" : "保存修改"}
          </button>
        </div>
      </form>
    </div>
  );
}
