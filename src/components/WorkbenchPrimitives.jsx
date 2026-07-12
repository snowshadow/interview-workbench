export function PanelTitle({ icon, title, children }) {
  return (
    <div className="panel-title">
      <div className="panel-title-main">{icon}<h2>{title}</h2></div>
      {children ? <div className="panel-title-actions">{children}</div> : null}
    </div>
  );
}

export function StatusPill({ health }) {
  if (!health) return <span className="pill">检查中</span>;
  const ready = health.asrConfigured && health.llmConfigured;
  return <span className={`pill ${ready ? "ready" : "warn"}`}>{ready ? "已配置" : "待配置"}</span>;
}

export function TranscriptLine({ line, speakerLabels, processed }) {
  const label = line.speaker ? speakerLabels[line.speaker] || `说话人 ${line.speaker}` : "转录";
  return (
    <div className={`line ${processed ? "processed" : ""}`}>
      <div className="line-meta">
        <span>{label}</span>
        {Number.isFinite(line.startTime) ? <span>{formatMs(line.startTime)}</span> : null}
      </div>
      <div className="line-text">{line.text}</div>
    </div>
  );
}

function formatMs(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = String(Math.floor(totalSeconds / 60)).padStart(2, "0");
  const seconds = String(totalSeconds % 60).padStart(2, "0");
  return `${minutes}:${seconds}`;
}
