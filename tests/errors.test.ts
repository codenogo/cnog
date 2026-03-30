import { describe, it, expect } from "vitest";
import { CnogError, errorFix, _format } from "../src/errors.js";

describe("CnogError", () => {
  it("formats message correctly for a known code", () => {
    const err = new CnogError("AGENT_ALREADY_EXISTS", {
      name: "builder-1",
      state: "working",
    });
    expect(err.message).toBe(
      "Agent builder-1 already exists with state working",
    );
    expect(err.code).toBe("AGENT_ALREADY_EXISTS");
    expect(err.fix).toBe("Stop it first: cnog stop-agent builder-1");
  });

  it("uses the code as message for an unknown code", () => {
    const err = new CnogError("TOTALLY_UNKNOWN_CODE");
    expect(err.message).toBe("TOTALLY_UNKNOWN_CODE");
    expect(err.code).toBe("TOTALLY_UNKNOWN_CODE");
    expect(err.fix).toBe("");
  });
});

describe("errorFix", () => {
  it("returns formatted fix string for a known code", () => {
    const fix = errorFix("FEATURE_NOT_FOUND", { feature: "auth" });
    expect(fix).toBe("Create it: cnog shape auth");
  });

  it("returns empty string for an unknown code", () => {
    expect(errorFix("DOES_NOT_EXIST")).toBe("");
  });
});

describe("_format", () => {
  it("replaces known keys", () => {
    const result = _format("Hello {name}, your role is {role}", {
      name: "Alice",
      role: "builder",
    });
    expect(result).toBe("Hello Alice, your role is builder");
  });

  it("leaves missing keys as-is", () => {
    const result = _format("Agent {name} on branch {branch}", {
      name: "agent-1",
    });
    expect(result).toBe("Agent agent-1 on branch {branch}");
  });

  it("handles template with no placeholders", () => {
    const result = _format("no placeholders here", { key: "value" });
    expect(result).toBe("no placeholders here");
  });

  it("handles empty kwargs", () => {
    const result = _format("{a} and {b}", {});
    expect(result).toBe("{a} and {b}");
  });
});
