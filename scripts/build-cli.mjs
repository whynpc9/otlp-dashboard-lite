#!/usr/bin/env node
import { rm } from "node:fs/promises";
import { builtinModules } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const builtinSet = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));
const outdir = path.join(root, "packages/cli/dist");

await rm(outdir, { recursive: true, force: true });

await build({
  entryPoints: [path.join(root, "packages/cli/src/index.ts")],
  outdir,
  bundle: true,
  splitting: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: false,
  entryNames: "[name]",
  chunkNames: "chunks/[name]-[hash]",
  plugins: [workspaceInternalPlugin(), externalRuntimeDependenciesPlugin()]
});

function workspaceInternalPlugin() {
  return {
    name: "workspace-internal",
    setup(buildContext) {
      buildContext.onResolve({ filter: /^local-otel-server\/config$/ }, () => ({
        path: path.join(root, "apps/server/src/config.ts")
      }));
      buildContext.onResolve({ filter: /^local-otel-server\/server$/ }, () => ({
        path: path.join(root, "apps/server/src/server.ts")
      }));
      buildContext.onResolve({ filter: /^local-otel-server\/mcp$/ }, () => ({
        path: path.join(root, "apps/server/src/mcp/server.ts")
      }));
      buildContext.onResolve({ filter: /^local-otel-otel-proto\/generated\/(.+)$/ }, (args) => ({
        path: path.join(root, "packages/otel-proto/generated", `${args.path.slice("local-otel-otel-proto/generated/".length)}.js`)
      }));
    }
  };
}

function externalRuntimeDependenciesPlugin() {
  return {
    name: "external-runtime-dependencies",
    setup(buildContext) {
      buildContext.onResolve({ filter: /^[^./]|^\.[^./]|^\.\.[^/]/ }, (args) => {
        if (builtinSet.has(args.path) || args.path.startsWith("local-otel-server/") || args.path.startsWith("local-otel-otel-proto/")) {
          return undefined;
        }
        if (isBarePackageImport(args.path)) {
          return { path: args.path, external: true };
        }
        return undefined;
      });
    }
  };
}

function isBarePackageImport(value) {
  return value.startsWith("@") ? /^@[^/]+\/[^/]+/.test(value) : /^[^./][^:]*/.test(value);
}
