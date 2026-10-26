import { defineConfig, type Options } from "tsup";

/** Shared tsup settings for every workspace package. `entry` lists the bundles; `dtsEntry` the ones that get type declarations (default: all). */
export function packageConfig(entry: string[], dtsEntry: string[] = entry): ReturnType<typeof defineConfig> {
  const options: Options = {
    entry,
    format: ["esm"],
    dts: { entry: dtsEntry },
    sourcemap: true,
    clean: true,
    splitting: false,
    target: "node20",
  };
  return defineConfig(options);
}
