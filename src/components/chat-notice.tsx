import type { ChatErrorKind } from "@/lib/chat-client";
import type { Notice } from "@/lib/chat-session";

const noticeTitle: Record<ChatErrorKind, string> = {
  rate_limited: "Rate limit reached.",
  unavailable: "The agent is unavailable right now.",
  error: "Something went wrong.",
};

const noticeFallback: Record<ChatErrorKind, string> = {
  rate_limited: "Too many questions in a short time.",
  unavailable: "Please try again later.",
  error: "Please try again.",
};

const noticeBorder: Record<ChatErrorKind, string> = {
  rate_limited: "border-yellow",
  unavailable: "border-orange",
  error: "border-red",
};

// The notice's body: the agent's message, minus a leading copy of the title
// (the agent's own unavailable message starts with the same sentence).
function noticeDetail(notice: Notice): string {
  const title = noticeTitle[notice.kind];
  const message = notice.message ?? noticeFallback[notice.kind];
  const rest = message.startsWith(title) ? message.slice(title.length).trim() : message;
  return rest || noticeFallback[notice.kind];
}

// The spend cap resets at 00:00 UTC on the 1st, the daily quota at 00:00 UTC
// the next day: show that day, in UTC, so it doesn't read as the day before
// west of Greenwich.
function renewalDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    timeZone: "UTC",
    dateStyle: "long",
  });
}

// When to ask again. A rate limit with `resetsAt` is the daily quota: hours
// away, so the reset time reads better than a countdown in seconds.
function retryHint(notice: Notice): string {
  if (notice.resetsAt !== undefined) {
    return notice.kind === "rate_limited"
      ? ` Try again from 00:00 UTC on ${renewalDate(notice.resetsAt)}.`
      : ` It's back on ${renewalDate(notice.resetsAt)} (UTC).`;
  }
  if (notice.retryAfterSeconds !== undefined) return ` Try again in ${notice.retryAfterSeconds}s.`;
  return "";
}

/** Why the last question failed, and when to try again. */
export function ChatNotice({ notice, mcpUrl }: { notice: Notice; mcpUrl: string }) {
  return (
    <div
      role="alert"
      className={`rounded border px-3 py-2 text-sm text-fg ${noticeBorder[notice.kind]}`}
    >
      <p className="font-bold">{noticeTitle[notice.kind]}</p>
      <p className="text-fg-dark">
        {noticeDetail(notice)}
        {retryHint(notice)}
      </p>
      {/* The MCP tools don't use the model, so they outlive the chat. */}
      {notice.kind === "unavailable" && (
        <p className="mt-1 text-fg-dark [overflow-wrap:anywhere]">
          The MCP server still works: connect any MCP client to{" "}
          <code className="text-cyan">{mcpUrl}</code>.
        </p>
      )}
    </div>
  );
}
