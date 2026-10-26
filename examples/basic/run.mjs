// Scripted walkthrough of the proxy without any LLM involved. Run with `pnpm --filter codemcp-examples basic`.
// Each step prints what a model would see, so you can check the surface, the stubs and the sandbox by eye.
import { ProxyHarness } from "../lib/harness.mjs";

const step = (title) => console.log(`\n=== ${title} ===`);
const show = ({ text }) => console.log(text);
const waitForPending = async (h) => {
  for (;;) {
    const [p] = h.proxy.gate.list();
    if (p) return p;
    await new Promise((r) => setTimeout(r, 20));
  }
};

const harness = await new ProxyHarness().start();
try {
  step("tools the client sees");
  for (const t of await harness.listTools()) console.log(`- ${t.name}`);

  step("search: 'notes'");
  show(await harness.search("notes"));

  step("describe: the whole catalog server, full detail");
  show(await harness.describe({ server: "catalog", detail: "full" }));

  step("execute: fan out over 40 items in one round trip");
  show(
    await harness.execute(`
      const items = await tools.catalog.list_items({ category: "garden" });
      const details = await Promise.all(items.slice(0, 5).map((i) => tools.catalog.get_item({ id: i.id })));
      console.log("fetched", details.length, "of", items.length);
      const value = details.reduce((sum, d) => sum + d.price * d.stock, 0);
      return { garden: items.length, sampled: details.map((d) => d.name), inventoryValue: value };
    `),
  );

  step("execute: join two servers inside the sandbox, return only the answer");
  show(
    await harness.execute(`
      const [customers, orders] = await Promise.all([tools.crm.list_customers({ region: "north" }), tools.crm.list_orders({ status: "open" })]);
      const ids = new Set(customers.map((c) => c.id));
      const mine = orders.filter((o) => ids.has(o.customerId));
      const items = await Promise.all([...new Set(mine.map((o) => o.itemId))].map((id) => tools.catalog.get_item({ id })));
      const price = Object.fromEntries(items.map((i) => [i.id, i.price]));
      return { openOrders: mine.length, exposure: mine.reduce((s, o) => s + o.quantity * price[o.itemId], 0) };
    `),
  );

  step("execute: the CRM token is only visible to the CRM process, never to the script");
  show(await harness.execute(`return { env: typeof process === "undefined" ? "no process object" : "leak" };`));

  step("execute: a plain write tool is allowed, a denied one never runs");
  show(await harness.execute(`try { await tools.crm.refund_order({ id: 100 }); } catch (e) { return e.message; } return "unreachable";`));
  show(await harness.execute(`return await tools.catalog.add_note({ text: "checked garden stock" });`));

  step("human in the loop: a destructive call parks the script until someone decides");
  const parked = harness.execute(`const r = await tools.catalog.delete_item({ id: 1 }); return "resumed after approval: " + r;`);
  const pending = await waitForPending(harness);
  console.log(`parked: #${pending.seq} ${pending.tool}(${JSON.stringify(pending.args)}), expires ${pending.expiresAt}`);
  console.log("state kept: the sandbox is suspended inside the call; nothing is replayed");
  show(await parked); // returns the "Paused" message to the client
  console.log("operator allows it ->");
  show({ text: await harness.proxy.resume(pending.executionId, pending.seq, true) });

  step("execute: bad arguments are rejected before reaching the upstream, and the script can recover");
  show(await harness.execute(`try { await tools.catalog.get_item({ id: "one" }); } catch (e) { return { code: e.code, message: e.message }; }`));

  step("execute: the sandbox has nothing but tools");
  show(await harness.execute(`return { process: typeof process, fetch: typeof fetch, require: typeof require };`));

  step("execute: runaway loops are stopped by the budget");
  show(await harness.execute(`for (let i = 0; i < 100; i++) await tools.catalog.get_item({ id: 2 }); return "done";`));

  step("passthrough tool called directly");
  show(await harness.call("catalog__get_item", { id: 3 }));

  step("audit log");
  const calls = harness.audit.events.filter((e) => e.type === "call");
  const byOutcome = calls.reduce((acc, e) => ({ ...acc, [e.ok ? "ok" : e.error.split(":")[0]]: (acc[e.ok ? "ok" : e.error.split(":")[0]] ?? 0) + 1 }), {});
  console.log(`${calls.length} bridged calls`, byOutcome);
  console.log(`${harness.audit.events.filter((e) => e.type === "execution_end").length} executions`);
} finally {
  await harness.close();
}
