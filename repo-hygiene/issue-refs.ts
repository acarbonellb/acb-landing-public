// Finds issue references in code comments, so comments give the reason in
// words. Test-only: `issue-refs.test.ts` runs it over the tree.
import ts from "typescript";

const scriptFile = /\.(?:[cm]?[jt]s|tsx|jsx)$/;
const hashCommentFile = /(?:\.(?:sh|ya?ml)|(?:^|\/)Dockerfile)$/;

/**
 * Whether `path` is code whose comments are checked: source, tests, scripts
 * and workflows. Markdown (ADRs, research notes, docs) keeps its references;
 * JSON has no comments; CSS colours read like issue numbers.
 */
export function commentedFile(path: string): boolean {
  return scriptFile.test(path) || hashCommentFile.test(path);
}

// A `#` and a number (not an HTML entity such as `&#64;`, nor part of a word
// or path), or a link to an issue or a pull request.
const reference = /(?<![\w&/#])#\d+\b|\b(?:issues|pull)\/\d+\b/g;

type Comment = { start: number; text: string };

/** Every comment in a JavaScript or TypeScript file, found by the TypeScript parser. */
function scriptComments(path: string, text: string): Comment[] {
  const kind = path.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, false, kind);
  const comments = new Map<number, Comment>();
  const visit = (node: ts.Node) => {
    // A comment on the same line as the token before it is that token's
    // trailing comment; any other is the next token's leading comment.
    for (const range of [
      ...(ts.getLeadingCommentRanges(text, node.getFullStart()) ?? []),
      ...(ts.getTrailingCommentRanges(text, node.getEnd()) ?? []),
    ]) {
      comments.set(range.pos, { start: range.pos, text: text.slice(range.pos, range.end) });
    }
    // JSX text is not trivia, so a comment can only sit in a `{/* */}` child.
    if (!ts.isJsxText(node)) node.getChildren(file).forEach(visit);
  };
  visit(file);
  return [...comments.values()].sort((a, b) => a.start - b.start);
}

/** Every `#` comment in a shell, YAML or Dockerfile: a `#` at a line's start or after a space, outside quotes. */
function hashComments(text: string): Comment[] {
  const comments: Comment[] = [];
  let offset = 0;
  for (const line of text.split("\n")) {
    let quote = "";
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (quote) {
        if (c === quote) quote = "";
      } else if (c === '"' || c === "'") {
        quote = c;
      } else if (c === "#" && (i === 0 || /\s/.test(line[i - 1]))) {
        comments.push({ start: offset + i, text: line.slice(i) });
        break;
      }
    }
    offset += line.length + 1;
  }
  return comments;
}

/** Each issue reference in `text`'s comments, as `path:line: reference`. */
export function issueReferencesInComments(path: string, text: string): string[] {
  const comments = scriptFile.test(path) ? scriptComments(path, text) : hashComments(text);
  return comments.flatMap(({ start, text: comment }) =>
    [...comment.matchAll(reference)].map((m) => {
      const line = text.slice(0, start + m.index).split("\n").length;
      return `${path}:${line}: ${m[0]}`;
    }),
  );
}
