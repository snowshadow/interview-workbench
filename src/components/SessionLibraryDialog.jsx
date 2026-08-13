import { useMemo, useState } from "react";
import { Search, X } from "lucide-react";
import {
  compareApplications,
  formatShortDateTime,
  getApplicationRole,
  interviewStatusTone,
  preferredRoundForApplication,
  roundLabelFor,
  roundsForApplication,
} from "../interview-domain.js";

export function SessionLibraryDialog({
  activeInterviewId,
  applications,
  interviews,
  onClose,
  onSelect,
  statusColors,
  statusOptions,
}) {
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [roleFilter, setRoleFilter] = useState("all");
  const [sortBy, setSortBy] = useState("updated");
  const activeApplicationId = interviews.find((item) => item.id === activeInterviewId)?.applicationId;

  const roles = useMemo(
    () => Array.from(new Set(applications.map(getApplicationRole))).sort((left, right) =>
      left.localeCompare(right, "zh-CN")),
    [applications],
  );
  const visibleApplications = useMemo(() => {
    const keyword = query.trim().toLocaleLowerCase();
    return applications
      .filter((application) => {
        const status = application.applicationStatus || "招聘中";
        const rounds = roundsForApplication(interviews, application.id);
        if (statusFilter !== "all" && status !== statusFilter) return false;
        if (roleFilter !== "all" && getApplicationRole(application) !== roleFilter) return false;
        if (!keyword) return true;
        return [
          application.name,
          getApplicationRole(application),
          status,
          ...rounds.flatMap((round) => [roundLabelFor(round), round.roundFocus]),
        ]
          .filter(Boolean)
          .some((value) => value.toLocaleLowerCase().includes(keyword));
      })
      .sort((left, right) => compareApplications(left, right, sortBy, interviews));
  }, [applications, interviews, query, roleFilter, sortBy, statusFilter]);

  return (
    <div className="dialog-backdrop" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section className="session-library-dialog" role="dialog" aria-modal="true" aria-label="面试流程库">
        <div className="dialog-header">
          <div><h2>面试流程库</h2><p>{visibleApplications.length} 个应聘流程</p></div>
          <button className="icon-button" onClick={onClose} title="关闭面试流程库" aria-label="关闭面试流程库">
            <X size={18} />
          </button>
        </div>
        <div className="session-library-tools">
          <label className="session-search">
            <Search size={17} />
            <input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索候选人或轮次" />
          </label>
          <label><span>岗位</span><select value={roleFilter} onChange={(event) => setRoleFilter(event.target.value)}>
            <option value="all">全部岗位</option>
            {roles.map((role) => <option key={role} value={role}>{role}</option>)}
          </select></label>
          <label><span>流程状态</span><select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}>
            <option value="all">全部状态</option>
            {statusOptions.map((status) => <option key={status} value={status}>{status}</option>)}
          </select></label>
          <label><span>排序</span><select value={sortBy} onChange={(event) => setSortBy(event.target.value)}>
            <option value="updated">最近更新</option><option value="scheduled">下轮时间</option>
            <option value="created">创建时间</option><option value="name">姓名</option>
          </select></label>
        </div>
        <div className="session-library-list">
          {visibleApplications.length ? visibleApplications.map((application) => {
            const rounds = roundsForApplication(interviews, application.id);
            const preferredRound = preferredRoundForApplication(interviews, application.id);
            const status = application.applicationStatus || "招聘中";
            return <button
              className={`session-row application-row ${application.id === activeApplicationId ? "selected" : ""}`}
              disabled={!preferredRound}
              key={application.id}
              onClick={() => preferredRound && onSelect(preferredRound.id)}
            >
              <span className="session-row-name">{application.name || "未命名候选人"}</span>
              <span className="session-row-role">{getApplicationRole(application)}</span>
              <span className={`session-status ${interviewStatusTone(status, statusColors)}`}>{status}</span>
              <span className="session-row-rounds">
                {rounds.length} 轮{preferredRound ? ` · ${roundLabelFor(preferredRound)}` : ""}
              </span>
              <span className="session-row-time">
                {formatShortDateTime(preferredRound?.scheduledAt) || "下轮未安排"}
              </span>
            </button>;
          }) : <div className="session-library-empty">没有符合条件的面试流程</div>}
        </div>
      </section>
    </div>
  );
}
