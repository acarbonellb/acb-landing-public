// Shape checks for data the page reads from outside (the agent's `/stats`,
// the eval history): a field shown as a number must be a finite one, so a
// malformed value hides the line instead of rendering "NaN" or "Infinity".

/** A finite number. */
export const isNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);
