import { useEffect, useMemo, useState } from "react";
import {
  CalendarPlus,
  ChevronLeft,
  ChevronRight,
  Clock3,
  X,
} from "lucide-react";
import {
  addLocalDays,
  addLocalMonths,
  localDayKey,
  monthCalendarDays,
  sameLocalDay,
  scheduledInterviewEndDate,
  scheduledInterviews,
  startOfLocalDay,
  startOfLocalWeek,
} from "../lib/calendar.js";
import {
  getInterviewRole,
  getInterviewRoleLabel,
  inferRoundStatus,
  resolveInterviewDurationMinutes,
  roundDisplayName,
  roundLabelFor,
  roundStatusTone,
} from "../interview-domain.js";

const WEEKDAYS = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];
const HOUR_HEIGHT = 58;

export function InterviewCalendarDialog({
  interviews,
  onClose,
  onSync,
}) {
  const [view, setView] = useState("week");
  const [anchorDate, setAnchorDate] = useState(() => startOfLocalDay(new Date()));
  const [selectedId, setSelectedId] = useState("");
  const [syncState, setSyncState] = useState(null);

  const entries = useMemo(() => scheduledInterviews(interviews), [interviews]);
  const unscheduledCount = interviews.length - entries.length;
  const selectedEntry = entries.find(({ interview }) => interview.id === selectedId) || null;

  useEffect(() => {
    function handleEscape(event) {
      if (event.key !== "Escape") return;
      if (selectedId) setSelectedId("");
      else onClose();
    }
    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [onClose, selectedId]);

  function moveRange(direction) {
    setSelectedId("");
    setSyncState(null);
    setAnchorDate((current) =>
      view === "week"
        ? addLocalDays(current, direction * 7)
        : addLocalMonths(current, direction),
    );
  }

  function selectInterview(interviewId) {
    setSelectedId(interviewId);
    setSyncState(null);
  }

  async function syncSelectedInterview() {
    if (!selectedEntry) return;
    setSyncState({ status: "syncing", message: "" });
    try {
      const result = await onSync(selectedEntry.interview);
      setSyncState({
        status: "success",
        message:
          result?.action === "opened"
            ? "已打开系统日历，请确认添加"
            : "日历文件已下载，请打开后确认添加",
      });
    } catch (error) {
      setSyncState({
        status: "error",
        message: error.message || "同步失败，请稍后重试",
      });
    }
  }

  const subtitle = entries.length
    ? `${entries.length} 轮已安排${unscheduledCount ? ` · ${unscheduledCount} 轮未排期` : ""}`
    : "暂无已安排面试";

  return (
    <div
      className="dialog-backdrop calendar-dialog-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        aria-label="面试日历"
        aria-modal="true"
        className="interview-calendar-dialog"
        role="dialog"
      >
        <header className="calendar-dialog-header">
          <div className="calendar-heading">
            <h2>{calendarTitle(anchorDate, view)}</h2>
            <p>{subtitle}</p>
          </div>

          <div aria-label="日历视图" className="calendar-view-switcher" role="group">
            <button
              aria-pressed={view === "week"}
              className={view === "week" ? "selected" : ""}
              onClick={() => {
                setView("week");
                setSelectedId("");
              }}
              type="button"
            >
              周
            </button>
            <button
              aria-pressed={view === "month"}
              className={view === "month" ? "selected" : ""}
              onClick={() => {
                setView("month");
                setSelectedId("");
              }}
              type="button"
            >
              月
            </button>
          </div>

          <div className="calendar-navigation">
            <button
              aria-label={view === "week" ? "上一周" : "上个月"}
              className="icon-button"
              onClick={() => moveRange(-1)}
              title={view === "week" ? "上一周" : "上个月"}
              type="button"
            >
              <ChevronLeft size={18} />
            </button>
            <button
              className="calendar-today-button"
              onClick={() => {
                setAnchorDate(startOfLocalDay(new Date()));
                setSelectedId("");
              }}
              type="button"
            >
              今天
            </button>
            <button
              aria-label={view === "week" ? "下一周" : "下个月"}
              className="icon-button"
              onClick={() => moveRange(1)}
              title={view === "week" ? "下一周" : "下个月"}
              type="button"
            >
              <ChevronRight size={18} />
            </button>
            <button
              aria-label="关闭日历"
              className="icon-button calendar-close-button"
              onClick={onClose}
              title="关闭日历"
              type="button"
            >
              <X size={18} />
            </button>
          </div>
        </header>

        {view === "week" ? (
          <WeekCalendar
            anchorDate={anchorDate}
            entries={entries}
            onSelect={selectInterview}
            selectedId={selectedId}
          />
        ) : (
          <MonthCalendar
            anchorDate={anchorDate}
            entries={entries}
            onSelect={selectInterview}
            selectedId={selectedId}
          />
        )}

        {selectedEntry ? (
          <EventInspector
            entry={selectedEntry}
            onClose={() => {
              setSelectedId("");
              setSyncState(null);
            }}
            onSync={syncSelectedInterview}
            syncState={syncState}
          />
        ) : null}
      </section>
    </div>
  );
}

function WeekCalendar({
  anchorDate,
  entries,
  onSelect,
  selectedId,
}) {
  const today = new Date();
  const weekStart = startOfLocalWeek(anchorDate);
  const days = Array.from({ length: 7 }, (_, index) => addLocalDays(weekStart, index));
  const weekEnd = addLocalDays(weekStart, 7);
  const visibleEntries = entries.filter(({ date }) => date >= weekStart && date < weekEnd);
  const eventHours = visibleEntries.map(({ date }) => date.getHours() + date.getMinutes() / 60);
  const eventEndHours = visibleEntries.map(({ interview, date }) =>
    date.getHours() + date.getMinutes() / 60 +
      resolveInterviewDurationMinutes(interview.durationMinutes) / 60,
  );
  const startHour = Math.max(0, Math.min(8, ...eventHours.map(Math.floor)));
  const endHour = Math.min(
    24,
    Math.max(20, ...eventEndHours.map(Math.ceil)),
  );
  const hourCount = endHour - startHour;

  return (
    <div className="calendar-week">
      <div className="calendar-week-head">
        <span className="calendar-time-gutter" />
        {days.map((day, index) => (
          <div
            className={`calendar-week-day-heading ${sameLocalDay(day, today) ? "today" : ""}`}
            key={localDayKey(day)}
          >
            <span>{WEEKDAYS[index]}</span>
            <strong>{day.getDate()}</strong>
          </div>
        ))}
      </div>

      <div className="calendar-week-scroll">
        <div
          className="calendar-week-canvas"
          style={{ height: `${hourCount * HOUR_HEIGHT}px` }}
        >
          <div className="calendar-time-axis">
            {Array.from({ length: hourCount }, (_, index) => {
              const hour = startHour + index;
              return (
                <span key={hour} style={{ top: `${index * HOUR_HEIGHT}px` }}>
                  {String(hour).padStart(2, "0")}:00
                </span>
              );
            })}
          </div>

          <div className="calendar-week-columns">
            {days.map((day) => {
              const dayEntries = visibleEntries.filter(({ date }) => sameLocalDay(date, day));
              return (
                <div className="calendar-week-column" key={localDayKey(day)}>
                  {dayEntries.map(({ interview, date }) => {
                    const minutesFromStart =
                      (date.getHours() - startHour) * 60 + date.getMinutes();
                    const durationMinutes = resolveInterviewDurationMinutes(
                      interview.durationMinutes,
                    );
                    const remainingDayMinutes =
                      (24 - date.getHours()) * 60 - date.getMinutes();
                    const visibleDurationMinutes = Math.min(
                      durationMinutes,
                      remainingDayMinutes,
                    );
                    return (
                      <CalendarEventButton
                        interview={interview}
                        isSelected={interview.id === selectedId}
                        key={interview.id}
                        onClick={() => onSelect(interview.id)}
                        style={{
                          height: `${Math.max(
                            26,
                            (visibleDurationMinutes / 60) * HOUR_HEIGHT - 5,
                          )}px`,
                          top: `${(minutesFromStart / 60) * HOUR_HEIGHT + 2}px`,
                        }}
                      />
                    );
                  })}
                </div>
              );
            })}
          </div>

          {!visibleEntries.length ? (
            <div className="calendar-range-empty">
              <CalendarPlus size={22} />
              <span>这一周还没有面试安排</span>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function MonthCalendar({
  anchorDate,
  entries,
  onSelect,
  selectedId,
}) {
  const today = new Date();
  const days = monthCalendarDays(anchorDate);
  const entriesByDay = useMemo(() => {
    const grouped = new Map();
    for (const entry of entries) {
      const key = localDayKey(entry.date);
      grouped.set(key, [...(grouped.get(key) || []), entry]);
    }
    return grouped;
  }, [entries]);

  return (
    <div className="calendar-month">
      <div className="calendar-month-weekdays">
        {WEEKDAYS.map((weekday) => (
          <span key={weekday}>{weekday}</span>
        ))}
      </div>
      <div className="calendar-month-grid">
        {days.map((day) => {
          const dayEntries = entriesByDay.get(localDayKey(day)) || [];
          const outsideMonth = day.getMonth() !== anchorDate.getMonth();
          return (
            <section
              className={`calendar-month-day ${outsideMonth ? "outside-month" : ""} ${
                sameLocalDay(day, today) ? "today" : ""
              }`}
              key={localDayKey(day)}
            >
              <span className="calendar-month-date">{day.getDate()}</span>
              <div className="calendar-month-events">
                {dayEntries.slice(0, 3).map(({ interview, date }) => (
                  <CalendarEventButton
                    compact
                    interview={interview}
                    isSelected={interview.id === selectedId}
                    key={interview.id}
                    onClick={() => onSelect(interview.id)}
                    time={formatTime(date)}
                  />
                ))}
                {dayEntries.length > 3 ? (
                  <span className="calendar-more-events">还有 {dayEntries.length - 3} 场</span>
                ) : null}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}

function CalendarEventButton({
  compact = false,
  interview,
  isSelected,
  onClick,
  style,
  time,
}) {
  const status = inferRoundStatus(interview);
  const displayName = roundDisplayName(interview);
  const roleLabel = getInterviewRoleLabel(interview);
  return (
    <button
      aria-label={`${formatTime(new Date(interview.scheduledAt))} ${displayName} ${roleLabel}`}
      className={`calendar-event ${compact ? "compact" : ""} ${
        isSelected ? "selected" : ""
      } tone-${roundStatusTone(status)}`}
      onClick={onClick}
      style={style}
      title={`${displayName} · ${getInterviewRole(interview)}`}
      type="button"
    >
      {compact ? (
        <>
          <span className="calendar-event-time">{time}</span>
          <span className="calendar-event-name">{displayName}</span>
          <span className="calendar-event-role-tag">{roleLabel}</span>
        </>
      ) : (
        <>
          <strong>{displayName}</strong>
          <span className="calendar-event-meta">
            <span className="calendar-event-time">
              {formatTime(new Date(interview.scheduledAt))}
            </span>
            <span className="calendar-event-role-tag">{roleLabel}</span>
          </span>
        </>
      )}
    </button>
  );
}

function EventInspector({ entry, onClose, onSync, syncState }) {
  const { interview, date } = entry;
  const status = inferRoundStatus(interview);
  const syncing = syncState?.status === "syncing";
  const durationMinutes = resolveInterviewDurationMinutes(interview.durationMinutes);
  const endDate = entry.endDate || scheduledInterviewEndDate(interview);

  return (
    <aside className="calendar-event-inspector" aria-label="面试详情">
      <div className="calendar-inspector-head">
        <div>
          <span className={`session-status ${roundStatusTone(status)}`}>
            {status}
          </span>
          <h3>{interview.name || "未命名候选人"} · {roundLabelFor(interview)}</h3>
        </div>
        <button
          aria-label="关闭面试详情"
          className="icon-button"
          onClick={onClose}
          title="关闭详情"
          type="button"
        >
          <X size={16} />
        </button>
      </div>
      <p className="calendar-inspector-role">{getInterviewRole(interview)}</p>
      <p className="calendar-inspector-time">
        <Clock3 size={15} />
        {formatFullDateTime(date)} – {formatTime(endDate)}
      </p>
      <button
        className="primary calendar-sync-button"
        disabled={syncing}
        onClick={onSync}
        type="button"
      >
        <CalendarPlus size={17} />
        {syncing ? "正在打开…" : "同步到系统日历"}
      </button>
      {syncState?.message ? (
        <p
          aria-live="polite"
          className={`calendar-sync-message ${syncState.status}`}
          role="status"
        >
          {syncState.message}
        </p>
      ) : (
        <p className="calendar-sync-hint">
          将以 {durationMinutes} 分钟日程打开，由系统日历确认添加。
        </p>
      )}
    </aside>
  );
}

function calendarTitle(anchorDate, view) {
  if (view === "month") {
    return `${anchorDate.getFullYear()}年${anchorDate.getMonth() + 1}月`;
  }
  const start = startOfLocalWeek(anchorDate);
  const end = addLocalDays(start, 6);
  if (
    start.getFullYear() === end.getFullYear() &&
    start.getMonth() === end.getMonth()
  ) {
    return `${start.getFullYear()}年${start.getMonth() + 1}月`;
  }
  if (start.getFullYear() === end.getFullYear()) {
    return `${start.getFullYear()}年${start.getMonth() + 1}月 – ${end.getMonth() + 1}月`;
  }
  return `${start.getFullYear()}年${start.getMonth() + 1}月 – ${end.getFullYear()}年${end.getMonth() + 1}月`;
}

function formatTime(value) {
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    hour12: false,
    minute: "2-digit",
  }).format(value);
}

function formatFullDateTime(value) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "long",
    day: "numeric",
    weekday: "short",
    hour: "2-digit",
    hour12: false,
    minute: "2-digit",
  }).format(value);
}
