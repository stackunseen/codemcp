import { parse } from "acorn";
import { transformSync } from "esbuild";

export interface NormalizeResult {
  code: string;
  /** What was changed, for the audit log. */
  fixes: string[];
}

/**
 * Cleans up the formatting mistakes models commonly make before code reaches a sandbox, strips
 * TypeScript syntax, then syntax-checks the result. Every executor runs the same wrapped program
 * this class checks.
 */
export class CodeNormalizer {
  private static readonly FENCE = /^\s*```(?:ts|typescript|js|javascript)?\s*\n([\s\S]*?)\n\s*```\s*$/;
  private static readonly ASYNC_WRAPPER = /^\s*\(?\s*async\s*(?:function\s*)?\(\s*\)\s*(?:=>)?\s*\{([\s\S]*)\}\s*\)?\s*(?:\(\s*\))?\s*;?\s*$/;

  /** Wrap a function body so `return` and top-level `await` work. */
  static wrap(body: string): string {
    return `(async () => {\n${body}\n})()`;
  }

  /** Throws a SyntaxError (with a line number relative to the body) when the body does not parse. */
  static assertParses(body: string): void {
    try {
      parse(CodeNormalizer.wrap(body), { ecmaVersion: "latest", sourceType: "script" });
    } catch (err) {
      const e = err as Error & { loc?: { line: number; column: number } };
      const where = e.loc ? ` (line ${Math.max(1, e.loc.line - 1)}, column ${e.loc.column})` : "";
      throw new SyntaxError(`${e.message.replace(/\s*\(\d+:\d+\)\s*$/, "")}${where}`);
    }
  }

  normalize(input: string): NormalizeResult {
    const fixes: string[] = [];
    let code = input.replace(/\r\n/g, "\n");

    const fence = CodeNormalizer.FENCE.exec(code);
    if (fence?.[1] !== undefined) {
      code = fence[1];
      fixes.push("stripped markdown fence");
    }

    // shortcut: single-line code with one literal \n is left alone; revisit if this misfires in practice.
    if (!code.includes("\n") && code.split("\\n").length > 2) {
      code = code.replace(/\\n/g, "\n").replace(/\\t/g, "\t");
      fixes.push("converted literal \\n escapes to newlines");
    }

    const wrapped = CodeNormalizer.ASYNC_WRAPPER.exec(code);
    if (wrapped?.[1] !== undefined) {
      code = wrapped[1];
      fixes.push("unwrapped async function wrapper");
    }

    code = CodeNormalizer.stripTypeScript(code.trim(), fixes);
    CodeNormalizer.assertParses(code);
    return { code, fixes };
  }

  /**
   * The stubs are TypeScript, so models write TypeScript. Type annotations, `as`, `!` and `satisfies`
   * are erased here; the sandbox runs plain JavaScript. Pure JavaScript passes through unchanged.
   */
  private static stripTypeScript(body: string, fixes: string[]): string {
    try {
      parse(CodeNormalizer.wrap(body), { ecmaVersion: "latest", sourceType: "script" });
      return body;
    } catch {
      /* not plain JavaScript; try it as TypeScript */
    }
    try {
      const out = transformSync(CodeNormalizer.wrap(body), { loader: "ts", format: "esm", target: "es2022", minify: false });
      // Unwrap the transpiled program back to a body; esbuild keeps the wrapper verbatim.
      const m = /^\(async \(\) => \{\n([\s\S]*)\n\}\)\(\);?\s*$/.exec(out.code.trim());
      if (!m?.[1]) return body;
      fixes.push("stripped TypeScript syntax");
      return m[1];
    } catch {
      // Not valid TypeScript either; assertParses reports the JavaScript error.
      return body;
    }
  }
}
