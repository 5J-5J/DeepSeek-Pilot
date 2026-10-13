import { readFile } from "node:fs/promises";
import vm from "node:vm";
export async function runWorkbench(context) {
  const [primary, incremental] = await Promise.all(["workbench.js", "session-memory.js"].map(name =>
    readFile(new URL(`../core/background/${name}`, import.meta.url), "utf8")));
  context.importScripts = (...paths) => {
    for (const path of paths) {
      if (path === "session-memory.js") vm.runInContext(incremental, context, { filename: path });
      else if (path !== "../logic/db.js") throw new Error(`Unexpected import ${path}`);
    }
  };
  vm.runInContext(primary, context, { filename: "workbench.js" });
}
export async function workbenchSource({ autoClassify = false } = {}) {
  const source = (await Promise.all(["workbench.js", "session-memory.js"].map((name) =>
    readFile(new URL(`../core/background/${name}`, import.meta.url), "utf8")))).join("\n");
  // Offline fixtures may enable the retained classifier to keep testing its implementation.
  return autoClassify ? source.replace("const AUTO_CLASSIFY_ENABLED = false;", "const AUTO_CLASSIFY_ENABLED = true;") : source;
}
export function memoryCommitFixture(db) {
  return async (accountId, _sessions, decide) => {
    const names = ["memories", "memoryTurns", "projects", "jobs", "settings", "sessions", "memberships", "messages"];
    const rows = Object.fromEntries(await Promise.all(names.map(async (name) => [name, await db.all(name, accountId)])));
    const changes = decide(rows);
    for (const [name, entries] of Object.entries(changes)) if (name !== "removedMemories")
      for (const row of entries) await db.put(name, row);
    for (const row of changes.removedMemories || []) await db.remove("memories", [accountId, row.memoryId]);
  };
}
