// Generated from spec/conformance/cases.json by scripts/sync-spec.mjs. Do not edit; edit the spec and run `pnpm spec:sync`.
import type { SpecCase } from "../spec-types.js";

export const CASES: readonly SpecCase[] = [
  {
    "name": "returns a JSON value",
    "category": "semantics",
    "code": {
      "js": "return { sum: 1 + 1, list: [1, 2, 3], nested: { ok: true } };"
    },
    "expect": {
      "status": "completed",
      "value": {
        "sum": 2,
        "list": [
          1,
          2,
          3
        ],
        "nested": {
          "ok": true
        }
      }
    }
  },
  {
    "name": "returning nothing yields null",
    "category": "semantics",
    "code": {
      "js": "const x = 1;"
    },
    "expect": {
      "status": "completed",
      "value": null
    }
  },
  {
    "name": "calls a tool and receives its JSON result",
    "category": "bridge",
    "code": {
      "js": "return await tools.echo.say({ text: 'hi', n: 2 });"
    },
    "fns": {
      "echo.say": {
        "kind": "echo"
      }
    },
    "expect": {
      "status": "completed",
      "value": {
        "text": "hi",
        "n": 2
      }
    }
  },
  {
    "name": "host receives plain JSON only",
    "category": "bridge",
    "code": {
      "js": "class Weird { constructor() { this.a = 1; } get b() { return 2; } } return await tools.echo.say(new Weird());"
    },
    "fns": {
      "echo.say": {
        "kind": "echo"
      }
    },
    "expect": {
      "status": "completed",
      "received": [
        {
          "a": 1
        }
      ]
    }
  },
  {
    "name": "concurrent tool calls via Promise.all",
    "category": "bridge",
    "code": {
      "js": "const r = await Promise.all([tools.echo.say(1), tools.echo.say(2), tools.echo.say(3)]); return r;"
    },
    "fns": {
      "echo.say": {
        "kind": "echo"
      }
    },
    "expect": {
      "status": "completed",
      "value": [
        1,
        2,
        3
      ]
    }
  },
  {
    "name": "a fast call's continuation is not blocked by a slow sibling",
    "category": "bridge",
    "code": {
      "js": "const order = []; await Promise.all([tools.t.slow().then(() => order.push('slow')), tools.t.fast().then(() => tools.t.fast()).then(() => order.push('fast'))]); return order;"
    },
    "fns": {
      "t.slow": {
        "kind": "delay",
        "ms": 300,
        "value": "s"
      },
      "t.fast": {
        "kind": "value",
        "value": "f"
      }
    },
    "expect": {
      "status": "completed",
      "value": [
        "fast",
        "slow"
      ]
    }
  },
  {
    "name": "time spent waiting on the host does not count against the deadline",
    "category": "limits",
    "code": {
      "js": "const a = await tools.t.slow(); const b = await tools.t.slow(); return a + b;"
    },
    "fns": {
      "t.slow": {
        "kind": "delay",
        "ms": 1000,
        "value": "x"
      }
    },
    "options": {
      "timeoutMs": 1500
    },
    "expect": {
      "status": "completed",
      "value": "xx"
    }
  },
  {
    "name": "sequential dependent calls",
    "category": "bridge",
    "code": {
      "js": "let acc = 0; for (let i = 0; i < 5; i++) { acc += await tools.math.inc({ v: acc }); } return acc;"
    },
    "fns": {
      "math.inc": {
        "kind": "inc"
      }
    },
    "expect": {
      "status": "completed",
      "value": 31
    }
  },
  {
    "name": "console output is captured",
    "category": "semantics",
    "code": {
      "js": "console.log('a', 1, { b: 2 }); console.warn('w'); console.error(new Error('boom')); return 0;"
    },
    "expect": {
      "status": "completed",
      "logs": [
        {
          "message": "a 1 {\"b\":2}"
        },
        {
          "level": "warn"
        },
        {
          "messageMatches": "boom"
        }
      ]
    }
  },
  {
    "name": "log entries beyond the limit are dropped with one notice",
    "category": "limits",
    "code": {
      "js": "for (let i = 0; i < 50; i++) console.log('line', i); return 0;"
    },
    "options": {
      "maxLogEntries": 10
    },
    "expect": {
      "status": "completed",
      "logsCount": 11,
      "lastLogMatches": "40 log entries .*dropped"
    }
  },
  {
    "name": "log bytes are capped and the drop is reported once",
    "category": "limits",
    "code": {
      "js": "for (let i = 0; i < 20; i++) console.log('x'.repeat(1000)); return 0;"
    },
    "options": {
      "maxLogBytes": 5000
    },
    "expect": {
      "status": "completed",
      "logsCount": 6,
      "lastLogMatches": "15 log entries \\(15000 bytes\\) dropped"
    }
  },
  {
    "name": "unknown tool rejects with a catchable error naming the tool",
    "category": "bridge",
    "code": {
      "js": "try { await tools.nope.nothing({}); return 'no error'; } catch (e) { return { m: e.message.includes('nope.nothing'), c: e.code }; }"
    },
    "expect": {
      "status": "completed",
      "value": {
        "m": true,
        "c": "unknown_tool"
      }
    }
  },
  {
    "name": "tool errors surface as exceptions the script can handle",
    "category": "bridge",
    "code": {
      "js": "try { await tools.flaky.run({}); return 'no error'; } catch (e) { return { msg: e.message, code: e.code }; }"
    },
    "fns": {
      "flaky.run": {
        "kind": "throw",
        "message": "upstream said no"
      }
    },
    "expect": {
      "status": "completed",
      "value": {
        "msg": "upstream said no",
        "code": "upstream_error"
      }
    }
  },
  {
    "name": "fatal host errors end the execution even inside try/catch",
    "category": "bridge",
    "code": {
      "js": "try { await tools.gate.drifted({}); } catch (e) {} return 'survived';"
    },
    "fns": {
      "gate.drifted": {
        "kind": "throw",
        "code": "pin_drifted",
        "message": "Tool definition changed since it was approved"
      }
    },
    "expect": {
      "status": "error",
      "codes": [
        "pin_drifted"
      ]
    }
  },
  {
    "name": "a refused call is catchable so the script can fall back",
    "category": "bridge",
    "code": {
      "js": "try { await tools.gate.denied({}); return 'no error'; } catch (e) { return { code: e.code, fallback: await tools.echo.say('read-only path') }; }"
    },
    "fns": {
      "gate.denied": {
        "kind": "throw",
        "code": "policy_denied",
        "message": "Policy denies gate.denied"
      },
      "echo.say": {
        "kind": "echo"
      }
    },
    "expect": {
      "status": "completed",
      "value": {
        "code": "policy_denied",
        "fallback": "read-only path"
      }
    }
  },
  {
    "name": "a script that returns without awaiting a call fails instead of dropping it",
    "category": "bridge",
    "code": {
      "js": "tools.echo.say({ write: true }); return 'done';"
    },
    "fns": {
      "echo.say": {
        "kind": "echo"
      }
    },
    "expect": {
      "status": "error",
      "codes": [
        "runtime_error"
      ],
      "messageMatches": "missing await",
      "receivedCount": 1
    }
  },
  {
    "name": "sleep resolves after the requested delay",
    "category": "semantics",
    "code": {
      "js": "const t = Date.now(); await sleep(120); return Date.now() - t;"
    },
    "expect": {
      "status": "completed",
      "valueType": "number",
      "valueMin": 100
    }
  },
  {
    "name": "sleep counts against the deadline",
    "category": "limits",
    "code": {
      "js": "await sleep(10000); return 'woke';"
    },
    "options": {
      "timeoutMs": 1500
    },
    "expect": {
      "status": "error",
      "codes": [
        "timeout"
      ],
      "maxDurationMs": 3500
    }
  },
  {
    "name": "an abort signal cancels a running script promptly",
    "category": "limits",
    "code": {
      "js": "for (;;) {}"
    },
    "options": {
      "timeoutMs": 10000,
      "abortAfterMs": 200
    },
    "expect": {
      "status": "error",
      "codes": [
        "cancelled"
      ],
      "maxDurationMs": 2000
    }
  },
  {
    "name": "no host globals are reachable",
    "category": "isolation",
    "code": {
      "js": "return [typeof process, typeof require, typeof fetch, typeof globalThis.module, typeof setTimeout, typeof XMLHttpRequest, typeof WebAssembly, typeof Deno, typeof Bun];"
    },
    "expect": {
      "status": "completed",
      "value": [
        "undefined",
        "undefined",
        "undefined",
        "undefined",
        "undefined",
        "undefined",
        "undefined",
        "undefined",
        "undefined"
      ]
    }
  },
  {
    "name": "prototype walking does not reach the host",
    "category": "isolation",
    "code": {
      "js": "const G = ({}).constructor.constructor('return globalThis')(); return [typeof G.process, typeof G.require, Object.getPrototypeOf(tools) === null];"
    },
    "expect": {
      "status": "completed",
      "value": [
        "undefined",
        "undefined",
        true
      ]
    }
  },
  {
    "name": "infinite loop is killed by the deadline",
    "category": "limits",
    "code": {
      "js": "let i = 0; while (true) { i++; }"
    },
    "options": {
      "timeoutMs": 1500
    },
    "expect": {
      "status": "error",
      "codes": [
        "timeout"
      ],
      "maxDurationMs": 3500
    }
  },
  {
    "name": "busy promise loop is killed by the deadline",
    "category": "limits",
    "code": {
      "js": "async function spin() { for (;;) { await Promise.resolve(); } } await spin();"
    },
    "options": {
      "timeoutMs": 1500
    },
    "expect": {
      "status": "error",
      "codes": [
        "timeout"
      ],
      "maxDurationMs": 3500
    }
  },
  {
    "name": "a script that throws 'interrupted' is a runtime error, not a timeout",
    "category": "limits",
    "code": {
      "js": "throw new Error('interrupted');"
    },
    "expect": {
      "status": "error",
      "codes": [
        "runtime_error"
      ]
    }
  },
  {
    "name": "allocation bomb hits the memory limit",
    "category": "limits",
    "code": {
      "js": "const a = []; for (;;) { a.push(new Array(100000).fill('xxxxxxxxxxxxxxxx')); }"
    },
    "options": {
      "timeoutMs": 10000,
      "memoryLimitBytes": 33554432
    },
    "expect": {
      "status": "error",
      "codes": [
        "memory_limit",
        "timeout"
      ]
    }
  },
  {
    "name": "deep recursion hits the stack limit",
    "category": "limits",
    "code": {
      "js": "function f(n) { return f(n + 1) + 1; } return f(0);"
    },
    "options": {
      "timeoutMs": 5000
    },
    "expect": {
      "status": "error",
      "codes": [
        "stack_overflow",
        "runtime_error"
      ]
    }
  },
  {
    "name": "syntax errors are reported, not executed",
    "category": "semantics",
    "code": {
      "js": "return ("
    },
    "expect": {
      "status": "error",
      "codes": [
        "syntax_error"
      ]
    }
  },
  {
    "name": "thrown errors are reported with their message",
    "category": "semantics",
    "code": {
      "js": "throw new TypeError('bad thing');"
    },
    "expect": {
      "status": "error",
      "codes": [
        "runtime_error"
      ],
      "messageMatches": "bad thing"
    }
  },
  {
    "name": "non-JSON return values degrade to null instead of crashing",
    "category": "semantics",
    "code": {
      "js": "return () => 1;"
    },
    "expect": {
      "status": "completed",
      "value": null
    }
  },
  {
    "name": "a dangling await is detected instead of hanging",
    "category": "limits",
    "code": {
      "js": "await new Promise(() => {}); return 1;"
    },
    "options": {
      "timeoutMs": 1500
    },
    "expect": {
      "status": "error",
      "maxDurationMs": 3500
    }
  }
];
