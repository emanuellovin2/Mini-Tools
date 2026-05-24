/**
 * Transform step — applies a JSONata-lite template mapping to the run context.
 *
 * Safety: pure object-path traversal + string interpolation.
 * NO eval, NO Function constructor, NO dynamic code execution.
 *
 * Template syntax: `{{path.to.value}}` where path is dot-notation into the
 * accumulated run context (keyed by step_key, plus "trigger" for trigger_payload).
 *
 * Example config:
 *   { "mapping": { "lead_name": "{{trigger.body.name}}", "count": "{{prior_step.count}}" } }
 */

export interface TransformConfig {
  mapping: Record<string, unknown>;
}

export interface TransformInput {
  context: Record<string, unknown>;
}

export interface TransformOutput {
  result: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

/** Safe dot-notation path lookup. Returns undefined if any segment is missing. */
export function getPath(obj: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((cur, key) => {
    if (cur === null || cur === undefined) return undefined;
    return (cur as Record<string, unknown>)[key];
  }, obj);
}

/**
 * Expand all `{{path}}` placeholders in a string using the given context.
 * Non-string-valued paths are coerced via String().
 * Unknown paths expand to empty string.
 */
export function expandTemplate(tpl: string, context: Record<string, unknown>): string {
  return tpl.replace(/\{\{([^}]+)\}\}/g, (_, rawPath: string) => {
    const resolved = getPath(context, rawPath.trim());
    if (resolved === undefined || resolved === null) return "";
    return String(resolved);
  });
}

/**
 * Recursively expand all string values in a JSON-like object.
 * Preserves non-string values (numbers, booleans, arrays, nested objects).
 */
export function applyMapping(
  template: Record<string, unknown>,
  context: Record<string, unknown>
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(template)) {
    result[key] = expandValue(value, context);
  }
  return result;
}

function expandValue(value: unknown, context: Record<string, unknown>): unknown {
  if (typeof value === "string") return expandTemplate(value, context);
  if (Array.isArray(value)) return value.map((v) => expandValue(v, context));
  if (value !== null && typeof value === "object") {
    return applyMapping(value as Record<string, unknown>, context);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Step handler
// ---------------------------------------------------------------------------

export async function runTransformStep(
  config: TransformConfig,
  input: TransformInput
): Promise<TransformOutput> {
  if (!config.mapping || typeof config.mapping !== "object") {
    throw new Error("transform: config.mapping must be an object");
  }
  const result = applyMapping(config.mapping, input.context);
  return { result };
}
