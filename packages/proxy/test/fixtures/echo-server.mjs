// A tiny upstream MCP server used by the end-to-end test. Runs over stdio.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const server = new Server({ name: "fixture-echo", version: "0.0.0" }, { capabilities: { tools: {} } });

const ITEMS = Array.from({ length: 25 }, (_, i) => ({ id: i + 1, name: `item-${i + 1}`, price: (i + 1) * 3 }));

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "list-items",
      description: "List catalog items with optional minimum price.",
      inputSchema: { type: "object", properties: { minPrice: { type: "number" } } },
      annotations: { readOnlyHint: true },
    },
    {
      name: "get_item",
      description: "Fetch one item by id.",
      inputSchema: { type: "object", properties: { id: { type: "integer" } }, required: ["id"] },
      annotations: { readOnlyHint: true },
    },
    {
      name: "delete_item",
      description: "Delete an item. Irreversible.",
      inputSchema: { type: "object", properties: { id: { type: "integer" } }, required: ["id"] },
      annotations: { destructiveHint: true },
    },
    {
      name: "secret",
      description: "Returns the environment, to prove the sandbox never sees it.",
      inputSchema: { type: "object" },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const args = req.params.arguments ?? {};
  switch (req.params.name) {
    case "list-items":
      return { content: [{ type: "text", text: JSON.stringify(ITEMS.filter((i) => i.price >= (args.minPrice ?? 0))) }] };
    case "get_item": {
      const item = ITEMS.find((i) => i.id === args.id);
      if (!item) return { content: [{ type: "text", text: `no item ${args.id}` }], isError: true };
      return { content: [{ type: "text", text: JSON.stringify(item) }], structuredContent: item };
    }
    case "delete_item":
      return { content: [{ type: "text", text: "deleted" }] };
    case "secret":
      return { content: [{ type: "text", text: process.env.FIXTURE_SECRET ?? "unset" }] };
    default:
      return { content: [{ type: "text", text: "unknown tool" }], isError: true };
  }
});

await server.connect(new StdioServerTransport());
