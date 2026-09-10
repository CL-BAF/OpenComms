#!/usr/bin/env node
/**
 * Bundle a TypeScript entrypoint while feeding source files to esbuild from
 * Node. This avoids a Windows/esbuild 0.28 entry-path quirk seen when the
 * workspace is under a protected Desktop parent directory.
 */
import { build } from "esbuild"
import { existsSync, readFileSync } from "node:fs"
import { dirname, extname, isAbsolute, join, resolve } from "node:path"

const value = (name, fallback) => {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] ?? fallback : fallback
}
const entry = resolve(value("--entry", ""))
const outfile = resolve(value("--outfile", ""))
const format = value("--format", "esm")
if (!entry || !outfile || !existsSync(entry)) throw new Error("bundle.mjs requires an existing --entry and --outfile")

const extensions = [".ts", ".tsx", ".js", ".mjs", ".cjs"]
const resolveFile = (candidate) => {
  if (existsSync(candidate)) return candidate
  const stem = candidate.replace(/\.(?:js|mjs|cjs)$/, "")
  for (const base of [candidate, stem]) {
    for (const extension of extensions) if (existsSync(base + extension)) return base + extension
  }
  return null
}

await build({
  stdin: {
    contents: readFileSync(entry, "utf8"),
    sourcefile: entry,
    resolveDir: dirname(entry),
    loader: extname(entry) === ".ts" ? "ts" : "js",
  },
  bundle: true,
  format,
  platform: "node",
  outfile,
  logLevel: "warning",
  plugins: [
    {
      name: "opencomms-source-files",
      setup(buildApi) {
        buildApi.onResolve({ filter: /.*/ }, (args) => {
          if (args.path.startsWith("node:") || (!args.path.startsWith(".") && !isAbsolute(args.path))) {
            return { path: args.path, external: true }
          }
          const base = isAbsolute(args.path) ? args.path : join(args.resolveDir, args.path)
          const found = resolveFile(resolve(base))
          return found ? { path: found } : undefined
        })
        buildApi.onLoad({ filter: /\.(ts|tsx|js|mjs|cjs)$/ }, (args) => ({
          contents: readFileSync(args.path, "utf8"),
          loader: extname(args.path) === ".ts" ? "ts" : "js",
          resolveDir: dirname(args.path),
        }))
      },
    },
  ],
})
