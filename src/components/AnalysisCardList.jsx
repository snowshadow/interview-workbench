import { memo } from "react";
import ReactMarkdown from "react-markdown";
import { RotateCcw } from "lucide-react";

export function isPendingAnalyzeCard(card) {
  return ["queued", "running", "retrying", "loading"].includes(card?.status);
}

function cardStatusLabel(card) {
  const labels = {
    queued: "排队中",
    running: "处理中",
    retrying: "重试中",
    done: "Markdown",
    error: "失败",
    loading: "处理中",
  };
  return labels[card.status] || "Markdown";
}

const AnalysisCard = memo(function AnalysisCard({ card, onRetry }) {
  return (
    <article
      className={`ai-card ${
        isPendingAnalyzeCard(card) ? "loading" : card.status
      }`}
    >
      <div className="card-meta">
        <span>{new Date(card.createdAt).toLocaleTimeString()}</span>
        <div>
          <span>{cardStatusLabel(card)}</span>
          {card.status === "error" && card.transcriptSlice ? (
            <button
              className="card-retry"
              onClick={() => onRetry(card)}
              title="重新分析这段转录"
            >
              <RotateCcw size={13} />
              重试
            </button>
          ) : null}
        </div>
      </div>
      <ReactMarkdown>{card.markdown}</ReactMarkdown>
    </article>
  );
});

export function AnalysisCardList({ cards, onRetry }) {
  return (
    <div className="cards-list">
      {cards.length === 0 ? <div className="empty">等待第一次处理</div> : null}
      {cards.map((card) => (
        <AnalysisCard card={card} key={card.id} onRetry={onRetry} />
      ))}
    </div>
  );
}
