/** Offline package checks: no browser profile or real DeepSeek requests. */
import assert from "node:assert/strict";
import { readFile, access } from "node:fs/promises";
import vm from "node:vm";
import { firefoxFiles, firefoxContent } from "../scripts/build-firefox.mjs";

for (const name of await firefoxFiles()) {
  const actual = await readFile(new URL(`../firefox/${name}`, import.meta.url), "utf8");
  assert.equal(actual.replaceAll("\r\n", "\n"), (await firefoxContent(name)).replaceAll("\r\n", "\n"),
    `${name}: regenerate with node scripts/build-firefox.mjs`);
  if (name.endsWith(".js")) {
    new vm.Script(actual, { filename: name });
    assert.doesNotMatch(actual, /\bchrome\./, `${name}: use Firefox Promise APIs`);
  }
}
const manifest = JSON.parse(await readFile(new URL("../firefox/manifest.json", import.meta.url), "utf8"));
assert.equal(manifest.background.service_worker, undefined);
assert.deepEqual(manifest.background.scripts, ["logic/db.js", "background/session-memory.js", "background/workbench.js"]);
assert.equal(manifest.browser_specific_settings.gecko.strict_min_version, "128.0");
assert.ok(manifest.browser_specific_settings.gecko.id);
const paths = [...manifest.background.scripts, manifest.action.default_popup, manifest.options_page,
  ...manifest.content_scripts.flatMap(script => [...script.js, ...(script.css || [])]),
  ...manifest.web_accessible_resources.flatMap(entry => entry.resources)];
for (const name of paths) await access(new URL(`../firefox/${name}`, import.meta.url));
assert.doesNotMatch(await readFile(new URL("../firefox/background/workbench.js", import.meta.url), "utf8"), /importScripts\(/);
assert.equal(manifest.content_scripts[0].world, "MAIN");
console.log("Firefox package checks passed");
