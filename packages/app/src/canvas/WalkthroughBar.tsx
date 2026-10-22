import type { WalkthroughStep } from "@codemap/core";
import { Markdown } from "./Markdown";

type Props = {
  step: WalkthroughStep;
  index: number;
  count: number;
  playing: boolean;
  onPrev: () => void;
  onNext: () => void;
  onTogglePlay: () => void;
  onExit: () => void;
};

export function WalkthroughBar({ step, index, count, playing, onPrev, onNext, onTogglePlay, onExit }: Props) {
  return (
    <section className="walkthrough" aria-label="Walkthrough" aria-live="polite">
      <div className="wt-text">
        <div className="wt-count">
          Step {index + 1} of {count}
        </div>
        <h3>{step.title}</h3>
        <div className="md">
          <Markdown text={step.description} />
        </div>
      </div>
      <div className="wt-controls">
        <button type="button" onClick={onPrev} disabled={index === 0} aria-label="Previous step (Left arrow)">
          ← Prev
        </button>
        <button type="button" onClick={onTogglePlay} aria-pressed={playing}>
          {playing ? "Pause" : "Play"}
        </button>
        <button type="button" onClick={onNext} disabled={index === count - 1} aria-label="Next step (Right arrow)">
          Next →
        </button>
        <button type="button" className="ghost" onClick={onExit} aria-label="Exit walkthrough (Esc)">
          Exit
        </button>
      </div>
    </section>
  );
}
