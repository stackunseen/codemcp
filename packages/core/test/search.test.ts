import { describe, expect, it } from "vitest";
import { ToolRegistry, ToolSearch } from "../src/index.js";

describe("ToolSearch", () => {
  const registry = new ToolRegistry();
  registry.setServerTools("github", [
    { name: "create_issue", description: "Open a new issue in a repository", inputSchema: { type: "object", properties: { title: {}, body: {} } } },
    { name: "list_pull_requests", description: "List PRs for a repo", inputSchema: {} },
  ]);
  registry.setServerTools("slack", [{ name: "post_message", description: "Send a message to a channel", inputSchema: { type: "object", properties: { channel: {}, text: {} } } }]);
  const search = new ToolSearch(registry.list());

  it("ranks by name, description and parameter names", () => {
    expect(search.search("create issue")[0]?.qualifiedName).toBe("github.create_issue");
    expect(search.search("send slack")[0]?.qualifiedName).toBe("slack.post_message");
    expect(search.search("pull request")[0]?.qualifiedName).toBe("github.list_pull_requests");
    expect(search.search("channel")[0]?.qualifiedName).toBe("slack.post_message");
  });

  it("returns an empty list for nonsense and respects the limit", () => {
    expect(search.search("zzzzqqq")).toEqual([]);
    expect(search.search("github", 1)).toHaveLength(1);
  });
});
