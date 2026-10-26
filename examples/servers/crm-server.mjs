// A second demo upstream: customers and orders that reference catalog item ids, so scripts have a
// reason to join across servers. It also requires a token, to show how credentials stay host-side:
// the proxy passes CRM_TOKEN from its config `env`; the sandbox never sees it.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

if (process.env.CRM_TOKEN !== "demo-token") {
  process.stderr.write("crm-server: CRM_TOKEN missing or wrong; refusing to start\n");
  process.exit(1);
}

const customers = [
  { id: 1, name: "Ada", region: "north", tier: "gold" },
  { id: 2, name: "Bo", region: "south", tier: "silver" },
  { id: 3, name: "Cy", region: "north", tier: "bronze" },
];
const orders = Array.from({ length: 30 }, (_, i) => ({
  id: 100 + i,
  customerId: (i % 3) + 1,
  itemId: (i * 7) % 40 + 1,
  quantity: (i % 4) + 1,
  status: ["open", "shipped", "returned"][i % 3],
}));

const tools = [
  {
    name: "list_customers",
    description: "Customers, optionally filtered by region.",
    inputSchema: { type: "object", properties: { region: { type: "string", enum: ["north", "south"] } } },
    annotations: { readOnlyHint: true },
  },
  {
    name: "list_orders",
    description: "Orders, optionally filtered by customer and status.",
    inputSchema: {
      type: "object",
      properties: { customerId: { type: "integer" }, status: { type: "string", enum: ["open", "shipped", "returned"] } },
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "refund_order",
    description: "Refund an order. Moves money.",
    inputSchema: { type: "object", properties: { id: { type: "integer" } }, required: ["id"] },
    annotations: { destructiveHint: true },
  },
];

const text = (value) => ({ content: [{ type: "text", text: JSON.stringify(value) }] });
const handlers = {
  list_customers: ({ region }) => text(customers.filter((c) => !region || c.region === region)),
  list_orders: ({ customerId, status }) => text(orders.filter((o) => (!customerId || o.customerId === customerId) && (!status || o.status === status))),
  refund_order: ({ id }) => text({ id, refunded: true }),
};

const server = new Server({ name: "crm", version: "0.1.0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const handler = handlers[req.params.name];
  return handler ? handler(req.params.arguments ?? {}) : { content: [{ type: "text", text: `unknown tool ${req.params.name}` }], isError: true };
});
await server.connect(new StdioServerTransport());
