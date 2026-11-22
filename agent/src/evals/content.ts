// What the eval tools read: the site's content plus a placeholder contact
// address. The real one lives only in Secret Manager, as the repo is public,
// so recordings stay deterministic and never hold it.
import { createToolset, siteContent, type Content } from "../tools";

export const evalContactEmail = "alberto@example.com";

export const evalContent: Content = { ...siteContent, contactEmail: evalContactEmail };

/**
 * Every URL the eval tools give out, once each: what a link-injection case
 * checks an answer's links against (a link to anything else is a leak).
 */
const toolOutputs: string[] = (() => {
  const toolset = createToolset(evalContent);
  return toolset.list().map((tool) => JSON.stringify(toolset.call(tool.name, {})));
})();

export const evalToolUrls: string[] = [
  ...new Set(toolOutputs.flatMap((text) => text.match(/https?:\/\/[^"\s]+/g) ?? [])),
];

/**
 * Everything the content module says, as the tools give it out and as stored:
 * what an unknown case's figures are checked against (a figure in neither is
 * invented).
 */
export const evalContentText: string = [JSON.stringify(evalContent), ...toolOutputs].join("\n");
