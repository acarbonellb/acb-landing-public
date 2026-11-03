// Shared naming and formatting for the evals: one way to name a case or a
// recording set, plain string order (never locale order) and percentages, so
// the report, history and CI messages always agree.

/** Which recording set: one provider and model. */
export type SetId = { provider: string; model: string };

/** "lmstudio / qwen/qwen3.5-9b". */
export const setLabel = ({ provider, model }: SetId) => `${provider} / ${model}`;

export const sameSet = (a: SetId, b: SetId) =>
  a.provider === b.provider && a.model === b.model;

/** "ot01-capital-of-spain": also the recording's file name. */
export const caseName = ({ id, slug }: { id: string; slug: string }) => `${id}-${slug}`;

/** Plain string order, never locale order. */
export const byString = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** `n` of `of` cases (or facts); `of: 0` means nothing measured it. */
export type Ratio = { n: number; of: number };

/** As a percentage; `undefined` when nothing measured it. */
export const percent = ({ n, of }: Ratio) => (of ? (n / of) * 100 : undefined);
