import { useEffect, useRef, useState } from "react";
import { clampNumber } from "../../lib/format.js";
import { ResumeMarkerLayer } from "./ResumeMarkerLayer.jsx";
import { handleDocumentPointerUp } from "../../lib/resume-annotations.js";

export function DocxPreview({ file, markerProps, zoom }) {
  const containerRef = useRef(null);
  const [availableWidth, setAvailableWidth] = useState(0);

  useEffect(() => {
    const node = containerRef.current;
    if (!node) return undefined;
    let frame = 0;
    function updateWidth() {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => setAvailableWidth(node.clientWidth));
    }
    updateWidth();
    const observer = new ResizeObserver(updateWidth);
    observer.observe(node);
    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, []);

  const fitScale = availableWidth ? Math.min(1, Math.max(0.1, (availableWidth - 36) / 794)) : 1;
  const scale = clampNumber(fitScale * zoom, 0.1, 2);

  return (
    <div className="docx-preview-viewport" ref={containerRef}>
      <div className={`docx-preview-canvas ${markerProps.markMode ? "annotation-marking" : ""}`} style={{ zoom: scale }}
        onPointerUp={(event) => handleDocumentPointerUp(event, markerProps, "document")}>
        <pre>{file.previewText}</pre>
        <ResumeMarkerLayer {...markerProps} coordinateMode="document" />
        <ResumeMarkerLayer
          {...markerProps}
          coordinateMode="content"
          markMode={false}
          noteDraft={null}
        />
      </div>
    </div>
  );
}
