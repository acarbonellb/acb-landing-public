import { dirname, join, normalize } from "node:path";

/** The text outside fenced code blocks, line by line. */
function proseLines(markdown: string): string[] {
  let fenced = false;
  return markdown.split("\n").filter((line) => {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      return false;
    }
    return !fenced;
  });
}

/** The anchors GitHub gives a document's headings, duplicates numbered `-1`, `-2`, ... */
export function headingAnchors(markdown: string): Set<string> {
  const anchors = new Set<string>();
  const seen = new Map<string, number>();
  for (const line of proseLines(markdown)) {
    const heading = line.match(/^#{1,6}\s+(.+?)\s*#*\s*$/)?.[1];
    if (!heading) continue;
    const slug = heading
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s_-]/gu, "")
      .replace(/\s/g, "-");
    const count = seen.get(slug) ?? 0;
    seen.set(slug, count + 1);
    anchors.add(count ? `${slug}-${count}` : slug);
  }
  return anchors;
}

/** The targets of a document's inline links and images, outside code. */
export function markdownLinks(markdown: string): string[] {
  return proseLines(markdown).flatMap((line) =>
    [...line.replace(/`[^`]*`/g, "").matchAll(/!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)].map((m) => m[1]),
  );
}

/**
 * Every relative link in `files` whose file doesn't exist, or whose anchor
 * isn't a heading of the Markdown file it points to. External links (any
 * scheme) and `mailto:` aren't checked.
 */
export function brokenLinks(
  files: string[],
  read: (path: string) => string,
  exists: (path: string) => boolean,
): string[] {
  const anchorsOf = new Map<string, Set<string>>();
  const anchors = (path: string) => {
    if (!anchorsOf.has(path)) anchorsOf.set(path, headingAnchors(read(path)));
    return anchorsOf.get(path)!;
  };
  return files.flatMap((file) =>
    markdownLinks(read(file)).flatMap((link) => {
      if (/^[a-z][a-z0-9+.-]*:/i.test(link)) return [];
      const [path, anchor] = link.split("#", 2);
      const target = path ? normalize(join(dirname(file), decodeURI(path))).replace(/\/$/, "") : file;
      if (!exists(target)) return [`${file}: ${link} (no such file)`];
      if (anchor !== undefined && target.endsWith(".md") && !anchors(target).has(anchor)) {
        return [`${file}: ${link} (no such heading)`];
      }
      return [];
    }),
  );
}
