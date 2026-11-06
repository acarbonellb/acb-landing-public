import * as content from "@/shared/profile";
import { SITE_URL } from "./site";

/**
 * The hosts of every https URL in `values`, at any depth. A host here is
 * `URL.host`, so a non-default port is a different host.
 */
export function linkHostsIn(...values: unknown[]): Set<string> {
  const hosts = new Set<string>();
  const visit = (value: unknown) => {
    if (typeof value === "string") {
      if (!URL.canParse(value)) return;
      const url = new URL(value);
      if (url.protocol === "https:") hosts.add(url.host);
    } else if (value && typeof value === "object") {
      Object.values(value).forEach(visit);
    }
  };
  values.forEach(visit);
  return hosts;
}

/**
 * The hosts the chat's answers may link to: those of the URLs in the
 * content module the agent's tools serve, plus the site itself. Derived, not
 * hand-written, so a link added to the content is allowed with it. Anything
 * else the model writes, e.g. after a prompt injection, renders as text.
 */
export const linkHosts: ReadonlySet<string> = linkHostsIn(content, SITE_URL);
