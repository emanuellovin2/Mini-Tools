/**
 * Pure diff utility for instruction versions.
 * Powers the version-history diff view in the settings UI.
 */

import type { Block } from "./resolve";

export type BlockDiff = {
  key: string;
  kind: "added" | "removed" | "changed";
  textBefore?: string;
  modeBefore?: string;
  textAfter?: string;
  modeAfter?: string;
};

export function diffVersions(
  a: { blocks: Block[] },
  b: { blocks: Block[] }
): BlockDiff[] {
  const aMap = new Map<string, Block>(a.blocks.map((bl) => [bl.key, bl]));
  const bMap = new Map<string, Block>(b.blocks.map((bl) => [bl.key, bl]));
  const diffs: BlockDiff[] = [];

  for (const [key, aBlock] of aMap) {
    const bBlock = bMap.get(key);
    if (!bBlock) {
      diffs.push({ key, kind: "removed", textBefore: aBlock.text, modeBefore: aBlock.mode });
    } else if (bBlock.text !== aBlock.text || bBlock.mode !== aBlock.mode) {
      diffs.push({
        key,
        kind: "changed",
        textBefore: aBlock.text,
        modeBefore: aBlock.mode,
        textAfter: bBlock.text,
        modeAfter: bBlock.mode,
      });
    }
  }

  for (const [key, bBlock] of bMap) {
    if (!aMap.has(key)) {
      diffs.push({ key, kind: "added", textAfter: bBlock.text, modeAfter: bBlock.mode });
    }
  }

  return diffs;
}
