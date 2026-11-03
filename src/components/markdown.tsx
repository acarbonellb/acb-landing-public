import { Fragment, type ReactNode } from "react";

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
// URL may hold one level of balanced parentheses.
const span =
  /`([^`]+)`|\[([^\]]+)\]\(([^()\s]*(?:\([^()\s]*\)[^()\s]*)*)\)|\*\*(\S(?:.*?\S)?)\*\*|__(\S(?:.*?\S)?)__|\*(\S(?:.*?\S)?)\*|(?<!\w)_(\S(?:.*?\S)?)_(?!\w)/;

const safeProtocols = new Set(["http:", "https:", "mailto:"]);

/** Only absolute http(s) and mailto URLs become links; anything else is text. */
function isSafeUrl(href: string): boolean {
  try {
    return safeProtocols.has(new URL(href).protocol);
  } catch {
    return false;
  }
}

function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let rest = text;
  while (rest) {
    const m = span.exec(rest);
    if (!m) {
      out.push(rest);
      break;
    }
    if (m.index > 0) out.push(rest.slice(0, m.index));
    const [, code, label, href, bold1, bold2, em1, em2] = m;
    const key = out.length;
    if (code !== undefined) out.push(<code key={key}>{code}</code>);
    else if (label !== undefined) {
      out.push(
        isSafeUrl(href) ? (
          <a key={key} href={href} target="_blank" rel="noopener noreferrer">
            {inline(label)}
          </a>
        ) : (
          <Fragment key={key}>{inline(label)}</Fragment>
        ),
      );
    } else if (bold1 ?? bold2) out.push(<strong key={key}>{inline(bold1 ?? bold2)}</strong>);
    else out.push(<em key={key}>{inline(em1 ?? em2)}</em>);
    rest = rest.slice(m.index + m[0].length);
  }
  return out;
}

export function Markdown({ text }: { text: string }) {
  return blocks(text).map((block, i) => {
    if (block.kind === "paragraph") {
      return (
        <p key={i}>
          {block.lines.map((line, j) => (
            <Fragment key={j}>
              {j > 0 && <br />}
              {inline(line)}
            </Fragment>
          ))}
        </p>
      );
    }
    const List = block.ordered ? "ol" : "ul";
    return (
      <List key={i}>
        {block.items.map((item, j) => (
          <li key={j}>{inline(item)}</li>
        ))}
      </List>
    );
  });
}
