/**
 * Typed handoff between agent steps.
 *
 * validateHandoff — checks output conforms to the declared output_schema.
 * readUpstream    — reads a prior step's output from the accumulated run context.
 *
 * Invalid handoff (schema mismatch) = step failure; never silent coercion.
 */

export type JsonSchema = {
  type?: string;
  required?: string[];
  properties?: Record<string, { type?: string; items?: { type?: string } }>;
};

/**
 * Validates output against a JSON Schema subset (type, required, property types).
 * Throws with a clear message on violation.
 */
export function validateHandoff(output: unknown, schema: JsonSchema | undefined): void {
  if (!schema) return;

  if (typeof output !== "object" || output === null || Array.isArray(output)) {
    throw new Error(`handoff validation failed: expected object, got ${Array.isArray(output) ? "array" : typeof output}`);
  }

  const obj = output as Record<string, unknown>;

  const required = schema.required ?? [];
  for (const key of required) {
    if (!(key in obj)) {
      throw new Error(`handoff validation failed: missing required key "${key}"`);
    }
  }

  const properties = schema.properties;
  if (properties) {
    for (const [key, spec] of Object.entries(properties)) {
      const val = obj[key];
      if (val === undefined || val === null) continue;
      if (!spec.type) continue;

      const actualType = Array.isArray(val) ? "array" : typeof val;
      if (actualType !== spec.type) {
        throw new Error(
          `handoff validation failed: key "${key}" expected type "${spec.type}", got "${actualType}"`
        );
      }

      if (spec.type === "array" && spec.items?.type && Array.isArray(val)) {
        for (let i = 0; i < (val as unknown[]).length; i++) {
          const item = (val as unknown[])[i];
          const itemType = typeof item;
          if (itemType !== spec.items.type) {
            throw new Error(
              `handoff validation failed: key "${key}[${i}]" expected type "${spec.items.type}", got "${itemType}"`
            );
          }
        }
      }
    }
  }
}

/**
 * Read a prior step's output from the accumulated run context.
 * Keyed by step_key (or virtual iteration key).
 */
export function readUpstream(runContext: Record<string, unknown>, stepKey: string): unknown {
  return runContext[stepKey];
}
