// @vitest-environment node
//
// Tests for the instruction set resolver.
// Key invariant: resolveInstructions is pure + deterministic — same inputs → byte-identical output.

import { describe, it, expect } from "vitest";
import { resolveInstructions, type ScopedVersion, type Block } from "../resolve";
import { diffVersions } from "../diff";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function global_(blocks: Block[], variables?: Record<string, string>): ScopedVersion {
  return { scope: "global", blocks, variables: variables ?? {} };
}
function project(blocks: Block[], variables?: Record<string, string>): ScopedVersion {
  return { scope: "project", blocks, variables: variables ?? {} };
}
function client(blocks: Block[], variables?: Record<string, string>): ScopedVersion {
  return { scope: "client", blocks, variables: variables ?? {} };
}
function deployment(blocks: Block[], variables?: Record<string, string>): ScopedVersion {
  return { scope: "deployment", blocks, variables: variables ?? {} };
}
function block(key: string, mode: "append" | "replace", text: string): Block {
  return { key, mode, text };
}

// ---------------------------------------------------------------------------
// Basic merge modes
// ---------------------------------------------------------------------------

describe("resolveInstructions — replace mode", () => {
  it("uses the most-specific replace block", () => {
    const { systemPrompt } = resolveInstructions([
      global_([block("persona", "replace", "You are a helper.")]),
      client([block("persona", "replace", "You are the client assistant.")]),
    ]);
    expect(systemPrompt).toBe("You are the client assistant.");
  });

  it("deployment replace overrides client replace", () => {
    const { systemPrompt } = resolveInstructions([
      client([block("persona", "replace", "Client assistant.")]),
      deployment([block("persona", "replace", "Deployment assistant.")]),
    ]);
    expect(systemPrompt).toBe("Deployment assistant.");
  });

  it("global replace is used when no more-specific override exists", () => {
    const { systemPrompt } = resolveInstructions([
      global_([block("persona", "replace", "Global assistant.")]),
    ]);
    expect(systemPrompt).toBe("Global assistant.");
  });
});

describe("resolveInstructions — append mode", () => {
  it("appends text after the existing block", () => {
    const { systemPrompt } = resolveInstructions([
      global_([block("rules", "replace", "Rule A.")]),
      client([block("rules", "append", "Rule B.")]),
    ]);
    expect(systemPrompt).toBe("Rule A.\n\nRule B.");
  });

  it("append of a new key adds it at the end", () => {
    const { systemPrompt } = resolveInstructions([
      global_([block("persona", "replace", "You are helpful.")]),
      client([block("tone", "append", "Speak formally.")]),
    ]);
    expect(systemPrompt).toBe("You are helpful.\n\nSpeak formally.");
  });

  it("multiple appends from different scopes concatenate in order", () => {
    const { systemPrompt } = resolveInstructions([
      global_([block("rules", "replace", "Rule 1.")]),
      project([block("rules", "append", "Rule 2.")]),
      client([block("rules", "append", "Rule 3.")]),
      deployment([block("rules", "append", "Rule 4.")]),
    ]);
    expect(systemPrompt).toBe("Rule 1.\n\nRule 2.\n\nRule 3.\n\nRule 4.");
  });
});

// ---------------------------------------------------------------------------
// Scope precedence
// ---------------------------------------------------------------------------

describe("resolveInstructions — scope precedence", () => {
  it("processes global before project before client before deployment", () => {
    const parts: string[] = [];
    const { systemPrompt } = resolveInstructions([
      deployment([block("k", "replace", "D")]),
      client([block("k", "replace", "C")]),
      global_([block("k", "replace", "G")]),
      project([block("k", "replace", "P")]),
    ]);
    expect(systemPrompt).toBe("D"); // deployment wins
    void parts;
  });

  it("block order is determined by the scope that first introduces the key", () => {
    const { systemPrompt } = resolveInstructions([
      global_([
        block("a", "replace", "A"),
        block("b", "replace", "B"),
      ]),
      client([
        block("c", "replace", "C"),
        block("a", "replace", "A2"),
      ]),
    ]);
    // a introduced by global (order 0), b by global (order 1), c by client (order 2)
    expect(systemPrompt).toBe("A2\n\nB\n\nC");
  });

  it("empty scopes produce an empty system prompt", () => {
    const { systemPrompt } = resolveInstructions([]);
    expect(systemPrompt).toBe("");
  });

  it("single block produces its text verbatim", () => {
    const { systemPrompt } = resolveInstructions([
      global_([block("x", "replace", "Hello world.")]),
    ]);
    expect(systemPrompt).toBe("Hello world.");
  });
});

// ---------------------------------------------------------------------------
// Variables merge
// ---------------------------------------------------------------------------

describe("resolveInstructions — variables", () => {
  it("more-specific scope wins per variable key", () => {
    const { variables } = resolveInstructions([
      global_([block("p", "replace", "")], { lang: "en", tone: "neutral" }),
      client([block("p", "replace", "")], { tone: "formal" }),
    ]);
    expect(variables.lang).toBe("en");
    expect(variables.tone).toBe("formal");
  });

  it("deployment variables override all", () => {
    const { variables } = resolveInstructions([
      global_([block("p", "replace", "")], { key: "global" }),
      deployment([block("p", "replace", "")], { key: "deployment" }),
    ]);
    expect(variables.key).toBe("deployment");
  });
});

// ---------------------------------------------------------------------------
// Determinism property test (1000 randomized scope combinations)
// ---------------------------------------------------------------------------

function randomBlock(seed: number): Block {
  const keys = ["persona", "rules", "tone", "context", "format"];
  const modes = ["append", "replace"] as const;
  return {
    key: keys[seed % keys.length],
    mode: modes[seed % 2],
    text: `Text-${seed}`,
  };
}

function randomScopes(seed: number): ScopedVersion[] {
  const scopes: ScopedVersion[] = [];
  const levels = (["global", "project", "client", "deployment"] as const).filter(
    (_, i) => (seed >> i) & 1
  );
  for (const scope of levels) {
    const n = (seed % 4) + 1;
    const blocks = Array.from({ length: n }, (_, i) => randomBlock(seed + i * 7));
    scopes.push({ scope, blocks, variables: { v: String(seed % 10) } });
  }
  return scopes;
}

describe("resolveInstructions — determinism property test", () => {
  it("returns byte-identical output for 1000 randomized scope combinations", () => {
    for (let seed = 0; seed < 1000; seed++) {
      const scopes = randomScopes(seed);
      const a = resolveInstructions(scopes);
      const b = resolveInstructions([...scopes]); // copy of same input
      expect(a.systemPrompt).toBe(b.systemPrompt);
      expect(JSON.stringify(a.variables)).toBe(JSON.stringify(b.variables));
    }
  });

  it("does not mutate the input array", () => {
    const scopes: ScopedVersion[] = [
      global_([block("p", "replace", "G")]),
      client([block("p", "replace", "C")]),
    ];
    const original = JSON.stringify(scopes);
    resolveInstructions(scopes);
    expect(JSON.stringify(scopes)).toBe(original);
  });
});

// ---------------------------------------------------------------------------
// diffVersions
// ---------------------------------------------------------------------------

describe("diffVersions", () => {
  it("detects added block", () => {
    const diffs = diffVersions(
      { blocks: [block("a", "replace", "A")] },
      { blocks: [block("a", "replace", "A"), block("b", "replace", "B")] }
    );
    expect(diffs).toHaveLength(1);
    expect(diffs[0]).toMatchObject({ key: "b", kind: "added", textAfter: "B" });
  });

  it("detects removed block", () => {
    const diffs = diffVersions(
      { blocks: [block("a", "replace", "A"), block("b", "replace", "B")] },
      { blocks: [block("a", "replace", "A")] }
    );
    expect(diffs).toHaveLength(1);
    expect(diffs[0]).toMatchObject({ key: "b", kind: "removed", textBefore: "B" });
  });

  it("detects changed text", () => {
    const diffs = diffVersions(
      { blocks: [block("a", "replace", "old text")] },
      { blocks: [block("a", "replace", "new text")] }
    );
    expect(diffs).toHaveLength(1);
    expect(diffs[0]).toMatchObject({ key: "a", kind: "changed", textBefore: "old text", textAfter: "new text" });
  });

  it("detects mode change", () => {
    const diffs = diffVersions(
      { blocks: [block("a", "replace", "text")] },
      { blocks: [block("a", "append", "text")] }
    );
    expect(diffs).toHaveLength(1);
    expect(diffs[0]).toMatchObject({ key: "a", kind: "changed", modeBefore: "replace", modeAfter: "append" });
  });

  it("returns empty diff for identical versions", () => {
    const blocks = [block("a", "replace", "A"), block("b", "append", "B")];
    expect(diffVersions({ blocks }, { blocks })).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Variable injection safety (no eval)
// ---------------------------------------------------------------------------

describe("template expansion safety", () => {
  it("injection-style templates expand to empty string, not executed code", async () => {
    // expandTemplate uses a regex replace + dot-notation path lookup — no eval.
    // A call-like expression in a placeholder cannot execute because the path
    // contains characters that break the dot-notation resolution, producing undefined → "".
    const { expandTemplate } = await import("@/lib/workflows/steps/transform");
    const injected = "{{constructor.constructor('return process.env')()}}";
    const result = expandTemplate(injected, { constructor: { constructor: "not a fn" } });
    // Path segments become ["constructor", "constructor('return process", "env')()"]
    // Second segment doesn't match any key → undefined → expands to ""
    expect(result).toBe("");
    // Also verify a valid path resolves to its string value, not executed
    const safe = expandTemplate("{{fn}}", { fn: "() => evil()" });
    expect(safe).toBe("() => evil()"); // literal string, never executed
  });
});
