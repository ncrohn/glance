import { describe, it, expect } from "vitest";
import { groupSteps, capabilitySummary, isSelectable } from "./integration";
import type { SetupStep, ClientInfo } from "./ipc";

const step = (group: string, ok = true): SetupStep => ({ ok, group, label: "l", message: "m" });

const client = (over: Partial<ClientInfo>): ClientInfo => ({
  id: "cursor",
  displayName: "Cursor",
  present: true,
  capabilities: [
    { key: "mcp", label: "MCP server (glance-mcp)", supported: true },
    { key: "guidance", label: "Review guidance", supported: true },
    { key: "skill", label: "Agent skill", supported: false },
    { key: "hook", label: "Auto-open hook", supported: false },
  ],
  ...over,
});

describe("groupSteps", () => {
  it("partitions by group, preserving first-seen order", () => {
    const groups = groupSteps([
      step("Shared"),
      step("Claude Code"),
      step("Claude Code"),
      step("Cursor"),
    ]);
    expect(groups.map((g) => g.name)).toEqual(["Shared", "Claude Code", "Cursor"]);
    expect(groups[1].steps).toHaveLength(2);
  });

  it("returns empty for no steps", () => {
    expect(groupSteps([])).toEqual([]);
  });
});

describe("capabilitySummary", () => {
  it("splits supported from unsupported labels", () => {
    const { supported, unsupported } = capabilitySummary(client({}));
    expect(supported).toEqual(["MCP server (glance-mcp)", "Review guidance"]);
    expect(unsupported).toEqual(["Agent skill", "Auto-open hook"]);
  });

  it("all supported when a client backs every capability", () => {
    const claude = client({
      capabilities: client({}).capabilities.map((c) => ({ ...c, supported: true })),
    });
    expect(capabilitySummary(claude).unsupported).toEqual([]);
  });
});

describe("isSelectable", () => {
  it("is true only for detected clients", () => {
    expect(isSelectable(client({ present: true }), "setup")).toBe(true);
    expect(isSelectable(client({ present: false }), "setup")).toBe(false);
    expect(isSelectable(client({ present: false }), "remove")).toBe(false);
  });
});
