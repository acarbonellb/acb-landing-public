// What a live eval run (`pnpm agent:eval`) records with. The model, effort
// and key go through the agent's own config schema (`loadConfig`), so an eval
// can't run with a setting production would reject, or read it differently.
// Only the defaults differ: a live run defaults to LM Studio on localhost,
// free. Run limits stay the loop's code defaults (`runner.ts`).
import { loadConfig } from "../config";
import type { Effort } from "../model";

export type LiveRunConfig = {
  baseURL: string;
  /** A server on this machine: free. Any other is a paid provider. */
  local: boolean;
  /** The recording set's provider label. */
  provider: string;
  model: string;
  effort: Effort;
  /** Unset for a paid server without `ANTHROPIC_API_KEY`. */
  apiKey: string | undefined;
};

const localServer = "http://localhost:1234";

/** Under the env for a local server: LM Studio's model, its placeholder key, $0. */
const localDefaults = {
  AGENT_MODEL: "qwen/qwen3.5-9b",
  ANTHROPIC_API_KEY: "lmstudio",
  AGENT_PRICE_INPUT_USD_PER_MTOK: "0",
  AGENT_PRICE_OUTPUT_USD_PER_MTOK: "0",
};

function isLocal(url: string): boolean {
  return ["localhost", "127.0.0.1", "[::1]"].includes(new URL(url).hostname);
}

/**
 * The live run's settings from `env`; throws the agent's own "Invalid agent
 * configuration" error on a setting the agent would reject. The provider label
 * comes from `--provider`, then `AGENT_EVAL_PROVIDER`, then the server.
 */
export function liveRunConfig(
  env: Record<string, string | undefined>,
  { provider }: { provider?: string } = {},
): LiveRunConfig {
  const set = Object.fromEntries(Object.entries(env).filter(([, v]) => v));
  const baseURL = set.ANTHROPIC_BASE_URL ?? localServer;
  const local = isLocal(baseURL);
  const config = loadConfig({ ...(local ? localDefaults : {}), ...set });
  return {
    baseURL,
    local,
    provider: provider || set.AGENT_EVAL_PROVIDER || (local ? "lmstudio" : "anthropic"),
    model: config.model,
    apiKey: config.anthropicApiKey,
    effort: config.effort,
  };
}
