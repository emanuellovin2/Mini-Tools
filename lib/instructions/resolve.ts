/**
 * Pure, deterministic instruction set resolver.
 *
 * Contract: same inputs → byte-identical output across 1000+ randomized runs.
 * No IO. Heavily unit-tested + property-tested.
 *
 * Merge precedence: global → project → client → deployment (least → most specific).
 * - replace: overrides any same-key block from a less-specific scope.
 * - append: concatenates after existing same-key text (or adds if key is new).
 * Unknown keys from a more-specific scope are appended at the end in scope order.
 */

export type Block = {
  key: string;
  mode: "append" | "replace";
  text: string;
};

export type ScopeLevel = "global" | "project" | "client" | "deployment";

export interface ScopedVersion {
  scope: ScopeLevel;
  blocks: Block[];
  variables: Record<string, string>;
}

export interface ResolvedInstructions {
  systemPrompt: string;
  variables: Record<string, string>;
}

const SCOPE_ORDER: ScopeLevel[] = ["global", "project", "client", "deployment"];

/**
 * Merge scopes into a single system prompt string + variables map.
 *
 * Block ordering is stable: a block's insertion order is determined by the scope
 * that first introduces its key. More-specific scopes modify text but not order
 * for existing keys. New keys from more-specific scopes are appended at the end.
 */
export function resolveInstructions(scopes: ScopedVersion[]): ResolvedInstructions {
  // Sort: global first, deployment last
  const sorted = [...scopes].sort(
    (a, b) => SCOPE_ORDER.indexOf(a.scope) - SCOPE_ORDER.indexOf(b.scope)
  );

  // Key → { text, order }; order determines final prompt assembly sequence
  const blockMap = new Map<string, { text: string; order: number }>();
  let orderCounter = 0;

  for (const scopedVersion of sorted) {
    for (const block of scopedVersion.blocks) {
      const existing = blockMap.get(block.key);

      if (block.mode === "replace") {
        blockMap.set(block.key, {
          text: block.text,
          order: existing?.order ?? orderCounter++,
        });
      } else {
        // append
        if (existing) {
          blockMap.set(block.key, {
            text: `${existing.text}\n\n${block.text}`,
            order: existing.order,
          });
        } else {
          blockMap.set(block.key, { text: block.text, order: orderCounter++ });
        }
      }
    }
  }

  // Assemble prompt in insertion order
  const assembled = [...blockMap.entries()]
    .sort((a, b) => a[1].order - b[1].order)
    .map(([, { text }]) => text);

  const systemPrompt = assembled.join("\n\n");

  // Merge variables: more-specific scope wins per key
  const variables: Record<string, string> = {};
  for (const sv of sorted) {
    Object.assign(variables, sv.variables);
  }

  return { systemPrompt, variables };
}
