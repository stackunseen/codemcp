/**
 * JavaScript that runs inside the QuickJS guest before the model's code.
 *
 * It defines the only capabilities the guest has:
 *  - `tools.<ns>.<name>(args)`: posts a JSON call to the host and returns a Promise
 *  - `sleep(ms)`: resolves after a delay, counted against the script's deadline
 *  - `console.*`: forwards a formatted string (capped in the guest) to the host
 *
 * `__host_call`, `__host_sleep` and `__host_log` are host functions injected by the worker. They
 * accept strings and numbers only, so nothing but JSON ever crosses the boundary.
 */
const MAX_LOG_MESSAGE_CHARS = 64 * 1024;

export const GUEST_PRELUDE = String.raw`
"use strict";
const __pending = new Map();
let __seq = 0;
globalThis.__deliver = (seq, json) => {
  const p = __pending.get(seq);
  if (!p) return;
  __pending.delete(seq);
  const r = JSON.parse(json);
  if (r.ok) p.resolve(r.value);
  else {
    const e = new Error(r.error.message);
    e.code = r.error.code;
    p.reject(e);
  }
};
function __call(tool, args) {
  return new Promise((resolve, reject) => {
    const seq = ++__seq;
    __pending.set(seq, { resolve, reject });
    let json;
    try {
      json = JSON.stringify(args === undefined ? {} : args);
    } catch (err) {
      __pending.delete(seq);
      reject(new Error("Tool arguments must be JSON-serializable: " + err.message));
      return;
    }
    __host_call(seq, tool, json === undefined ? "{}" : json);
  });
}
function sleep(ms) {
  return new Promise((resolve, reject) => {
    const seq = ++__seq;
    __pending.set(seq, { resolve, reject });
    __host_sleep(seq, Math.max(0, Number(ms) || 0));
  });
}
const tools = new Proxy(Object.create(null), {
  get(_, ns) {
    if (typeof ns !== "string") return undefined;
    return new Proxy(Object.create(null), {
      get(_, name) {
        if (typeof name !== "string") return undefined;
        return (args) => __call(ns + "." + name, args);
      },
    });
  },
});
const __fmt = (v) => {
  if (typeof v === "string") return v;
  if (v instanceof Error) return (v.name || "Error") + ": " + v.message;
  try { const s = JSON.stringify(v); return s === undefined ? String(v) : s; } catch { return String(v); }
};
const __log = (level) => (...a) => { __host_log(level, a.map(__fmt).join(" ").slice(0, ${MAX_LOG_MESSAGE_CHARS})); };
const console = Object.freeze({ log: __log("log"), info: __log("info"), debug: __log("log"), warn: __log("warn"), error: __log("error") });
`;
