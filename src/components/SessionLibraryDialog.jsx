import { useMemo, useState } from "react";
import { Search, X } from "lucide-react";
import {
  compareInterviews,
  formatShortDateTime,
  getInterviewRole,
  inferInterviewStatus,
  interviewStatusTone,
} from "../interview-domain.js";

export function SessionLibraryDialog({
  activeInterviewId,
  interviews,
  onClose,
  onSelect,
  statusOptions,
}) {
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [roleFilter, setRoleFilter] = useState("all");
  const [sortBy, setSortBy] = useState("updated");

  const roles = useMemo(
    () => Array.from(new Set(interviews.map(getInterviewRole))).sort((left, right) =>
      left.localeCompare(right, "zh-CN")),
    [interviews],
  );
  const visibleInterviews = useMemo(() => {
    const keyword = query.trim().toLocaleLowerCase();
    return interviews
      .filter((interview) => {
        const status = interview.interviewStatus || inferInterviewStatus(interview);
        if (statusFilter !== "all" && status !== statusFilter) return false;
        if (roleFilter !== "all" && getInterviewRole(interview) !== roleFilter) return false;
        if (!keyword) return true;
        return [interview.name, getInterviewRole(interview), status]
          .filter(Boolean)
          .some((value) => value.toLocaleLowerCase().includes(keyword));
      })
      .sort((left, right) => compareInterviews(left, right, sortBy));
  }, [interviews, query, roleFilter, sortBy, statusFilter]);

  return (
    <div className="dialog-backdrop" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section className="session-library-dialog" role="dialog" aria-modal="true" aria-label="场次库">
        <div className="dialog-header">
          <div><h2>场次库</h2><p>{visibleInterviews.length} 个场次</p></div>
          <button className="icon-button" onClick={onClose} title="关闭场次库" aria-label="关闭场次库">
            <X size={18} />
          </button>
        </div>
        <div className="session-library-tools">
          <label className="session-search">
            <Search size={17} />
            <input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索候选人" />
          </label>
          <label><span>岗位</span><select value={roleFilter} onChange={(event) => setRoleFilter(event.target.value)}>
            <option value="all">全部岗位</option>
            {roles.map((role) => <option key={role} value={role}>{role}</option>)}
          </select></label>
          <label><span>状态</span><select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}>
            <option value="all">全部状态</option>
            {statusOptions.map((status) => <option key={status} value={status}>{status}</option>)}
          </select></label>
          <label><span>排序</span><select value={sortBy} onChange={(event) => setSortBy(event.target.value)}>
            <option value="updated">最近更新</option><option value="scheduled">面试时间</option>
            <option value="created">创建时间</option><option value="name">姓名</option>
          </select></label>
        </div>
        <div className="session-library-list">
          {visibleInterviews.length ? visibleInterviews.map((interview) => {
            const status = interview.interviewStatus || inferInterviewStatus(interview);
            return <button
              className={`session-row ${interview.id === activeInterviewId ? "selected" : ""}`}
              key={interview.id}
              onClick={() => onSelect(interview.id)}
            >
              <span className="session-row-name">{interview.name || "未命名面试"}</span>
              <span className="session-row-role">{getInterviewRole(interview)}</span>
              <span className={`session-status ${interviewStatusTone(status)}`}>{status}</span>
              <span className="session-row-time">{formatShortDateTime(interview.scheduledAt) || "未安排时间"}</span>
            </button>;
          }) : <div className="session-library-empty">没有符合条件的场次</div>}
        </div>
      </section>
    </div>
  );
}
