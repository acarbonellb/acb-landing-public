import { type AgentEndpoints, agentUrls } from "@/lib/agent-endpoint";
import { agentComingSoonNote } from "@/shared/site-copy";
import { AgentChat } from "../agent-chat";
import { AgentStats } from "../agent-stats";
import { Section, Window } from "../ui";

// The live chat with the agent service, or a "coming soon" note when the
// build has no agent URL (see `agent-endpoint.ts`).
export function Agent({
  linkedin,
  endpoints = agentUrls,
}: {
  /** Where the contact fallback points when the agent can't be reached. */
  linkedin: string;
  endpoints?: AgentEndpoints | null;
}) {
  return (
    <Section id="agent">
      <Window title="agent — claude · tool use">
        {endpoints ? (
          <AgentChat
            chatUrl={endpoints.chat}
            mcpUrl={endpoints.mcp}
            mcpDirectUrl={endpoints.mcpDirect}
            linkedin={linkedin}
          />
        ) : (
          <p className="text-sm leading-relaxed">
            <span className="text-comment">[system]</span>{" "}
            <span className="text-fg-dark">{agentComingSoonNote}</span>
          </p>
        )}
      </Window>
      {endpoints && (
        <div className="mt-3">
          <AgentStats url={endpoints.stats} />
        </div>
      )}
    </Section>
  );
}
