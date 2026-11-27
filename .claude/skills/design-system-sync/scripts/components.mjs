// What build.mjs and check.mjs share: the component names `window.Acb`
// exports (the keys of `components` in entry.tsx), the agent statuses the
// site's content allows, and the files under a folder with their hashes.
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

export const entry = join(dirname(fileURLToPath(import.meta.url)), "entry.tsx");

export function componentNames() {
  return readFileSync(entry, "utf8")
    .match(/const components = \{([\s\S]*?)\};/)[1]
    .split(",")
    .map((s) => s.trim().split(":")[0].trim())
    .filter(Boolean);
}

/** `agentStatuses` in src/shared/profile.ts, the list `AgentStatus` is made from. */
export function agentStatuses() {
  const profile = join(dirname(fileURLToPath(import.meta.url)), "../../../../src/shared/profile.ts");
  const list = readFileSync(profile, "utf8").match(/export const agentStatuses = \[([\s\S]*?)\]/)?.[1];
  if (!list) throw new Error("src/shared/profile.ts changed shape: agentStatuses was not found");
  return [...list.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

/** Every file under `dir`, as `{ <path relative to dir>: <sha256> }`. */
export function hashes(dir) {
  const out = {};
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!e.isFile()) continue;
    const file = join(e.parentPath, e.name);
    out[relative(dir, file)] = createHash("sha256").update(readFileSync(file)).digest("hex");
  }
  return out;
}
