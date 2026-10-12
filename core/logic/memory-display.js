/** Filter memory in user messages and preserve hidden background when editing. */
(() => {
  "use strict";

  const scopeForLine = (line) => /^## 个人记忆$|^\[个人(?:\/[^\]]+)?\]/.test(line) ? "PERSONAL"
    : /^## 项目记忆：|^\[[^\]]+\/[^\]]+\]/.test(line) ? "PROJECT" : "";

  function visibleText(value, showPersonal, showProject) {
    const text = String(value || "");
    const block = text.match(/<project_memory>\s*([\s\S]*?)\s*<\/project_memory>/i);
    if (!block || !/^\s*(?:继续项目「[^\n]+」的工作。[^\n]*\n)?<project_memory>/u.test(text)) return null;
    if (showPersonal && showProject) return text;

    const question = text.match(/<current_question>\s*([\s\S]*?)\s*<\/current_question>\s*$/i);
    const original = question ? question[1].trim() : text.slice(block.index + block[0].length).trim();
    let scope = "";
    const lines = block[1].split("\n").filter((line) => {
      scope = scopeForLine(line) || scope;
      return scope === "PERSONAL" ? showPersonal : scope === "PROJECT" && showProject;
    });
    return lines.length ? `<project_memory>\n${lines.join("\n").trim()}\n</project_memory>\n\n${original}` : original;
  }

  function memorySections(body) {
    const sections = { INTRO: [], PERSONAL: [], PROJECT: [] };
    let scope = "INTRO";
    for (const line of body.split("\n")) {
      scope = scopeForLine(line) || scope;
      sections[scope].push(line);
    }
    return Object.fromEntries(Object.entries(sections).map(([scope, lines]) => [scope, lines.join("\n").trim()]));
  }

  /** Merge an edited display back into the original prompt, keeping hidden background intact. */
  function mergeEditedText(original, edited, showPersonal, showProject) {
    const shown = visibleText(original, showPersonal, showProject);
    if (shown === null || (showPersonal && showProject)) return edited;
    if (edited === shown) return original;
    const block = original.match(/<project_memory>\s*([\s\S]*?)\s*<\/project_memory>/i);
    const sections = memorySections(block[1]);
    const hasVisibleMemory = (showPersonal && sections.PERSONAL) || (showProject && sections.PROJECT);
    const editedBlock = hasVisibleMemory && edited.match(/^\s*<project_memory>\s*([\s\S]*?)\s*<\/project_memory>/i);
    const changed = memorySections(editedBlock?.[1] || "");
    if (showPersonal) sections.PERSONAL = changed.PERSONAL;
    if (showProject) sections.PROJECT = changed.PROJECT;
    const body = [sections.INTRO, sections.PERSONAL, sections.PROJECT].filter(Boolean).join("\n\n");
    const memory = sections.PERSONAL || sections.PROJECT ? `<project_memory>\n${body}\n</project_memory>` : "";
    const question = (editedBlock ? edited.slice(editedBlock[0].length) : edited).trim();
    const suffix = original.slice(block.index + block[0].length);
    const current = suffix.match(/<current_question>\s*([\s\S]*?)\s*<\/current_question>\s*$/i);
    return original.slice(0, block.index) + memory + (current
      ? suffix.slice(0, current.index) + `<current_question>\n${question}\n</current_question>`
      : `\n\n${question}`);
  }

  globalThis.DTWMemoryDisplay = Object.freeze({ visibleText, mergeEditedText });
})();
