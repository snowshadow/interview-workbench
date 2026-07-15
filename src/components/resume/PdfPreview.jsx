import { useEffect, useRef, useState } from "react";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { FileText } from "lucide-react";
import { getApiHeaders } from "../../api.js";
import { dataUrlToUint8Array, resumeFileSource } from "../../lib/resume-files.js";
import { ResumeMarkerLayer } from "./ResumeMarkerLayer.jsx";

export function PdfPreview({ file, markerProps, zoom }) {
  const containerRef = useRef(null);
  const [pages, setPages] = useState([]);
  const [availableWidth, setAvailableWidth] = useState(0);
  const [pdfError, setPdfError] = useState("");

  useEffect(() => {
    const node = containerRef.current;
    if (!node) return undefined;

    let frame = 0;
    function updateWidth() {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        setAvailableWidth(Math.max(260, node.clientWidth));
      });
    }

    updateWidth();
    const observer = new ResizeObserver(updateWidth);
    observer.observe(node);
    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, []);

  useEffect(() => {
    if (!resumeFileSource(file)) return undefined;

    let cancelled = false;
    let loadingTask = null;

    setPages([]);
    setPdfError("");

    async function loadPdf() {
      const pdfjsLib = await import("pdfjs-dist");
      pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
      if (cancelled) return;

      loadingTask = pdfjsLib.getDocument(
        file.dataUrl
          ? { data: dataUrlToUint8Array(file.dataUrl), disableWorker: true }
          : { url: file.url, httpHeaders: getApiHeaders(), disableWorker: true },
      );

      const pdf = await loadingTask.promise;
      const loadedPages = [];
      for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
        if (cancelled) return;
        loadedPages.push(await pdf.getPage(pageNumber));
      }
      if (!cancelled) setPages(loadedPages);
    }

    loadPdf()
      .catch((error) => {
        console.error("[pdf-preview]", error);
        if (!cancelled) setPdfError("PDF 预览失败，可先下载查看");
      });

    return () => {
      cancelled = true;
      loadingTask?.destroy();
    };
  }, [file?.dataUrl, file?.url]);

  return (
    <div className="pdf-preview-viewport" ref={containerRef}>
      <div className="pdf-preview-pages">
        {pdfError ? (
          <div className="resume-file-placeholder">
            <FileText size={28} />
            <p>{pdfError}</p>
            <a href={resumeFileSource(file)} download={file.name}>
              下载查看
            </a>
          </div>
        ) : null}
        {!pdfError && !pages.length ? <div className="pdf-loading">正在加载 PDF</div> : null}
        {!pdfError
          ? pages.map((page) => (
              <PdfPageCanvas
                availableWidth={availableWidth}
                key={page.pageNumber}
                markerProps={markerProps}
                page={page}
                zoom={zoom}
              />
            ))
          : null}
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

export function PdfPageCanvas({ page, availableWidth, markerProps, zoom }) {
  const canvasRef = useRef(null);

  useEffect(() => {
    if (!page || !availableWidth || !canvasRef.current) return undefined;

    const baseViewport = page.getViewport({ scale: 1 });
    const targetWidth = Math.max(260, (availableWidth - 34) * zoom);
    const scale = targetWidth / baseViewport.width;
    const viewport = page.getViewport({ scale });
    const pixelRatio = Math.min(2, window.devicePixelRatio || 1);
    const canvas = canvasRef.current;
    const context = canvas.getContext("2d");

    canvas.width = Math.floor(viewport.width * pixelRatio);
    canvas.height = Math.floor(viewport.height * pixelRatio);
    canvas.style.width = `${Math.floor(viewport.width)}px`;
    canvas.style.height = `${Math.floor(viewport.height)}px`;

    const renderContext = {
      canvasContext: context,
      viewport,
    };
    if (pixelRatio !== 1) {
      renderContext.transform = [pixelRatio, 0, 0, pixelRatio, 0, 0];
    }

    const renderTask = page.render(renderContext);
    renderTask.promise.catch(() => {});

    return () => {
      renderTask.cancel();
    };
  }, [availableWidth, page, zoom]);

  return (
    <div className="pdf-page">
      <canvas aria-label={`PDF 第 ${page.pageNumber} 页`} ref={canvasRef} />
      <ResumeMarkerLayer
        {...markerProps}
        coordinateMode="page"
        pageNumber={page.pageNumber}
      />
    </div>
  );
}
