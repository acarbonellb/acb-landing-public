"use client";

import { useEffect, useState, useSyncExternalStore } from "react";

// One run of terminal text. `typed` text (a command) is revealed character by
// character; anything else (prompt, output) appears at once, like a shell.
export type Segment = {
  text: string;
  className?: string;
  typed?: boolean;
};

const START_DELAY = 250;
const CHAR_DELAY = 55;
const OUTPUT_DELAY = 180;

// Each step: when (ms from mount) how many characters are revealed.
function buildTimeline(segments: Segment[]) {
  const steps: { at: number; revealed: number }[] = [];
  let at = START_DELAY;
  let revealed = 0;
  let previousTyped = false;
  for (const { text, typed } of segments) {
    if (typed) {
      for (let i = 0; i < text.length; i++) {
        at += CHAR_DELAY;
        revealed += 1;
        steps.push({ at, revealed });
      }
    } else {
      if (previousTyped) at += OUTPUT_DELAY;
      revealed += text.length;
      steps.push({ at, revealed });
    }
    previousTyped = Boolean(typed);
  }
  return steps;
}

const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";

function subscribeReducedMotion(onChange: () => void) {
  if (typeof window.matchMedia !== "function") return () => {};
  const query = window.matchMedia(REDUCED_MOTION);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

function prefersReducedMotion() {
  return (
    typeof window.matchMedia === "function" &&
    window.matchMedia(REDUCED_MOTION).matches
  );
}

// Terminal text that "types" itself on load. The full text is always in the
// DOM (static HTML, screen readers); characters not yet typed are only made
// transparent, so the box keeps its final size. Without JavaScript or with
// reduced motion everything is shown (see `.typewriter-pending` in CSS).
export function TypewriterTerminal({
  segments,
  className = "",
}: {
  segments: Segment[];
  className?: string;
}) {
  const reduceMotion = useSyncExternalStore(
    subscribeReducedMotion,
    prefersReducedMotion,
    () => false,
  );
  const [revealed, setRevealed] = useState(0);

  useEffect(() => {
    if (reduceMotion) return;
    const timers = buildTimeline(segments).map(({ at, revealed }) =>
      setTimeout(() => setRevealed(revealed), at),
    );
    return () => timers.forEach(clearTimeout);
  }, [segments, reduceMotion]);

  const total = segments.reduce((sum, s) => sum + s.text.length, 0);
  const visible = reduceMotion ? total : revealed;
  const starts = segments.map((_, i) =>
    segments.slice(0, i).reduce((sum, s) => sum + s.text.length, 0),
  );

  return (
    <pre className={className}>
      {segments.map(({ text, className }, i) => {
        const shown = Math.max(0, Math.min(visible - starts[i], text.length));
        return (
          <span key={i} className={className}>
            {shown > 0 && text.slice(0, shown)}
            {shown < text.length && (
              <span className="typewriter-pending" style={{ opacity: 0 }}>
                {text.slice(shown)}
              </span>
            )}
          </span>
        );
      })}
    </pre>
  );
}
