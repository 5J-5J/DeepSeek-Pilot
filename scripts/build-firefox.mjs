import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

// Keep a directly loadable Firefox copy while core remains the shared source.
const source = new URL("../core/", import.meta.url);
const target = new URL("../firefox/", import.meta.url);
export async function firefoxFiles(directory = source, prefix = "") {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const name = prefix + entry.name;
    if (entry.isDirectory()) files.push(...await firefoxFiles(new URL(`${entry.name}/`, directory), `${name}/`));
    else files.push(name);
  }
  return files;
}
export async function firefoxContent(name) {
  let text = await readFile(new URL(name, source), "utf8");
  if (name === "manifest.json") {
    const manifest = JSON.parse(text);
    manifest.background = { scripts: ["logic/db.js", "background/session-memory.js", "background/workbench.js"] };
    manifest.browser_specific_settings = { gecko: { id: "{9133bc19-e66f-495c-b3c5-49d364b9eeb4}", strict_min_version: "140.0",
      data_collection_permissions: { required: ["personalCommunications", "websiteContent"] } },
      gecko_android: { strict_min_version: "142.0" } };
    return JSON.stringify(manifest, null, 2) + "\n";
  }
  if (name.endsWith(".js")) {
    text = text.replace(/\bchrome\./g, "browser.");
    if (name === "background/workbench.js")
      text = text.replace('importScripts("../logic/db.js", "session-memory.js");', "// Dependencies are loaded in order by background.scripts.");
  }
  return text;
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  for (const name of await firefoxFiles()) {
    const output = new URL(name, target);
    await mkdir(new URL("./", output), { recursive: true });
    await writeFile(output, await firefoxContent(name));
  }
  console.log("Firefox extension generated in firefox/");
}
