// A small MCP server over stdio that stands in for a real upstream. It holds a product catalog and
// a notes list, with read-only, destructive and plain tools so policy behavior is visible.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const items = Array.from({ length: 40 }, (_, i) => ({
  id: i + 1,
  name: `item-${i + 1}`,
  category: ["tools", "garden", "kitchen", "office"][i % 4],
  price: (i + 1) * 3,
  stock: (i * 7) % 13,
}));
const notes = [];

const tools = [
  {
    name: "list-items",
    description: "List catalog items, optionally filtered by category and minimum price.",
    inputSchema: {
      type: "object",
      properties: {
        category: { type: "string", enum: ["tools", "garden", "kitchen", "office"] },
        minPrice: { type: "number", description: "Only items priced at or above this." },
      },
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "get_item",
    description: "Fetch one item by id.",
    inputSchema: { type: "object", properties: { id: { type: "integer" } }, required: ["id"] },
    outputSchema: {
      type: "object",
      properties: { id: { type: "integer" }, name: { type: "string" }, category: { type: "string" }, price: { type: "number" }, stock: { type: "integer" } },
      required: ["id", "name", "price"],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "restock",
    description: "Add stock to an item.",
    inputSchema: { type: "object", properties: { id: { type: "integer" }, quantity: { type: "integer", minimum: 1 } }, required: ["id", "quantity"] },
  },
  {
    name: "delete_item",
    description: "Remove an item from the catalog. Irreversible.",
    inputSchema: { type: "object", properties: { id: { type: "integer" } }, required: ["id"] },
    annotations: { destructiveHint: true },
  },
  {
    name: "add_note",
    description: "Append a free-text note.",
    inputSchema: { type: "object", properties: { text: { type: "string", minLength: 1 } }, required: ["text"] },
  },
  {
    name: "list_notes",
    description: "All notes in insertion order.",
    inputSchema: { type: "object" },
    annotations: { readOnlyHint: true },
  },
];

const text = (value) => ({ content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }] });
const failure = (message) => ({ content: [{ type: "text", text: message }], isError: true });

const handlers = {
  "list-items": ({ category, minPrice = 0 }) => text(items.filter((i) => (!category || i.category === category) && i.price >= minPrice)),
  get_item: ({ id }) => {
    const item = items.find((i) => i.id === id);
    return item ? { ...text(item), structuredContent: item } : failure(`no item ${id}`);
  },
  restock: ({ id, quantity }) => {
    const item = items.find((i) => i.id === id);
    if (!item) return failure(`no item ${id}`);
    item.stock += quantity;
    return text({ id, stock: item.stock });
  },
  delete_item: ({ id }) => {
    const at = items.findIndex((i) => i.id === id);
    if (at < 0) return failure(`no item ${id}`);
    items.splice(at, 1);
    return text("deleted");
  },
  add_note: ({ text: body }) => {
    notes.push({ id: notes.length + 1, text: body, at: new Date().toISOString() });
    return text(notes[notes.length - 1]);
  },
  list_notes: () => text(notes),
};

const server = new Server({ name: "catalog", version: "0.1.0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const handler = handlers[req.params.name];
  return handler ? handler(req.params.arguments ?? {}) : failure(`unknown tool ${req.params.name}`);
});
await server.connect(new StdioServerTransport());
