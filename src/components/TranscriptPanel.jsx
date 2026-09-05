import { useEffect, useMemo, useState } from "react";
import { Maximize2, Mic, Minimize2, Pencil } from "lucide-react";
import { PanelTitle, TranscriptLine } from "./WorkbenchPrimitives.jsx";

export function TranscriptPanel({
  focused,
  onToggleFocus,
  lastProcessedLineCount,
  lines,
  onSpeakerLabelChange,
  onToggleSpeakerEditor,
  partialTextBridge,
  speakerEditorOpen,
  speakerLabels,
}) {
  const [partialText, setPartialText] = useState(() => partialTextBridge.get());

  useEffect(() => {
    setPartialText(partialTextBridge.get());
    return partialTextBridge.subscribe(setPartialText);
  }, [partialTextBridge]);

  const seenSpeakers = useMemo(() => {
    return Array.from(new Set(lines.map((line) => line.speaker).filter(Boolean)));
  }, [lines]);

  return (
    <section className={`transcript pane compact-transcript ${focused ? "panel-focus-mode" : ""}`}>
      <PanelTitle icon={<Mic size={18} />} title="实时转录">
        {seenSpeakers.length ? (
          <button
            className={speakerEditorOpen ? "icon-button primary" : "icon-button"}
            onClick={onToggleSpeakerEditor}
            title="编辑说话人名称"
            aria-label="编辑说话人名称"
          >
            <Pencil size={16} />
          </button>
        ) : null}
        <button className="icon-button" onClick={onToggleFocus}
          aria-label={focused ? "退出转录专注模式" : "最大化实时转录"} title={focused ? "退出转录专注模式" : "最大化实时转录"}>
          {focused ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
        </button>
      </PanelTitle>
      {speakerEditorOpen ? (
        <div className="speaker-inline-editor">
          {seenSpeakers.map((speaker) => (
            <label key={speaker}>
              <span>说话人 {speaker}</span>
              <input
                value={speakerLabels[speaker] || ""}
                onChange={(event) => onSpeakerLabelChange(speaker, event.target.value)}
                placeholder={`默认显示为说话人 ${speaker}`}
              />
            </label>
          ))}
        </div>
      ) : null}
      <div className="transcript-list">
        {lines.length === 0 && !partialText ? (
          <div className="empty">开始面试后，转录会显示在这里</div>
        ) : null}
        {partialText ? (
          <div className="line partial">
            <div className="line-meta">正在识别</div>
            <div className="line-text">{partialText}</div>
          </div>
        ) : null}
        {lines
          .map((line, index) => ({ line, index }))
          .reverse()
          .map(({ line, index }) => (
            <TranscriptLine
              key={line.id}
              line={line}
              speakerLabels={speakerLabels}
              processed={index < lastProcessedLineCount}
            />
          ))}
      </div>
    </section>
  );
}
