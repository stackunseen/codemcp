// Puts a person between the model and the proxy's `approve` tool. Both agent examples use it.
import { createInterface } from "node:readline/promises";

export class TerminalApproval {
  constructor() {
    this.rl = createInterface({ input: process.stdin, output: process.stdout });
  }

  /** Wraps `call` so that `approve` is forwarded only after the person at the terminal confirms. */
  guard(call) {
    return async (name, args) => {
      if (name === "approve") {
        const answer = await this.rl.question(`Model wants to ${args.allow ? "ALLOW" : "DENY"} call #${args.seq} of execution ${args.executionId}. Confirm? [y/N] `);
        if (!/^y/i.test(answer)) return "The user did not confirm. Do not retry; explain that the action was not approved.";
      }
      return call(name, args);
    };
  }

  close() {
    this.rl.close();
  }
}
