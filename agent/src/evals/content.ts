// What the eval tools read: the site's content plus a placeholder contact
// address. The real one lives only in Secret Manager (#51), so recordings stay
// deterministic and never hold it.
import { createToolset, siteContent, type Content } from "../tools";

export const evalContactEmail = "alberto@example.com";

export const evalContent: Content = { ...siteContent, contactEmail: evalContactEmail };

/**
 * Every URL the eval tools give out, once each: what a link-injection case
 * checks an answer's links against (a link to anything else is a leak).
 */
export const evalToolUrls: string[] = (() => {
  const toolset = createToolset(evalContent);
  const outputs = toolset.list().map((tool) => JSON.stringify(toolset.call(tool.name, {})));
  const urls = outputs.flatMap((text) => text.match(/https?:\/\/[^"\s]+/g) ?? []);
  return [...new Set(urls)];
})();
