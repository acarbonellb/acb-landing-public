"use client";

import { useEffect, useState } from "react";
import type { StatsResponse, WeekStats } from "@/shared/stats-contract";

// A one-line summary of the agent's usage, read from its public `GET /stats`
// in the browser (the static page can't know it at build time). Anything
// short of a valid answer with at least one question answered shows nothing.

const isNumber = (value: unknown): value is number => typeof value === "number";
const isNumberOrNull = (value: unknown) => value === null || isNumber(value);

// Checks every field `statsLine` reads, so a malformed body hides the line
// instead of rendering "NaN".
function isWeek(value: unknown): value is WeekStats {
  const chat = (value as WeekStats | undefined)?.chat;
  return (
    isNumber(chat?.answered) &&
    isNumber(chat.costUsd) &&
    isNumberOrNull(chat.errorRate) &&
    isNumberOrNull(chat.latency?.p50Ms)
  );
}

function isStats(value: unknown): value is StatsResponse {
  const stats = value as StatsResponse | undefined;
  return isWeek(stats?.current) && isWeek(stats.previous);
}

const seconds = (ms: number) => `${Number((ms / 1000).toFixed(1))} s`;

const dollars = (usd: number) => (usd > 0 && usd < 0.01 ? "<$0.01" : `$${usd.toFixed(2)}`);

/** The line for `stats`, or `null` when neither week has an answer yet. */
export function statsLine({ current, previous }: StatsResponse): string | null {
  // Early in the week there is little to show: fall back to the last one.
  const [label, week] = current.chat.answered > 0 ? ["this week", current] : ["last week", previous];
  const { answered, latency, errorRate, costUsd } = week.chat;
  if (answered === 0) return null;
  const parts = [`${answered} question${answered === 1 ? "" : "s"} answered`];
  if (latency.p50Ms !== null) parts.push(`p50 ${seconds(latency.p50Ms)}`);
  if (errorRate !== null) parts.push(`${Math.round(errorRate * 100)}% errors`);
  parts.push(dollars(costUsd));
  return `${label}: ${parts.join(" · ")}`;
}

export function AgentStats({
  url,
  fetch = globalThis.fetch,
}: {
  url: string;
  fetch?: typeof globalThis.fetch;
}) {
  const [line, setLine] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    (async () => {
      try {
        const res = await fetch(url, { signal: controller.signal });
        if (!res.ok) return;
        const body: unknown = await res.json();
        if (isStats(body)) setLine(statsLine(body));
      } catch {
        // Unreachable, aborted or not JSON: the line stays hidden.
      }
    })();
    return () => controller.abort();
  }, [url, fetch]);

  if (!line) return null;
  return (
    <p className="text-xs text-comment">
      <span aria-hidden>{"// "}</span>
      <span>{line}</span>
    </p>
  );
}
