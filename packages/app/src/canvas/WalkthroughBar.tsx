import type { WalkthroughStep } from "@tracer/core";
import { IconButton } from "../ui/Icon";
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
        <div className="wt-progress" aria-hidden="true">
          {Array.from({ length: count }, (_, i) => (
            <span key={i} className={i <= index ? "done" : undefined} />
          ))}
        </div>
      </div>
      <div className="wt-controls">
        <IconButton icon="arrow-left" label="Previous step (←)" onClick={onPrev} disabled={index === 0} />
        <IconButton icon={playing ? "debug-pause" : "play"} label={playing ? "Pause" : "Play"} aria-pressed={playing} onClick={onTogglePlay} />
        <IconButton icon="arrow-right" label="Next step (→)" onClick={onNext} disabled={index === count - 1} />
        <IconButton icon="close" label="Exit walkthrough (Esc)" onClick={onExit} />
      </div>
    </section>
  );
}
