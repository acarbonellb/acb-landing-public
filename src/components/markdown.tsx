import { Fragment, type ReactNode } from "react";
import { linkHosts } from "@/lib/link-hosts";

type Block =
  | { kind: "paragraph"; lines: string[] }
  | { kind: "list"; ordered: boolean; items: string[] };

// A bare marker (still streaming its item) already counts as an item, so the
// line doesn't flash as paragraph text first.
const bullet = /^\s*[-*+](?:\s+(.*)|$)/;
const numbered = /^\s*\d+[.)](?:\s+(.*)|$)/;

function blocks(text: string): Block[] {
  const out: Block[] = [];
  // A blank line ends a paragraph, but not a list: models often space out
  // the items of one list, which would otherwise restart its numbering.
  let afterBlank = false;
  for (const line of text.split("\n")) {
    const last = out.at(-1);
    const item = bullet.exec(line) ?? numbered.exec(line);
    if (!line.trim()) {
      afterBlank = true;
      continue;
    }
    if (item) {
      const ordered = !bullet.test(line);
      if (last?.kind === "list" && last.ordered === ordered) last.items.push(item[1] ?? "");
      else out.push({ kind: "list", ordered, items: [item[1] ?? ""] });
    } else if (last?.kind === "paragraph" && !afterBlank) {
      last.lines.push(line.trim());
    } else {
      out.push({ kind: "paragraph", lines: [line.trim()] });
    }
    afterBlank = false;
  }
  return out;
}

// Inline spans, earliest match first; code comes first so its contents stay
// literal. Emphasis needs a non-space right inside its markers, and `_` only
// counts at word edges, so "5 * 3" and snake_case stay plain text. A link's
// URL may hold one level of balanced parentheses. A bare email address's
// domain must not end in a dot, so a sentence's full stop stays out.
const span =
  /`([^`]+)`|\[([^\]]+)\]\(([^()\s]*(?:\([^()\s]*\)[^()\s]*)*)\)|\*\*(\S(?:.*?\S)?)\*\*|__(\S(?:.*?\S)?)__|\*(\S(?:.*?\S)?)\*|(?<!\w)_(\S(?:.*?\S)?)_(?!\w)|(?<![\w.+-])([\w.+-]+@[\w-]+(?:\.[\w-]+)+)/;

/**
 * The URL a Markdown link may point to, or `undefined` to show its label as
 * text. An https: link needs an allowed host. A mailto: link needs an address
 * from `contacts`, and is rebuilt from it alone, so an added `cc` can't ride
 * along. Anything else (http:, javascript:, a relative URL) is text.
 */
function safeHref(href: string, contacts: ReadonlySet<string>): string | undefined {
  if (!URL.canParse(href)) return undefined;
  const url = new URL(href);
  if (url.protocol === "https:") return linkHosts.has(url.host) ? href : undefined;
  if (url.protocol !== "mailto:") return undefined;
  let address: string;
  try {
    address = decodeURIComponent(url.pathname);
  } catch {
    return undefined;
  }
  return contacts.has(address) ? `mailto:${address}` : undefined;
}

// Web links open in a new tab so the chat stays put; a mailto: link just
// hands off to the mail app, and in a new tab would leave a blank one behind.
const newTab = { target: "_blank", rel: "noopener noreferrer" } as const;

/**
 * `contacts`: the addresses this answer's `get_contact` results returned, the
 * only ones that become mailto: links (an injected address stays text).
 * `inLink`: inside a link's label, where an address must not become a nested link.
 */
function inline(text: string, contacts: ReadonlySet<string>, inLink = false): ReactNode[] {
  const out: ReactNode[] = [];
  let rest = text;
  while (rest) {
    const m = span.exec(rest);
    if (!m) {
      out.push(rest);
      break;
    }
    if (m.index > 0) out.push(rest.slice(0, m.index));
    const [, code, label, href, bold1, bold2, em1, em2, email] = m;
    const key = out.length;
    if (code !== undefined) out.push(<code key={key}>{code}</code>);
    else if (email !== undefined) {
      out.push(
        !inLink && contacts.has(email) ? (
          <a key={key} href={`mailto:${email}`}>
            {email}
          </a>
        ) : (
          email
        ),
      );
    } else if (label !== undefined) {
      const safe = safeHref(href, contacts);
      out.push(
        safe ? (
          <a key={key} href={safe} {...(safe.startsWith("mailto:") ? {} : newTab)}>
            {inline(label, contacts, true)}
          </a>
        ) : (
          <Fragment key={key}>{inline(label, contacts, inLink)}</Fragment>
        ),
      );
    } else if (bold1 ?? bold2) out.push(<strong key={key}>{inline(bold1 ?? bold2, contacts, inLink)}</strong>);
    else out.push(<em key={key}>{inline(em1 ?? em2, contacts, inLink)}</em>);
    rest = rest.slice(m.index + m[0].length);
  }
  return out;
}

const noContacts: ReadonlySet<string> = new Set();

export function Markdown({
  text,
  contacts = noContacts,
}: {
  text: string;
  contacts?: ReadonlySet<string>;
}) {
  return blocks(text).map((block, i) => {
    if (block.kind === "paragraph") {
      return (
        <p key={i}>
          {block.lines.map((line, j) => (
            <Fragment key={j}>
              {j > 0 && <br />}
              {inline(line, contacts)}
            </Fragment>
          ))}
        </p>
      );
    }
    const List = block.ordered ? "ol" : "ul";
    return (
      <List key={i}>
        {block.items.map((item, j) => (
          <li key={j}>{inline(item, contacts)}</li>
        ))}
      </List>
    );
  });
}
