// "Without codemcp": every upstream tool as a provider would see it when all servers are attached
// directly, and a raw call path that bypasses the proxy's policy, approvals, pins and audit.
// Only for comparisons; the chat UI and the benchmark both use it.

/**
 * Every registry tool with the flat name a client would give it when all servers are attached
 * directly (`server__tool`, limited to the characters and length providers accept).
 */
export function directTools(proxy) {
  const used = new Set();
  return proxy.registry.list().map((t) => {
    let name = `${t.server}__${t.name}`.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);
    for (let i = 2; used.has(name); i++) name = `${name.slice(0, 60)}_${i}`;
    used.add(name);
    return { name, description: t.description ?? "", inputSchema: t.inputSchema, qualifiedName: t.qualifiedName, server: t.server };
  });
}

/** Calls the upstream server directly, the way a client with no proxy would: no policy, no approval, no audit. */
export async function directCall(proxy, name, args) {
  const tool = directTools(proxy).find((t) => t.name === name);
  const desc = tool && proxy.registry.get(tool.qualifiedName);
  if (!desc) return { text: `Error: unknown tool ${name}`, isError: true };
  // `upstreams` is private to the Proxy class; this reaches in because a raw call is exactly what it wants to measure.
  const up = proxy.upstreams.get(desc.server);
  try {
    const value = await up.callTool(desc.name, args);
    return { text: typeof value === "string" ? value : JSON.stringify(value, null, 2), isError: false };
  } catch (err) {
    return { text: `Error: ${err.message}`, isError: true };
  }
}

/**
 * What one tool definition costs on every request when passed directly, estimated at four characters
 * per token over the JSON a provider receives. An estimate: the providers do not expose per-tool counts.
 */
export function definitionTokens(tool) {
  return Math.ceil(JSON.stringify({ name: tool.name, description: tool.description ?? "", input_schema: tool.inputSchema ?? {} }).length / 4);
}
