#!/usr/bin/env node
// Release helper. All packages under packages/ share one version and move in lockstep.
//
//   node scripts/release.mjs current          -> prints the current version
//   node scripts/release.mjs bump <kind>      -> patch | minor | major | prerelease, or an exact x.y.z
//
// `bump` rewrites every packages/*/package.json and prints the new version.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const pkgDir = join(root, "packages");
const manifests = readdirSync(pkgDir).map((d) => join(pkgDir, d, "package.json"));

function read(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function current() {
  const versions = new Set(manifests.map((m) => read(m).version));
  if (versions.size !== 1) throw new Error(`packages are out of sync: ${[...versions].join(", ")}`);
  return [...versions][0];
}

function next(version, kind) {
  if (/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(kind)) return kind;
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-(\w+)\.(\d+))?$/.exec(version);
  if (!m) throw new Error(`cannot parse version ${version}`);
  let [major, minor, patch] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const pre = m[4] ? { tag: m[4], n: Number(m[5]) } : null;
  switch (kind) {
    case "major": return pre && minor === 0 && patch === 0 ? `${major}.0.0` : `${major + 1}.0.0`;
    case "minor": return pre && patch === 0 ? `${major}.${minor}.0` : `${major}.${minor + 1}.0`;
    case "patch": return pre ? `${major}.${minor}.${patch}` : `${major}.${minor}.${patch + 1}`;
    case "prerelease": return pre ? `${major}.${minor}.${patch}-${pre.tag}.${pre.n + 1}` : `${major}.${minor}.${patch + 1}-next.0`;
    default: throw new Error(`unknown bump kind: ${kind}`);
  }
}

const [cmd, arg] = process.argv.slice(2);
if (cmd === "current") {
  console.log(current());
} else if (cmd === "bump") {
  if (!arg) throw new Error("bump needs a kind or an exact version");
  const to = next(current(), arg);
  for (const m of manifests) {
    const pkg = read(m);
    pkg.version = to;
    writeFileSync(m, JSON.stringify(pkg, null, 2) + "\n");
  }
  console.log(to);
} else {
  console.error("usage: release.mjs current | bump <patch|minor|major|prerelease|x.y.z>");
  process.exit(1);
}
