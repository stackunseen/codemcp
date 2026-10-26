# codemcp

The `codemcp` command and the MCP server behind it.

```bash
codemcp import --write      # discover servers from your MCP clients into codemcp.config.json
codemcp tools               # connect and list every tool with its pin status
codemcp stubs --detail full # print the TypeScript the model will see
codemcp serve               # run the proxy over stdio
```

Point your MCP client at `npx codemcp serve`. It advertises three tools, `search`, `describe` and `execute`, plus any `passthrough` patterns from the config.

Programmatic use:

```ts
import { Proxy } from "codemcp";

const proxy = new Proxy({ config: { servers: { shop: { command: "node", args: ["catalog-server.mjs"] } } } });
await proxy.start();
await proxy.server.connect(transport);
```
