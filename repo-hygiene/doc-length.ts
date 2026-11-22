/** A Markdown document's prose blocks: paragraphs and list items, each as one line of text. */
function proseBlocks(markdown: string): { text: string; afterTitle: boolean }[] {
  const blocks: { text: string; afterTitle: boolean }[] = [];
  let current: string[] = [];
  let fenced = false;
  let blocksSinceTitle = -1;
  const flush = () => {
    if (current.length) blocks.push({ text: current.join(" "), afterTitle: blocksSinceTitle === 0 });
    if (current.length && blocksSinceTitle >= 0) blocksSinceTitle++;
    current = [];
  };
  const other = () => {
    flush();
    if (blocksSinceTitle >= 0) blocksSinceTitle++;
  };
  for (const raw of markdown.split("\n")) {
    const line = raw.trim();
    if (/^(```|~~~)/.test(line)) {
      if (!fenced) other();
      fenced = !fenced;
    } else if (fenced) continue;
    else if (line === "") flush();
    else if (/^# /.test(line)) {
      flush();
      blocksSinceTitle = 0;
    } else if (/^(#{2,6} |\||<!--)/.test(line)) other();
    else if (/^([-*+]|\d+\.) /.test(line)) {
      flush();
      current.push(line);
    } else current.push(line);
  }
  flush();
  return blocks;
}

const wordsOf = (text: string) => text.split(/\s+/).filter(Boolean);

/** Paragraphs and list items over `maxWords` words, with their word count and first six words. */
export function longParagraphs(markdown: string, maxWords: number): { words: number; start: string }[] {
  return proseBlocks(markdown)
    .map(({ text }) => wordsOf(text))
    .filter((words) => words.length > maxWords)
    .map((words) => ({ words: words.length, start: words.slice(0, 6).join(" ") }));
}

/** The paragraph right after the `# ` title, if the title is followed by one. */
export function opening(markdown: string): string | undefined {
  return proseBlocks(markdown).find((block) => block.afterTitle)?.text;
}
