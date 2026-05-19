#!/usr/bin/env node
import { cp, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(root, "apps/web/dist");
const target = path.join(root, "packages/cli/web-dist");

await rm(target, { recursive: true, force: true });
await cp(source, target, { recursive: true });
console.log(`Copied dashboard UI to ${path.relative(root, target)}`);
