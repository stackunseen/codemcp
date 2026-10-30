import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { Ajv2020 as Ajv } from "ajv/dist/2020.js";
import { ConfigLoader } from "../src/config.js";
import { Proxy } from "../src/server.js";

describe("descriptions config", () => {
  it("cleans by default, carries maxLength, and can be turned off", () => {
    expect(ConfigLoader.resolve({ servers: {} }).descriptionHygiene).toEqual({});
    expect(ConfigLoader.resolve({ servers: {}, descriptions: { maxLength: 300 } }).descriptionHygiene).toEqual({ maxLength: 300 });
    expect(ConfigLoader.resolve({ servers: {}, descriptions: { clean: false, maxLength: 300 } }).descriptionHygiene).toBe(false);
  });

  it("is accepted by the config schema", () => {
    const schema = JSON.parse(readFileSync(new URL("../../../spec/config/codemcp.config.schema.json", import.meta.url), "utf8")) as object;
    const validate = new Ajv({ strict: false }).compile(schema);
    expect(validate({ servers: {}, descriptions: { clean: false, maxLength: 500 } })).toBe(true);
    expect(validate({ servers: {}, descriptions: { maxLength: 0 } })).toBe(false);
    expect(validate({ servers: {}, descriptions: { other: 1 } })).toBe(false);
  });

  it("the proxy passes the setting to its registry", () => {
    const off = new Proxy({ config: { servers: {}, descriptions: { clean: false } }, log: () => undefined });
    const [raw] = off.registry.setServerTools("s", [{ name: "t", description: "a​b", inputSchema: {} }]);
    expect(raw?.description).toBe("a​b");
    const on = new Proxy({ config: { servers: {} }, log: () => undefined });
    const [cleaned] = on.registry.setServerTools("s", [{ name: "t", description: "a​b", inputSchema: {} }]);
    expect(cleaned?.description).toBe("ab");
  });
});
