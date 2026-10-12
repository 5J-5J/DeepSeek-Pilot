import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = await readFile(path.join(root, "core/logic/memory-display.js"), "utf8");
const context = vm.createContext({});
vm.runInContext(source, context);
const { visibleText, mergeEditedText } = context.DTWMemoryDisplay;

const userText = "请总结这篇文章\n并给出建议";
const block = `<project_memory>\n[个人] 喜欢简洁回答\n继续使用中文\n[写作项目/风格] 保留标题\n</project_memory>`;
const sent = `${block}\n\n${userText}`;
assert.equal(visibleText(sent, false, false), userText);
assert.equal(visibleText(sent, true, false), `<project_memory>\n[个人] 喜欢简洁回答\n继续使用中文\n</project_memory>\n\n${userText}`);
assert.equal(visibleText(sent, false, true), `<project_memory>\n[写作项目/风格] 保留标题\n</project_memory>\n\n${userText}`);
assert.equal(visibleText(sent, true, true), sent);
assert.equal(visibleText(userText, false, false), null);
assert.equal(visibleText(`用户引用了 ${block}\n${userText}`, false, false), null);
const currentBlock = `<project_memory>\n[个人/偏好] 使用中文\n[写作项目/目标] 完成文章\n</project_memory>\n\n${userText}`;
assert.equal(visibleText(currentBlock, true, false), `<project_memory>\n[个人/偏好] 使用中文\n</project_memory>\n\n${userText}`);
assert.equal(visibleText(currentBlock, false, true), `<project_memory>\n[写作项目/目标] 完成文章\n</project_memory>\n\n${userText}`);
assert.equal(visibleText(currentBlock, false, false), userText);

const rollover = `继续项目「写作项目」的工作。下面是接续资料，请仅作为背景，按最后的本轮问题作答。\n${block}\n<recent_progress>\n旧摘要\n</recent_progress>\n<current_question>\n${userText}\n</current_question>`;
assert.equal(visibleText(rollover, false, false), userText);
assert.equal(visibleText(rollover, true, false), `<project_memory>\n[个人] 喜欢简洁回答\n继续使用中文\n</project_memory>\n\n${userText}`);
assert.equal(visibleText(rollover, false, true), `<project_memory>\n[写作项目/风格] 保留标题\n</project_memory>\n\n${userText}`);
assert.equal(visibleText(rollover, true, true), rollover);

const personalTree = "## 个人记忆\n### 资料\n1. 文档作者\n\n### 偏好\n1. 使用中文\n    ## 项目记忆：这行是条目内容\n2. 回答简短";
const projectTree = "## 项目记忆：写作项目\n### 目标\n1. 完成文章\n\n### 约束\n1. 保留标题";
const structuredBlock = `<project_memory>\n以下附带个人记忆和项目目标与记忆，供本次会话参考。\n请结合背景回答下方问题，以用户当前要求为准。\n\n${personalTree}\n\n${projectTree}\n</project_memory>`;
const quotedQuestion = `${userText}\n引用：<current_question>示例</current_question>`;
const structured = `${structuredBlock}\n\n<current_question>\n${quotedQuestion}\n</current_question>`;
assert.equal(visibleText(structured, false, false), quotedQuestion);
assert.equal(visibleText(structured, true, false), `<project_memory>\n${personalTree}\n</project_memory>\n\n${quotedQuestion}`);
assert.equal(visibleText(structured, false, true), `<project_memory>\n${projectTree}\n</project_memory>\n\n${quotedQuestion}`);
assert.equal(visibleText(structured, true, true), structured);
const structuredRollover = `${structuredBlock}\n\n<recent_progress>\n旧会话摘要\n</recent_progress>\n\n<current_question>\n${quotedQuestion}\n</current_question>`;
assert.equal(visibleText(structuredRollover, false, false), quotedQuestion);
assert.equal(visibleText(structuredRollover, true, false), visibleText(structured, true, false));
assert.equal(visibleText(structuredRollover, false, true), visibleText(structured, false, true));
for (const [tree, personal, project] of [[personalTree, true, false], [projectTree, false, true]]) {
  const singleScope = `<project_memory>\n${tree}\n</project_memory>\n\n<current_question>\n${userText}\n</current_question>`;
  assert.equal(visibleText(singleScope, !personal, !project), userText, "另一范围开启时不能泄露隐藏范围的内容");
}

const editedQuestion = "改为分析文章的论据\n再列出三条建议";
for (const original of [sent, structured, rollover, structuredRollover]) {
  const question = visibleText(original, false, false);
  for (const [personal, project] of [[false, false], [true, false], [false, true], [true, true]]) {
    const shown = visibleText(original, personal, project);
    assert.equal(mergeEditedText(original, shown, personal, project), original, "只切换显示时保留原始发送内容");
    const merged = mergeEditedText(original, shown.replace(question, editedQuestion), personal, project);
    assert.equal(visibleText(merged, false, false), editedQuestion);
    assert.match(merged, original.includes("## 个人记忆") ? /1\. 使用中文/ : /喜欢简洁回答/);
    assert.match(merged, /保留标题/);
    if (original.includes("<recent_progress>")) assert.match(merged, /<recent_progress>/);
  }
}
const personalEdit = visibleText(structured, true, false).replace("使用中文", "使用中英双语").replace(quotedQuestion, editedQuestion);
const mergedPersonalEdit = mergeEditedText(structured, personalEdit, true, false);
assert.match(mergedPersonalEdit, /1\. 使用中英双语/);
assert.match(mergedPersonalEdit, /## 项目记忆：写作项目\n### 目标\n1\. 完成文章/);
assert.equal(visibleText(mergedPersonalEdit, false, false), editedQuestion);
const quotedMemory = "<project_memory>\n这是问题中的示例\n</project_memory>\n请解释";
assert.equal(visibleText(mergeEditedText(structured, quotedMemory, false, false), false, false), quotedMemory,
  "全部隐藏时问题里引用的记忆标签不能被误当成附带记忆");
assert.equal(mergeEditedText(userText, editedQuestion, false, false), editedQuestion);

console.log("memory-display-test: passed");
