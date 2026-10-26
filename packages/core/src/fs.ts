import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/** Read and parse a JSON file. Returns `undefined` when the file does not exist; other errors propagate. */
export async function readJsonFile(path: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

/** Write a value as pretty-printed JSON, creating parent directories as needed. */
export async function writeJsonFile(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
