/** Local DOM + IndexedDB test with mocked extension APIs; never contacts DeepSeek. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runMemoryHistoryChecks } from "./memory-history-checks.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const profile = await fs.mkdtemp(path.join(os.tmpdir(), "dtw-settings-test-"));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const connect = async (url) => {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => { socket.addEventListener("open", resolve, { once: true }); socket.addEventListener("error", reject, { once: true }); });
  let id = 0; const pending = new Map();
  socket.addEventListener("message", ({ data }) => {
    const message = JSON.parse(data);
    const callbacks = pending.get(message.id);
    if (!callbacks) return;
    pending.delete(message.id);
    message.error ? callbacks.reject(new Error(message.error.message)) : callbacks.resolve(message.result);
  });
  return { call(method, params = {}) { return new Promise((resolve, reject) => {
    const next = ++id; pending.set(next, { resolve, reject }); socket.send(JSON.stringify({ id: next, method, params }));
  }); }, close() { socket.close(); } };
};
const evaluate = async (cdp, expression) => {
  const result = await cdp.call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result.value;
};
async function waitFor(label, task) {
  for (let count = 0; count < 80; count++) { const result = await task(); if (result) return result; await delay(200); }
  throw new Error(`${label}超时`);
}
let browser; let page; let worker;
const chrome = spawn("C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", [
  "--headless=new", "--enable-extensions", "--no-first-run", "--disable-background-networking", "--remote-debugging-port=0", "--enable-unsafe-extension-debugging",
  `--user-data-dir=${profile}`, "--window-size=1600,1100", "about:blank",
], { windowsHide: true, stdio: "ignore" });
try {
  const port = await waitFor("调试端口", async () => {
    try { return Number((await fs.readFile(path.join(profile, "DevToolsActivePort"), "utf8")).split(/\r?\n/)[0]); } catch { return null; }
  });
  const targets = () => fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json());
  const version = await fetch(`http://127.0.0.1:${port}/json/version`).then((response) => response.json());
  browser = await connect(version.webSocketDebuggerUrl);
  const target = await browser.call("Target.createTarget", { url: "about:blank" });
  page = await connect((await waitFor("设置页", async () => (await targets()).find((item) => item.id === target.targetId))).webSocketDebuggerUrl);
  await page.call("Runtime.enable");
  await page.call("Page.enable");
  const dbSource = await fs.readFile(path.join(root, 'core/logic/db.js'), 'utf8');
  const backgroundSource = (await Promise.all(['workbench.js', 'session-memory.js'].map(name => fs.readFile(path.join(root, 'core/background', name), 'utf8')))).join('\n');
  const baseUrl = new URL('../core/', import.meta.url).href;
  const preload = `globalThis.importScripts=()=>{};
    const fixtureStorage={accountId:'ui-test-account','dtw.firstRunAtMs':Math.floor(Date.now()/60000)*60000+600}; let fixtureListener;
    globalThis.chrome={
      runtime:{getURL:(path='')=>${JSON.stringify(baseUrl)}+path,onMessage:{addListener(fn){fixtureListener=fn;}},onInstalled:{addListener(){}},
        sendMessage:async(message)=>{await globalThis.__fixtureReady;return new Promise(resolve=>fixtureListener(message,{url:location.href},resolve));}},
      storage:{local:{get:async(key)=>({[key]:fixtureStorage[key]}),set:async(values)=>Object.assign(fixtureStorage,values)}},
      tabs:{create:async()=>{throw new Error('This local test must never open a helper tab');},sendMessage:async()=>({ok:true}),remove:async()=>{}},
      alarms:{create(){},onAlarm:{addListener(){}}}
    };
    ${dbSource}
${backgroundSource}
    globalThis.__fixtureReady=(async()=>{
      await DTWDB.put('settings',{accountId:'ui-test-account',key:'automationPaused',value:true});
    })();`;
  await page.call('Page.addScriptToEvaluateOnNewDocument',{source:preload});
  await page.call('Page.navigate',{url:new URL('../core/options/options.html',import.meta.url).href});
  await waitFor('设置页脚本',()=>evaluate(page,"Boolean(document.getElementById('pauseQueue')) && Boolean(globalThis.DTWDB)"))
    .catch(async (error) => { throw new Error(`${error.message}: ${JSON.stringify(await evaluate(page,"({url:location.href,db:typeof globalThis.DTWDB,storage:typeof chrome?.storage,text:document.body.innerText.slice(0,300)})"))}`); });
  await evaluate(page,'globalThis.__fixtureReady');
  worker=page;
  await evaluate(worker, `(async () => {
    await DTWDB.put('settings',{accountId:'ui-test-account',key:'automationPaused',value:true});
    await DTWDB.put('projects',{accountId:'ui-test-account',projectId:'project-ui',name:'界面测试项目',createdAtMs:Date.now(),updatedAtMs:Date.now()});
    for (const project of [
      {projectId:'active-old',name:'更早的正常项目',createdAtMs:1,updatedAtMs:2},
      {projectId:'archived-old',name:'甲旧归档',archived:true,createdAtMs:1,updatedAtMs:10},
      {projectId:'archived-new',name:'乙新归档',archived:true,createdAtMs:2,updatedAtMs:30},
      {projectId:'archived-fallback',name:'丙按创建时间归档',archived:true,createdAtMs:20}])
      await DTWDB.put('projects',{accountId:'ui-test-account',...project});
    for (const [memoryId,kind,content,scope,projectId] of [
      ['personal-a','资料','我是软件开发者','PERSONAL',null], ['personal-b','偏好','以后用中文回答','PERSONAL',null],
      ['project-a','目标','完成体验改进','PROJECT','project-ui']])
      await DTWDB.put('memories',{accountId:'ui-test-account',memoryId,kind,content,scope,projectId,state:'ACTIVE',version:1,updatedAtMs:Date.now(),pinnedByUser:true});
    for (const [index,type] of ['CLASSIFY','DISTILL','ROLLOVER'].entries())
      await DTWDB.put('jobs',{accountId:'ui-test-account',jobId:'queue-'+index,type,status:'QUEUED',createdAtMs:Date.now()+index,updatedAtMs:Date.now(),projectId:'project-ui',
        ...(type==='DISTILL'?{sessionVersion:2,memoryScope:'PROJECT',updateScopes:['PROJECT'],sessionRef:{sessionId:'fixture-old',createdAtMs:100},sourceSessionId:'fixture-old',attempt:2}: {})});
  })()`);
  await page.call("Page.reload");
  await waitFor("记忆分组", () => evaluate(page, "document.querySelectorAll('.memory-group').length === 5"));
  assert.deepEqual(await evaluate(page, "[...document.querySelector('#maxContextTokens').options].map(option=>Number(option.value))"),
    [32000,64000,128000,256000,384000,512000,768000,1000000]);
  assert.equal(await evaluate(page, "document.querySelector('#maxContextTokens').value"), '256000');
  assert.match(await evaluate(page, "document.querySelector('#maxContextTokens').selectedOptions[0].textContent"), /默认.*推荐/);
  assert.equal(await evaluate(page, "document.querySelector('#warningRatio').value"), '1');
  assert.deepEqual(await evaluate(page, "[...document.querySelectorAll('#scopes button')].map(button=>button.textContent.split('（')[0])"),
    ['个人记忆','界面测试项目','更早的正常项目','乙新归档','丙按创建时间归档','甲旧归档'], '记忆管理中归档项目置底，各组按更新时间从新到旧排序');
  assert.equal(await evaluate(page, "[...document.querySelectorAll('#scopes button')].slice(-3).every(button=>button.textContent.endsWith('已归档'))"), true);
  assert.deepEqual(await evaluate(page, "[...document.querySelectorAll('#archived .row span')].map(span=>span.textContent)"),
    ['乙新归档','丙按创建时间归档','甲旧归档']);
  await evaluate(page, "[...document.querySelectorAll('#scopes button')].find(button=>button.textContent.startsWith('乙新归档')).click()");
  assert.equal(await evaluate(page, "document.querySelector('#scopeTitle').textContent"), '乙新归档', '归档项目的记忆仍可查看');
  await evaluate(page, "document.querySelector('#scopes button').click()");
  await evaluate(page, "[...document.querySelectorAll('#archived .row')].find(row=>row.textContent.startsWith('甲旧归档')).querySelector('button').click()");
  await waitFor('恢复归档后同步记忆目录',()=>evaluate(page,"document.querySelectorAll('#scopes button')[1].textContent==='甲旧归档（0）'"));
  assert.equal(await evaluate(page, "document.querySelector('#memoryStartAtMs').value.length > 0"), true);
  assert.equal(await evaluate(page, "Boolean(document.querySelector('#distillEveryTurns'))"), false);
  assert.equal(await evaluate(page, "document.querySelector('#distill').hidden"), false, "没有待处理会话时仍保留主动更新入口");
  assert.equal(await evaluate(page, "document.querySelectorAll('#automationQueue .row').length"), 3);
  assert.match(await evaluate(page, "document.querySelector('#automationQueue .queue-batch').textContent"), /1 个旧会话 · 更新：项目记忆（界面测试项目） · 第 1 次重试/);
  assert.equal(await evaluate(page, "document.querySelector('#pauseQueue').textContent"), "继续队列");
  assert.equal(await evaluate(page, "document.querySelectorAll('.memory-entry button').length"), 0);
  assert.equal(await evaluate(page, "document.querySelectorAll('.memory-entry input').length"), 0);
  assert.equal(await evaluate(page, "Boolean(document.querySelector('#add'))"), false);
  assert.equal(await evaluate(page, "document.querySelectorAll('.category-edit').length"), 5);
  assert.equal(await evaluate(page, "document.querySelectorAll('.settings-section p.hint').length"), 0);
  assert.match(await evaluate(page, "document.querySelector('#scopeHint').textContent"), /本地保留最近 .* 份记忆快照/);
  assert.match(await evaluate(page, "document.querySelector('#scopeHint').textContent"), /\/5000 字/);
  assert.equal(await evaluate(page, "document.querySelector('.help-tip').matches(':popover-open')"), false);
  const hintPosition = await evaluate(page, "(()=>{const rect=document.querySelector('.help-trigger').getBoundingClientRect();return {x:rect.x+rect.width/2,y:rect.y+rect.height/2};})()");
  await page.call("Input.dispatchMouseEvent", { type: "mouseMoved", ...hintPosition });
  assert.equal(await evaluate(page, "document.querySelector('.help-tip').matches(':popover-open')"), true);
  await page.call("Input.dispatchMouseEvent", { type: "mouseMoved", x: 0, y: 0 });
  await waitFor("移开详情提示", () => evaluate(page, "!document.querySelector('.help-tip').matches(':popover-open')"));
  await evaluate(page, "document.querySelector('.help-trigger').focus()");
  assert.equal(await evaluate(page, "document.querySelector('.help-tip').matches(':popover-open')"), true);
  await evaluate(page, "document.querySelector('.help-trigger').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));document.activeElement.blur()");
  assert.equal(await evaluate(page, "document.querySelector('.help-tip').matches(':popover-open')"), false);
  await evaluate(page, "document.querySelectorAll('#automationQueue .row')[2].querySelector('button').click()");
  await waitFor("队列调序", () => evaluate(worker, "DTWDB.get('jobs',['ui-test-account','queue-2']).then(job=>job.queueOrder===1)"));
  await evaluate(page, "window.confirm=()=>true; document.querySelector('#automationQueue .row').querySelectorAll('button')[2].click()");
  await waitFor("取消等待任务", () => evaluate(worker, "DTWDB.get('jobs',['ui-test-account','queue-0']).then(job=>job.status==='CANCELLED')"));
  const unchangedStart = await evaluate(page, "chrome.runtime.sendMessage({type:'dtw:snapshot',accountId:'ui-test-account'}).then(data=>data.settings.memoryStartAtMs)");
  assert.equal(await evaluate(page, "Boolean(document.querySelector('#save'))"), false);
  await evaluate(page, "document.querySelector('#memoryStartAtMs').dispatchEvent(new Event('change'))");
  await waitFor("未修改日期", () => evaluate(page, "!document.querySelector('#memoryStartAtMs').disabled"));
  assert.equal(await evaluate(page, "chrome.runtime.sendMessage({type:'dtw:snapshot',accountId:'ui-test-account'}).then(data=>data.settings.memoryStartAtMs)"), unchangedStart,
    "未修改日期应保留首次运行时间的毫秒精度");
  for (const [key, value] of [["maxContextTokens", 128000], ["maxContextTokens", 384000], ["maxContextTokens", 512000],
    ["maxContextTokens", 768000], ["maxContextTokens", 1000000], ["warningRatio", 0.95], ["replyReserveTokens", 8000],
    ["memoryModeDefault", true], ["showPersonalMemory", true], ["showProjectMemory", true]]) {
    await evaluate(page, `(()=>{const input=document.getElementById(${JSON.stringify(key)});
      input[input.type==='checkbox'?'checked':'value']=${JSON.stringify(value)};input.dispatchEvent(new Event('change'));})()`);
    await waitFor(`自动保存 ${key}`, () => evaluate(worker,
      `DTWDB.get('settings',['ui-test-account',${JSON.stringify(key)}]).then(row=>row?.value===${JSON.stringify(value)})`));
    await waitFor(`解除禁用 ${key}`, () => evaluate(page, `!document.getElementById(${JSON.stringify(key)}).disabled`));
  }
  await page.call("Page.reload");
  await waitFor("重新加载自选预算", () => evaluate(page, "document.querySelector('#maxContextTokens').value==='1000000' && document.querySelector('#warningRatio').value==='0.95' && document.querySelector('#replyReserveTokens').value==='8000'"));
  await evaluate(page, "document.querySelector('#memoryStartAtMs').value='';document.querySelector('#memoryStartAtMs').dispatchEvent(new Event('change'))");
  await waitFor("无效日期回退", () => evaluate(page, "document.querySelector('#settingsNotice').textContent.includes('有效的记忆起始时间') && document.querySelector('#memoryStartAtMs').value.length>0"));
  await evaluate(page, `globalThis.originalSettingsSend=chrome.runtime.sendMessage;
    chrome.runtime.sendMessage=async(message)=>message.type==='dtw:settings-update'?{ok:false,error:'模拟保存失败'}:originalSettingsSend(message);
    document.querySelector('#showPersonalMemory').checked=false;document.querySelector('#showPersonalMemory').dispatchEvent(new Event('change'));`);
  await waitFor("失败设置回退", () => evaluate(page, "document.querySelector('#settingsNotice').textContent==='模拟保存失败' && document.querySelector('#showPersonalMemory').checked"));
  await evaluate(page, "chrome.runtime.sendMessage=originalSettingsSend;document.querySelector('#memoryStartAtMs').value='2020-01-01T00:00:00';document.querySelector('#memoryStartAtMs').dispatchEvent(new Event('change'))");
  const changedStart = await evaluate(page, "new Date(document.querySelector('#memoryStartAtMs').value).getTime()");
  await waitFor("日期自动生效", () => evaluate(worker, `DTWDB.get('settings',['ui-test-account','memoryStartAtMs']).then(row=>row?.value===${changedStart})`));
  assert.equal(await evaluate(worker, `(async()=>{
    const rows=(await DTWDB.all('memories','ui-test-account')).filter(row=>row.scope==='PERSONAL');
    rows[1].version=999;
    try{await DTWDB.removeMemories('ui-test-account',rows,'memoryEpoch:PERSONAL:',99);return false;}catch{return true;}
  })()`), true);
  assert.equal(await evaluate(worker, "DTWDB.all('memories','ui-test-account').then(rows=>rows.length)"), 3,
    "数据库事务失败必须回滚全部删除");
  assert.equal(await evaluate(worker, "DTWDB.get('settings',['ui-test-account','memoryEpoch:PERSONAL:']).then(row=>row===null)"), true);
  await evaluate(page, "document.querySelector('#manageSelection').click();document.querySelector('#selectAll').click()");
  assert.equal(await evaluate(page, "document.querySelector('#deleteSelected').textContent"), "删除所选（2）");
  await evaluate(page, "[...document.querySelectorAll('#scopes button')].find(button=>button.textContent.startsWith('界面测试项目')).click()");
  assert.equal(await evaluate(page, "document.querySelectorAll('.memory-group').length"), 7);
  assert.equal(await evaluate(page, "document.querySelector('#deleteSelected').disabled"), true);
  await evaluate(page, "document.querySelector('#scopes button').click()");
  await evaluate(page, `document.querySelector('[aria-label="编辑资料类别"]').click();
    const fields=document.querySelectorAll('#categoryEntries textarea');
    fields[0].value='我是软件开发者\\n主要写前端';fields[1].value='常用 TypeScript';fields[1].dispatchEvent(new Event('input'));`);
  assert.equal(await evaluate(page, "document.querySelectorAll('#categoryEntries textarea').length"), 3);
  await evaluate(page, "window.dispatchEvent(new Event('focus'))");
  await delay(100);
  assert.equal(await evaluate(page, "document.querySelector('#categoryEntries textarea').value"), "我是软件开发者\n主要写前端");
  await evaluate(page, "document.querySelector('#saveCategory').click()");
  await waitFor("保存个人类别", () => evaluate(page, "!document.querySelector('#memoryEditor').open && document.querySelector('#notice').textContent === '「资料」已保存'"));
  let profileRows = await evaluate(worker, "DTWDB.all('memories','ui-test-account').then(rows=>rows.filter(row=>row.kind==='资料'))");
  assert.equal(profileRows.length, 2);
  assert.equal(profileRows.find((row) => row.memoryId === "personal-a").content, "我是软件开发者\n主要写前端");
  assert.equal(profileRows.find((row) => row.memoryId === "personal-a").version, 2);
  assert.equal(await evaluate(worker, "DTWDB.get('memories',['ui-test-account','personal-b']).then(row=>row.version)"), 1);
  const categoryEpoch = await evaluate(worker, "DTWDB.get('settings',['ui-test-account','memoryEpoch:PERSONAL:']).then(row=>row.value)");
  await evaluate(page, "document.querySelector('[aria-label=编辑资料类别]').click();document.querySelector('#saveCategory').click()");
  await waitFor("未修改保存", () => evaluate(page, "!document.querySelector('#memoryEditor').open"));
  assert.equal(await evaluate(worker, "DTWDB.get('settings',['ui-test-account','memoryEpoch:PERSONAL:']).then(row=>row.value)"), categoryEpoch);
  await evaluate(page, "document.querySelector('[aria-label=编辑资料类别]').click()");
  await evaluate(worker, "DTWDB.get('memories',['ui-test-account','personal-a']).then(row=>DTWDB.put('memories',{...row,version:3}))");
  await evaluate(page, "document.querySelector('#categoryEntries textarea').value='这个修改不应被保存';document.querySelector('#saveCategory').click()");
  await waitFor("类别版本冲突", () => evaluate(page, "document.querySelector('#editorNotice').textContent.includes('重新打开类别')"));
  assert.equal(await evaluate(page, "document.querySelector('#memoryEditor').open"), true);
  assert.equal(await evaluate(worker, "DTWDB.all('memories','ui-test-account').then(rows=>rows.some(row=>row.content==='这个修改不应被保存'))"), false);
  await evaluate(page, "document.querySelector('#cancelEdit').click();document.querySelector('#refresh').click()");
  await waitFor("刷新类别", () => evaluate(page, "document.querySelector('#notice').textContent === '已刷新项目和记忆'"));
  await evaluate(page, "document.querySelector('[aria-label=编辑资料类别]').click();document.querySelectorAll('#categoryEntries textarea')[0].value='长'.repeat(3000);document.querySelectorAll('#categoryEntries textarea')[1].value='长'.repeat(2000);document.querySelector('#saveCategory').click()");
  await waitFor("个人预算检查", () => evaluate(page, "document.querySelector('#editorNotice').textContent.includes('5000 字')"));
  assert.equal(await evaluate(worker, "DTWDB.all('memories','ui-test-account').then(rows=>rows.length)"), 4);
  await evaluate(page, "document.querySelector('#cancelEdit').click();document.querySelector('[aria-label=编辑资料类别]').click()");
  const addition = profileRows.find((row) => row.memoryId !== "personal-a").memoryId;
  await evaluate(page, `document.querySelector('[data-memory-id="${addition}"]').value='';window.confirm=()=>true;document.querySelector('#saveCategory').click()`);
  await waitFor("清空类别条目", () => evaluate(page, "!document.querySelector('#memoryEditor').open"));
  assert.equal(await evaluate(worker, "DTWDB.all('memories','ui-test-account').then(rows=>rows.length)"), 3);
  await evaluate(page, "[...document.querySelectorAll('#scopes button')].find(button=>button.textContent.startsWith('界面测试项目')).click();document.querySelector('[aria-label=编辑目标类别]').click();document.querySelector('#categoryEntries textarea').value='完成简约设置界面';document.querySelector('#saveCategory').click()");
  await waitFor("保存项目类别", () => evaluate(page, "!document.querySelector('#memoryEditor').open"));
  assert.equal(await evaluate(worker, "DTWDB.get('memories',['ui-test-account','project-a']).then(row=>row.content)"), "完成简约设置界面");
  await evaluate(page, "document.querySelector('#scopes button').click()");
  await evaluate(page, `(function(){ const original = chrome.runtime.sendMessage.bind(chrome.runtime);
    chrome.runtime.sendMessage = async function(message){const data=await original(message);if(message.type==='dtw:snapshot')delete data.personalMemoryBudget;return data;};
    document.querySelector('#refresh').click(); })()`);
  await waitFor("缺失预算兼容", () => evaluate(page, "document.querySelector('#scopeHint').textContent.includes('记忆预算暂不可用')"));
  assert.equal(await evaluate(page, "document.querySelector('#notice').className.includes('error')"), false);
  await evaluate(page, "document.querySelector('#notice').textContent='';document.querySelector('#settingsNotice').textContent=''");
  await fs.mkdir(path.join(root, ".live-fs"), { recursive: true });
  await evaluate(worker, `(async()=>{
    await DTWDB.put('jobs',{accountId:'ui-test-account',jobId:'failed-policy',type:'CLASSIFY',status:'FAILED',error:'本地模拟任务未完成',createdAtMs:Date.now(),updatedAtMs:Date.now()});
    await DTWDB.put('settings',{accountId:'ui-test-account',key:'requestIssue',value:{code:'AUTH_REQUIRED',message:'DeepSeek 登录已失效，插件请求已停止，请通过原生页面重新登录',observedAtMs:Date.now()}});
  })()`);
  await evaluate(page, "document.querySelector('#refreshQueue').click()");
  await waitFor("持续红色提醒", () => evaluate(page, "!document.querySelector('#automationAlert').hidden && document.querySelector('#automationAlertDetail').textContent.includes('登录已失效')"));
  assert.equal(await evaluate(page, "document.querySelector('#resumeRequests').hidden"), true, "登录失效只通知，不提供登录验证按钮");
  assert.equal(await evaluate(page, "document.querySelector('#viewIssues').hidden"), false);
  assert.match(await evaluate(page, "document.querySelector('#jobs').textContent"), /本地模拟任务未完成/);
  await evaluate(page, "scrollTo(0,0)");
  const screenshot = await page.call("Page.captureScreenshot", { format: "png" });
  await fs.writeFile(path.join(root, ".live-fs", "settings-ui.png"), Buffer.from(screenshot.data, "base64"));
  await page.call("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: false });
  assert.equal(await evaluate(page, "document.documentElement.scrollWidth <= innerWidth"), true);
  const narrowShot = await page.call("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
  await fs.writeFile(path.join(root, ".live-fs", "settings-ui-narrow.png"), Buffer.from(narrowShot.data, "base64"));
  await page.call("Emulation.setDeviceMetricsOverride", { width: 1600, height: 1100, deviceScaleFactor: 1, mobile: false });
  await page.call("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] });
  await delay(200);
  assert.equal(await evaluate(page, "getComputedStyle(document.querySelector('#refresh')).backgroundColor"), "rgb(32, 35, 40)");
  const darkShot = await page.call("Page.captureScreenshot", { format: "png" });
  await fs.writeFile(path.join(root, ".live-fs", "settings-ui-dark.png"), Buffer.from(darkShot.data, "base64"));
  await page.call("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] });
  await evaluate(page, "window.confirm=()=>true;document.querySelector('#manageSelection').click(); document.querySelector('#selectAll').click(); document.querySelector('#deleteSelected').click()");
  await waitFor("个人批量删除", () => evaluate(page, "document.querySelector('#notice').textContent === '已删除 2 条记忆'"));
  assert.equal(await evaluate(worker, "DTWDB.all('memories','ui-test-account').then(rows=>rows.length)"), 1);
  await evaluate(page, "[...document.querySelectorAll('#scopes button')].find(button=>button.textContent.startsWith('界面测试项目')).click();document.querySelector('#manageSelection').click();document.querySelector('#selectAll').click();document.querySelector('#deleteSelected').click()");
  await waitFor("项目批量删除", () => evaluate(page, "document.querySelector('#notice').textContent === '已删除 1 条记忆'"));
  assert.equal(await evaluate(worker, "DTWDB.all('memories','ui-test-account').then(rows=>rows.length)"), 0);
  await page.call("Page.navigate", { url: new URL("../core/manage/manage.html", import.meta.url).href });
  await waitFor("独立记忆页", () => evaluate(page, "document.querySelectorAll('.memory-group').length===5"));
  assert.equal(await evaluate(page, "document.querySelectorAll('.memory-entry button').length"), 0);
  await evaluate(page, "document.querySelector('[aria-label=编辑工作方式类别]').click();document.querySelector('#categoryEntries textarea').value='先确认目标再执行';document.querySelector('#saveCategory').click()");
  await waitFor("空类别保存", () => evaluate(page, "!document.querySelector('#memoryEditor').open"));
  assert.equal(await evaluate(page, "chrome.runtime.sendMessage({type:'dtw:snapshot',accountId:'ui-test-account'}).then(data=>data.memories[0].kind)"), "工作方式");
  const atomic = await evaluate(page, `(async()=>{
    let aborted=false;
    try { await DTWDB.commitMemoryBatch('ui-test-account',[],()=>({
      memories:[{accountId:'ui-test-account',memoryId:'atomic-test',content:'不应部分保存'}],
      memoryTurns:[{accountId:'ui-test-account',turnKey:'atomic-test',state:'DONE'}],
      jobs:[{accountId:'ui-test-account'}]
    })); } catch { aborted=true; }
    return {aborted,memory:await DTWDB.get('memories',['ui-test-account','atomic-test']),turn:await DTWDB.get('memoryTurns',['ui-test-account','atomic-test'])};
  })()`);
  assert.deepEqual(atomic, {aborted:true,memory:null,turn:null}, '真实 IndexedDB 写入失败必须回滚整个事务');
  const storedBatch = await evaluate(page, `(async()=>{
    chrome.tabs.create=async()=>({id:42});
    const call=body=>chrome.runtime.sendMessage({accountId:'ui-test-account',...body});
    await call({type:'dtw:settings-update',key:'memoryStartAtMs',value:1});
    await call({type:'dtw:session-observe',sessionId:'atomic-session',loadedHistory:true,createdAtMs:100});
    await call({type:'dtw:membership-move',sessionId:'atomic-session',projectId:'project-ui'});
    await call({type:'dtw:history-observe',sessionId:'atomic-session',currentMessageId:2,records:[
      {messageId:1,parentId:null,role:'USER',status:'FINISHED',fragments:[{type:'REQUEST',content:'用中文；项目完成'}]},
      {messageId:2,parentId:1,role:'ASSISTANT',status:'FINISHED',fragments:[{type:'RESPONSE',content:'确认'}]}
    ]});
    await call({type:'dtw:session-observe',sessionId:'active-session',loadedHistory:true,createdAtMs:200});
    const batches=(await DTWDB.all('jobs','ui-test-account')).filter(job=>job.sessionVersion && job.sourceSessionId==='atomic-session');
    let reply;
    for(const batch of batches) {
      await prepareMemoryJob(batch);await DTWDB.put('jobs',{...batch,status:'RUNNING',tabId:42});
      const kept=(await DTWDB.all('memories','ui-test-account')).filter(row=>row.scope===batch.memoryScope
        && ['ACTIVE','STALE'].includes(row.state) && (row.scope!=='PROJECT'||row.projectId===batch.projectId))
        .map(row=>({memoryId:row.memoryId,kind:row.kind,content:row.content}));
      const item=batch.memoryScope==='PERSONAL'?{kind:'偏好',content:'长期使用中文'}:{kind:'进展',content:'项目完成'};
      reply=await new Promise(resolve=>fixtureListener({accountId:'ui-test-account',type:'dtw:automation-result',jobId:batch.jobId,
        raw:JSON.stringify({memories:[...kept,{memoryId:'',...item}]})},
        {url:location.href,tab:{id:42,url:'https://chat.deepseek.com/'}},resolve));
    }
    return {reply,ledger:(await DTWDB.all('memoryTurns','ui-test-account')).length,
      pending:(await DTWDB.get('projects',['ui-test-account','dtw-personal-memory'])).pendingSessionRefs.length,
      contents:(await DTWDB.all('memories','ui-test-account')).map(row=>row.content)};
  })()`);
  assert.equal(storedBatch.reply.status, 'DONE', JSON.stringify(storedBatch));
  assert.equal(storedBatch.ledger,2); assert.equal(storedBatch.pending,0);
  assert.ok(storedBatch.contents.includes('长期使用中文') && storedBatch.contents.includes('项目完成'));
  await runMemoryHistoryChecks((expression) => evaluate(page, expression), async () => {
    await page.call('Page.reload');
    await waitFor('重启后的后台脚本',()=>evaluate(page,"Boolean(globalThis.__fixtureReady) && document.readyState==='complete'"));
  });
  const upgrade = await evaluate(page, `(async()=>{
    const original=globalThis.DTWDB;
    const current=${JSON.stringify(await fs.readFile(path.join(root,'core/logic/db.js'),'utf8'))}.replace('"deepseek-task-workbench"','"dtw-upgrade-test"');
    try {
      const old=await new Promise((resolve,reject)=>{
        const request=indexedDB.open('dtw-upgrade-test',2);
        request.onupgradeneeded=()=>{
          const store=request.result.createObjectStore('memories',{keyPath:['accountId','memoryId']});
          store.createIndex('byAccount','accountId');
          store.put({accountId:'upgrade-account',memoryId:'preserved',content:'已有记忆'});
        };
        request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);
      }); old.close();
      (0,eval)(current); const database=await DTWDB.open();
      const result={version:database.version,stores:[...database.objectStoreNames],memory:await DTWDB.get('memories',['upgrade-account','preserved'])};
      database.close();return result;
    } finally {globalThis.DTWDB=original;}
  })()`);
  assert.equal(upgrade.version,3); assert.ok(upgrade.stores.includes('memoryTurns') && upgrade.stores.includes('memoryHistory')); assert.equal(upgrade.memory.content,'已有记忆');
  const displaySource = await fs.readFile(path.join(root, "core/logic/memory-display.js"), "utf8");
  const historySource = await fs.readFile(path.join(root, "core/logic/history-core.js"), "utf8");
  const contentSource = (await fs.readFile(path.join(root, "core/content/workbench.js"), "utf8"))
    .replace("  injectPageHook();", "")
    .replace('  const currentId = () => idFromHref(location.href);', '  const currentId = () => globalThis.fixtureRoute ?? "message-edit-session";')
    .replace('  start().catch((error) => console.warn("[DeepSeek 项目工作台]", error));',
      "  globalThis.messageDisplayFixture = { state, renderUserMessage, renderMessageInfo, renderMemoryEditors, findEditor, observeMessageDisplay, checkTurn, currentRequestIssue, waitEditor, submit, memorySend, initializeAccount, confirmUserMessage, doProjectSend, mockHistory(fn) { const previous = history; history = fn; return () => { history = previous; }; } };");
  const messageDisplay = await evaluate(page, `(()=>{
    const addListener=chrome.runtime.onMessage.addListener;
    chrome.runtime.onMessage.addListener=fn=>globalThis.contentMessageListener=fn;
    try {(0,eval)(${JSON.stringify(historySource)});(0,eval)(${JSON.stringify(displaySource)});(0,eval)(${JSON.stringify(contentSource)});}
    finally {chrome.runtime.onMessage.addListener=addListener;}
    const host=document.createElement('section');document.body.append(host);
    const prompts=[
      '<project_memory>\\n[个人/偏好] 使用中文\\n[测试项目/目标] 完成文章\\n</project_memory>\\n\\n请总结',
      '<project_memory>\\n以下附带个人记忆和项目记忆，供会话参考。\\n请回答下方本轮问题。\\n\\n## 个人记忆\\n### 偏好\\n1. 使用中文\\n2. 回答简短\\n\\n## 项目记忆：测试项目\\n### 目标\\n1. 完成文章\\n</project_memory>\\n\\n<current_question>\\n请总结\\n</current_question>'
    ];
    const results=[];let copied=0;
    for (const original of prompts) {
      const record={messageId:1,fragments:[{type:'REQUEST',content:original}]};
      for (const nativeMemory of [false,true]) {
        const bubble=document.createElement('div');const text=document.createElement('span');
        text.textContent=nativeMemory?original:'请总结';bubble.append(text);
        const copy=document.createElement('button');copy.textContent='复制';copy.onclick=()=>copied++;bubble.append(copy);host.append(bubble);
        for (const [personal,project] of [[true,false],[false,true],[true,true],[false,false]]) {
          messageDisplayFixture.state.snapshot={settings:{showPersonalMemory:personal,showProjectMemory:project}};
          messageDisplayFixture.renderUserMessage(bubble,record);
          const panel=host.querySelector('.dtw-visible-memory');
          const displayed=bubble.textContent+(panel?.textContent||'');
          results.push({nativeMemory,personal,project,hasPersonal:displayed.includes('使用中文'),hasProject:displayed.includes('完成文章'),
            structured:original.includes('## 个人记忆'),personalHeading:displayed.includes('## 个人记忆'),projectHeading:displayed.includes('## 项目记忆：'),
            personalNumbering:displayed.includes('1. 使用中文\\n2. 回答简短'),projectNumbering:displayed.includes('1. 完成文章'),
            hasQuestion:displayed.includes('请总结'),sameCopy:bubble.querySelector('button')===copy,panels:host.querySelectorAll('.dtw-visible-memory').length});
          copy.click();
        }
        bubble.remove();host.querySelectorAll('.dtw-visible-memory').forEach(node=>node.remove());
      }
    }
    host.remove();return {results,copied};
  })()`);
  assert.equal(messageDisplay.copied, 16);
  for (const row of messageDisplay.results) {
    assert.equal(row.hasPersonal, row.personal, JSON.stringify(row));
    assert.equal(row.hasProject, row.project, JSON.stringify(row));
    if (row.structured) {
      assert.equal(row.personalHeading, row.personal, JSON.stringify(row));
      assert.equal(row.projectHeading, row.project, JSON.stringify(row));
      assert.equal(row.personalNumbering, row.personal, JSON.stringify(row));
      assert.equal(row.projectNumbering, row.project, JSON.stringify(row));
    }
    assert.equal(row.hasQuestion, true); assert.equal(row.sameCopy, true);
    assert.ok(row.panels <= 1);
  }
  const memoryEditing = await evaluate(page, `(()=>{
    const host=document.createElement('section');document.body.append(host);
    const composer=document.createElement('textarea');composer.id='chat-input';host.append(composer);
    const original='<project_memory>\\n背景资料\\n\\n## 个人记忆\\n### 偏好\\n1. 使用中文\\n\\n## 项目记忆：测试项目\\n### 目标\\n1. 完成文章\\n</project_memory>\\n\\n<current_question>\\n请总结\\n</current_question>';
    composer.value=original;
    const contexts=[];const onContext=event=>contexts.push(JSON.parse(event.detail).contexts);
    window.addEventListener('dtw:edit-context',onContext);
    const results=[];
    for (const tag of ['textarea','div']) {
      const bubble=document.createElement('div');bubble.dataset.messageAuthorRole='user';host.append(bubble);
      let editor=document.createElement(tag);
      if(tag==='div'){editor.contentEditable='true';editor.style.whiteSpace='pre-wrap';editor.textContent=original;}else editor.value=original;
      const cancel=document.createElement('button');cancel.textContent='取消';bubble.append(editor,cancel);
      const record={messageId:1,role:'USER',fragments:[{type:'REQUEST',content:original}]};
      messageDisplayFixture.state.lastHistory={conversationId:'message-edit-session',records:[record]};
      messageDisplayFixture.state.snapshot={settings:{showPersonalMemory:false,showProjectMemory:false}};
      editor.focus();messageDisplayFixture.renderMemoryEditors();messageDisplayFixture.renderUserMessage(bubble,record);
      if(tag==='textarea')editor.value='修改后的问题';else editor.textContent='修改后的问题';
      editor.dispatchEvent(new InputEvent('input',{bubbles:true}));
      if(tag==='textarea')editor.setSelectionRange(0,2);
      for(const [personal,project] of [[false,false],[true,false],[false,true],[true,true],[false,false]]) {
        messageDisplayFixture.state.snapshot.settings={showPersonalMemory:personal,showProjectMemory:project};
        messageDisplayFixture.renderMemoryEditors();
        const value=tag==='textarea'?editor.value:editor.innerText;
        results.push({tag,personal,project,hasPersonal:value.includes('使用中文'),hasProject:value.includes('完成文章'),
          question:DTWMemoryDisplay.visibleText(value,false,false)??value,
          selection:tag==='textarea'?value.slice(editor.selectionStart,editor.selectionEnd):'修改',
          composerUnchanged:composer.value===original,normalComposer:messageDisplayFixture.findEditor()===composer,
          sameCancel:bubble.querySelector('button')===cancel,panels:host.querySelectorAll('.dtw-visible-memory').length});
      }
      const context=contexts.at(-1)?.[0];
      results.push({restored:context?.prompt,visible:context?.visible,messageId:context?.messageId,expectedQuestion:'修改后的问题'});
      const replacement=editor.cloneNode(false);
      if(tag==='textarea')replacement.value=editor.value;else replacement.textContent=editor.textContent;
      editor.replaceWith(replacement);editor=replacement;messageDisplayFixture.renderMemoryEditors();
      if(tag==='textarea')editor.value='替换节点后的问题';else editor.textContent='替换节点后的问题';
      editor.dispatchEvent(new InputEvent('input',{bubbles:true}));
      const remounted=contexts.at(-1)?.[0];
      results.push({restored:remounted?.prompt,visible:remounted?.visible,messageId:remounted?.messageId,expectedQuestion:'替换节点后的问题'});
      bubble.remove();messageDisplayFixture.renderMemoryEditors();
    }
    const cleared=contexts.at(-1).length===0;
    const plain=document.createElement('textarea');plain.value='普通历史问题';host.append(plain);
    messageDisplayFixture.renderMemoryEditors();const plainUnchanged=plain.value==='普通历史问题';
    host.remove();window.removeEventListener('dtw:edit-context',onContext);
    return {results,cleared,plainUnchanged};
  })()`);
  for (const row of memoryEditing.results) {
    if ('restored' in row) {
      assert.equal(row.visible,row.expectedQuestion);assert.equal(row.messageId,1);
      assert.match(row.restored,/使用中文/);assert.match(row.restored,/完成文章/);
      assert.ok(row.restored.endsWith('<current_question>\n'+row.expectedQuestion+'\n</current_question>'));
    } else {
      assert.equal(row.hasPersonal,row.personal,JSON.stringify(row));assert.equal(row.hasProject,row.project,JSON.stringify(row));
      assert.equal(row.question,'修改后的问题');assert.equal(row.selection,'修改');
      assert.equal(row.composerUnchanged,true);assert.equal(row.normalComposer,true);assert.equal(row.sameCancel,true);assert.equal(row.panels,0);
    }
  }
  assert.equal(memoryEditing.cleared,true);assert.equal(memoryEditing.plainUnchanged,true);
  const cancelledEditing = await evaluate(page, `(async()=>{
    const host=document.createElement('section');document.body.append(host);
    const composer=document.createElement('textarea');composer.id='chat-input';composer.value='新的草稿';host.append(composer);
    const original='<project_memory>\\n背景资料\\n\\n## 个人记忆\\n### 偏好\\n1. 使用中文\\n\\n## 项目记忆：测试项目\\n### 目标\\n1. 完成文章\\n</project_memory>\\n\\n<current_question>\\n请总结\\n</current_question>';
    const record={messageId:1,parentId:null,role:'USER',fragments:[{type:'REQUEST',content:original}]};
    const state=messageDisplayFixture.state;
    state.lastHistory={conversationId:'message-edit-session',currentMessageId:1,records:[record]};
    state.messageInfoPending=false;
    const contexts=[];const onContext=event=>contexts.push(JSON.parse(event.detail).contexts);
    window.addEventListener('dtw:edit-context',onContext);
    const nextPaint=()=>new Promise(resolve=>requestAnimationFrame(resolve));
    const observer=messageDisplayFixture.observeMessageDisplay();
    const results=[];
    try {
      for(const tag of ['textarea','div']) for(const [personal,project] of [[false,false],[true,false],[false,true],[true,true]]) {
        state.snapshot={settings:{showPersonalMemory:personal,showProjectMemory:project},memberships:[],
          sessions:[{sessionId:'message-edit-session',purpose:'USER'}]};
        let bubble=document.createElement('div');bubble.dataset.messageAuthorRole='user';host.append(bubble);
        let text;const edit=document.createElement('button');edit.textContent='编辑';
        const restore=()=>{text=document.createElement('span');text.textContent=original;bubble.replaceChildren(text,edit);};
        restore();await nextPaint();
        edit.onclick=()=>{
          const editor=document.createElement(tag);
          if(tag==='textarea')editor.value=original;else {editor.contentEditable='true';editor.style.whiteSpace='pre-wrap';editor.textContent=original;}
          const cancel=document.createElement('button');cancel.textContent='取消';cancel.onclick=restore;
          bubble.replaceChildren(editor,cancel);
        };
        const capture=stage=>{
          const visible=bubble.textContent;
          results.push({tag,personal,project,stage,hasPersonal:visible.includes('使用中文'),hasProject:visible.includes('完成文章'),
            question:DTWMemoryDisplay.visibleText(text.textContent,false,false)??text.textContent,
            sameEdit:bubble.querySelector('button')===edit,composer:composer.value,
            pending:state.messageInfoPending,contexts:contexts.at(-1)?.length??0});
        };
        for(let attempt=0;attempt<2;attempt++) {
          edit.click();await nextPaint();
          const editor=bubble.querySelector('textarea,[contenteditable=true]');
          const value=tag==='textarea'?editor.value:editor.textContent;
          results.push({tag,personal,project,stage:'editing',hasPersonal:value.includes('使用中文'),hasProject:value.includes('完成文章')});
          if(tag==='textarea')editor.value='未保存的修改';else editor.textContent='未保存的修改';
          editor.dispatchEvent(new InputEvent('input',{bubbles:true}));
          bubble.querySelector('button').click();await nextPaint();capture('cancel');
        }
        text.firstChild.nodeValue=original;await nextPaint();capture('text rewrite');
        const replacement=document.createElement('div');replacement.dataset.messageAuthorRole='user';
        text=document.createElement('span');text.textContent=original;replacement.append(text,edit);
        bubble.replaceWith(replacement);bubble=replacement;await nextPaint();capture('message remount');
        bubble.remove();host.querySelectorAll('.dtw-visible-memory,.dtw-message-meta').forEach(node=>node.remove());await nextPaint();
      }
    } finally {observer.disconnect();host.remove();window.removeEventListener('dtw:edit-context',onContext);}
    return results;
  })()`);
  for(const row of cancelledEditing) {
    assert.equal(row.hasPersonal,row.personal,JSON.stringify(row));assert.equal(row.hasProject,row.project,JSON.stringify(row));
    if(row.stage==='editing')continue;
    assert.equal(row.question,'请总结',JSON.stringify(row));assert.equal(row.sameEdit,true);
    assert.equal(row.composer,'新的草稿');assert.equal(row.pending,false);assert.equal(row.contexts,0,
      '取消编辑后在下一次绘制前清除隐藏记忆的临时提交上下文');
  }
  const displayWithoutHistory = await evaluate(page, `(async()=>{
    const fixture=messageDisplayFixture;const {state}=fixture;
    const host=document.createElement('section');document.body.append(host);
    const prompt='<project_memory>\\n背景\\n## 个人记忆\\n### 偏好\\n1. 使用中文\\n## 项目记忆：测试\\n### 目标\\n1. 完成文章\\n</project_memory>\\n<current_question>\\n本轮问题\\n</current_question>';
    state.snapshot={settings:{showPersonalMemory:false,showProjectMemory:false},sessions:[],memberships:[{sessionId:'message-edit-session',projectId:'p'}]};
    state.lastHistory=null;
    const observer=fixture.observeMessageDisplay();
    const make=(role,text)=>{const n=document.createElement('div');n.className=role==='USER'?'d29f3d7d ds-message _63c77b1':'ds-message _63c77b1';
      const span=document.createElement('span');span.textContent=text;n.append(span);host.append(n);return n;};
    const user=make('USER',prompt);const answer=make('ASSISTANT','已完成');
    await new Promise(resolve=>requestAnimationFrame(resolve));
    const noHistory=user.textContent==='本轮问题';
    state.snapshot.settings.showPersonalMemory=true;fixture.renderMessageInfo();
    const toggled=user.textContent.includes('使用中文')&&!user.textContent.includes('完成文章');
    state.snapshot.settings.showPersonalMemory=false;fixture.renderMessageInfo();
    const records=[{messageId:1,parentId:null,role:'USER',insertedAtMs:100000,accumulatedTokenUsage:120,fragments:[{type:'REQUEST',content:prompt}]},
      {messageId:2,parentId:1,role:'ASSISTANT',insertedAtMs:100001,accumulatedTokenUsage:180,fragments:[{type:'RESPONSE',content:'已完成'}]}];
    state.lastHistory={conversationId:'message-edit-session',currentMessageId:2,records};
    const newUser=make('USER',prompt.replace('本轮问题','第二轮问题'));make('ASSISTANT','正在输出');
    await new Promise(resolve=>requestAnimationFrame(resolve));
    const pendingHidden=newUser.textContent==='第二轮问题';
    const prefixTokens=[...host.querySelectorAll('.dtw-message-meta')].map(n=>n.textContent);
    state.lastHistory={conversationId:'message-edit-session',currentMessageId:4,records:records.concat([
      {...records[0],messageId:3,parentId:2,accumulatedTokenUsage:200,fragments:[{type:'REQUEST',content:prompt.replace('本轮问题','第二轮问题')}]},
      {...records[1],messageId:4,parentId:3,accumulatedTokenUsage:260,fragments:[{type:'RESPONSE',content:'正在输出'}]}])};
    fixture.renderMessageInfo();const finishedTokens=[...host.querySelectorAll('.dtw-message-meta')].map(n=>n.textContent);
    user.firstChild.textContent='另一个分支的问题';fixture.renderMessageInfo();
    const wrongBranch=host.querySelectorAll('.dtw-message-meta').length===0;
    observer.disconnect();host.remove();state.lastHistory=null;
    return {noHistory,toggled,pendingHidden,prefixTokens,finishedTokens,wrongBranch};
  })()`);
  assert.equal(displayWithoutHistory.noHistory,true,'没有历史缓存仍应立即隐藏记忆');
  assert.equal(displayWithoutHistory.toggled,true,'没有缓存时也能切换个人记忆显示');
  assert.equal(displayWithoutHistory.pendingHidden,true,'消息数不一致时隐藏刚发送的记忆');
  assert.equal(displayWithoutHistory.prefixTokens.length,2,'新回复不应移除已有消息 token');
  assert.match(displayWithoutHistory.prefixTokens[0],/本次 120 tokens.*累计 120 tokens/);
  assert.match(displayWithoutHistory.prefixTokens[1],/本次 60 tokens.*累计 180 tokens/);
  assert.equal(displayWithoutHistory.finishedTokens.length,4);
  assert.match(displayWithoutHistory.finishedTokens[3],/本次 60 tokens.*累计 260 tokens/);
  assert.equal(displayWithoutHistory.wrongBranch,true,'不能将其他分支的 token 标在当前消息上');
  const localSendChecks = await evaluate(page, `(async()=>{
    const fixture=messageDisplayFixture;const {state}=fixture;
    const originalSend=chrome.runtime.sendMessage;
    const host=document.createElement('section');document.body.append(host);
    const requests=[];let historyRequests=0;let nativeSends=0;
    const onHistory=()=>historyRequests++;
    window.addEventListener('dtw:history-request',onHistory);
    const prompt='<project_memory>\\n## 个人记忆\\n### 偏好\\n1. 使用中文\\n</project_memory>\\n\\n<current_question>\\n同一个问题\\n第二行\\n</current_question>';
    const userRecord={messageId:1,role:'USER',fragments:[{type:'REQUEST',content:prompt}]};
    const node=(role,text)=>{const element=document.createElement('div');element.dataset.messageAuthorRole=role;
      element.textContent=text;host.append(element);return element;};
    const before={sessionId:'message-edit-session',userCount:1,userMessageIds:new Set([1]),knownSessionIds:new Set()};
    const results={};
    try {
      state.accountId='ui-test-account';state.networkIssue=null;state.pendingNewProjectId='';
      state.snapshot={settings:{showPersonalMemory:false,showProjectMemory:false},sessions:[],memberships:[],projects:[],jobs:[]};
      state.lastHistory={conversationId:'message-edit-session',title:'本地确认测试',records:[userRecord]};state.lastHistoryAt=Date.now();
      chrome.runtime.sendMessage=async message=>{requests.push(message);
        if(message.type==='dtw:session-history')return {ok:true,history:state.lastHistory};
        return {ok:true};};
      const editor=document.createElement('textarea');editor.id='chat-input';host.append(editor);
      const old=node('user',prompt);node('assistant','上次的回答');
      old.replaceWith(old.cloneNode(true));
      results.oldTurn=await fixture.confirmUserMessage('old-turn',prompt,before,20);
      const pending=node('user',prompt);fixture.renderUserMessage(pending,userRecord);
      editor.value='';
      const stop=document.createElement('button');stop.setAttribute('aria-label','停止生成');host.append(stop);
      results.optimistic=await fixture.confirmUserMessage('optimistic',prompt,before,20);
      const emptyAnswer=node('assistant','');const copy=document.createElement('button');copy.textContent='复制';emptyAnswer.append(copy);
      results.controlsOnly=await fixture.confirmUserMessage('controls',prompt,before,20);emptyAnswer.remove();
      const answer=node('assistant','正在回答本轮问题');
      results.dom=await fixture.confirmUserMessage('dom',prompt,before,100);
      results.domMessageId=requests.find(message=>message.jobId==='dom')?.userMessageId??null;
      answer.remove();stop.remove();
      state.lastHistory.records.push({...userRecord,messageId:3});
      results.stored=await fixture.confirmUserMessage('stored',prompt,before,100);
      results.storedMessageId=requests.find(message=>message.jobId==='stored')?.userMessageId;
      results.knownRoute=await fixture.confirmUserMessage('known-route',prompt,
        {...before,sessionId:'',userCount:0,knownSessionIds:new Set(['message-edit-session'])},20);
      const localSend=chrome.runtime.sendMessage;state.lastHistoryAt=0;
      chrome.runtime.sendMessage=async message=>{const result=await localSend(message);
        if(message.type==='dtw:session-history')globalThis.fixtureRoute='unrelated-session';return result;};
      results.changedRoute=await fixture.confirmUserMessage('changed-route',prompt,before,20);
      chrome.runtime.sendMessage=localSend;delete globalThis.fixtureRoute;
      host.replaceChildren(editor);editor.value='原始草稿';state.lastHistory=null;state.lastHistoryAt=0;
      globalThis.fixtureRoute='';
      const button=document.createElement('button');button.className='ds-button--primary ds-button--circle';host.append(button);
      button.onclick=()=>{nativeSends++;globalThis.fixtureRoute='new-local-send';node('user',editor.value);
        node('assistant','收到');editor.value='';};
      results.newChat=await fixture.doProjectSend(editor,prompt,'new-chat');
      results.newChatSession=requests.find(message=>message.jobId==='new-chat')?.sessionId;
      results.nativeSends=nativeSends;
      results.noHistoryRequest=historyRequests===0 && !requests.some(message=>message.type==='dtw:history-request-slot');
      results.noRetry=requests.filter(message=>message.type==='dtw:send-status' && message.confirmed).length===3;
    } finally {
      delete globalThis.fixtureRoute;host.remove();window.removeEventListener('dtw:history-request',onHistory);
      chrome.runtime.sendMessage=originalSend;
    }
    return results;
  })()`);
  assert.equal(localSendChecks.oldTurn,false,'旧的同文消息及 DOM 重挂载不能确认本轮发送');
  assert.equal(localSendChecks.optimistic,false,'气泡、清空输入和停止按钮不足以确认服务端已接收');
  assert.equal(localSendChecks.controlsOnly,false,'助手操作按钮不能充当实际回复');
  assert.equal(localSendChecks.knownRoute,false,'跳到已有会话不能当作本次新会话发送');
  assert.equal(localSendChecks.changedRoute,false,'异步读取本地记录期间切换页面不能确认到错误的会话');
  for (const key of ['dom','stored','newChat','noHistoryRequest','noRetry'])assert.equal(localSendChecks[key],true,key);
  assert.equal(localSendChecks.domMessageId,null,'本地页面确认不伪造消息 ID');
  assert.equal(localSendChecks.storedMessageId,3);
  assert.equal(localSendChecks.newChatSession,'new-local-send');assert.equal(localSendChecks.nativeSends,1);
  const fastReplyChecks = await evaluate(page, `(async()=>{
    const fixture=messageDisplayFixture;const {state}=fixture;const originalSend=chrome.runtime.sendMessage;
    const host=document.createElement('section');document.body.append(host);const results=[];
    let reads=0;let completed=0;let captured;
    const restore=fixture.mockHistory(async()=>{reads++;return captured;});
    chrome.runtime.sendMessage=async message=>{
      if(message.type==='dtw:turn-completed')completed++;
      if(message.type==='dtw:snapshot')return state.snapshot;
      return {ok:true};
    };
    try {
      for(const fresh of [false,true]) {
        host.replaceChildren();const route=fresh?'fresh-fast-reply':'existing-fast-reply';
        globalThis.fixtureRoute=fresh?'':route;state.accountId='ui-test-account';state.lastHistory=null;state.submittedAtMs=null;state.networkIssue=null;
        state.pendingNewConversationAt=Date.now();state.pendingNewKnownIds=new Set();state.dirtySessions.clear();
        state.snapshot={settings:{},sessions:[{sessionId:route,purpose:'USER'}],memberships:[],projects:[],jobs:[]};
        const composer=document.createElement('textarea');composer.id='chat-input';composer.value='快速回复测试';host.append(composer);
        const send=document.createElement('button');send.textContent='发送';host.append(send);
        send.onclick=()=>{globalThis.fixtureRoute=route;for(const [role,text] of [['user','快速回复测试'],['assistant','已完成']]){
          const bubble=document.createElement('div');bubble.dataset.messageAuthorRole=role;bubble.textContent=text;host.append(bubble);
        }};
        captured={conversationId:route,currentMessageId:2,records:[{messageId:1,parentId:null,role:'USER',status:'FINISHED',fragments:[{type:'REQUEST',content:'快速回复测试'}]},
          {messageId:2,parentId:1,role:'ASSISTANT',status:'FINISHED',fragments:[{type:'RESPONSE',content:'已完成'}]}]};
        const before=reads;await fixture.submit(composer);await fixture.checkTurn();
        const tracked=state.turn.generating;state.turn.since=Date.now()-3000;await fixture.checkTurn();
        results.push({fresh,tracked,reads:reads-before,completed});
      }
      state.lastHistory=null;state.snapshot.memberships=[{sessionId:globalThis.fixtureRoute,projectId:'p'}];state.historyRecovery.clear();
      const before=reads;state.turn.since=Date.now()-3000;await fixture.checkTurn();await fixture.checkTurn();
      results.push({recoveryReads:reads-before});
    } finally {restore();host.remove();delete globalThis.fixtureRoute;chrome.runtime.sendMessage=originalSend;}
    return results;
  })()`);
  for(const row of fastReplyChecks.filter(row=>'fresh' in row)){assert.equal(row.tracked,true,JSON.stringify(row));assert.equal(row.reads,1,'没有观察到停止按钮的快速回复仍只补读一次历史');}
  assert.equal(fastReplyChecks[1].completed,2);
  assert.equal(fastReplyChecks.at(-1).recoveryReads,1,'已有消息缺失 token 缓存时只恢复一次历史');
  const restrictionChecks = await evaluate(page, `(async()=>{
    const fixture=messageDisplayFixture;const {state}=fixture;
    const sendMessage=chrome.runtime.sendMessage;const storage=chrome.storage.local;
    const host=document.createElement('section');document.body.append(host);
    const requests=[];const requestStates=[];let nativeSends=0;let savedIssue=null;
    const onState=event=>requestStates.push(JSON.parse(event.detail));
    window.addEventListener('dtw:request-state',onState);
    chrome.runtime.sendMessage=async message=>{
      requests.push(message);
      if(message.type==='dtw:request-issue')savedIssue=message;
      if(message.type==='dtw:snapshot')return {ok:true,settings:{automationPaused:true},alerts:{issue:savedIssue},
        sessions:[],memberships:[],memories:[],projects:[],jobs:[]};
      return {ok:true};
    };
    chrome.storage.local={get:async()=>({}),set:async values=>requests.push({type:'storage:set',...values})};
    const clear=()=>{state.accountId='ui-test-account';state.networkIssue=null;savedIssue=null;requests.length=0;host.replaceChildren();};
    const notice=()=>{const element=document.createElement('div');element.textContent='您的账号已被禁言至 2099-01-01 00:00';host.append(element);return element;};
    const results={};
    try {
      clear();
      for(const [tag,attribute,value] of [['div','data-message-author-role','assistant'],['div','class','ds-message'],
        ['div','class','dtw-owned'],['a','href','/chat/s/muted-title'],['aside','class','sidebar']]) {
        const element=document.createElement(tag);element.setAttribute(attribute,value);
        element.textContent='您的账号已被禁言';host.append(element);
      }
      const hidden=notice();hidden.hidden=true;
      results.excluded=fixture.currentRequestIssue()===null;
      hidden.hidden=false;hidden.style.visibility='hidden';
      results.invisible=fixture.currentRequestIssue()===null;
      clear();const composer=document.createElement('div');host.append(composer);
      const editor=document.createElement('textarea');editor.id='chat-input';editor.value='普通草稿中提到禁言';composer.append(editor);
      const button=document.createElement('button');button.className='ds-button--primary ds-button--circle';
      button.onclick=()=>nativeSends++;composer.append(button);
      results.normal=fixture.currentRequestIssue()===null;
      await fixture.submit(editor);results.normalSends=nativeSends;
      editor.replaceWith(notice());
      results.detected=fixture.currentRequestIssue()?.code;
      results.pageBlocked=requestStates.at(-1)?.issue?.code;
      results.waitCode=await fixture.waitEditor().then(()=>null,error=>error.code);
      results.submitCode=await fixture.submit(editor).then(()=>null,error=>error.code);
      await fixture.memorySend(editor);
      results.taskReplies=['dtw:automation','dtw:rollover'].map(type=>{
        let reply;contentMessageListener({type,jobId:type,prompt:'不应发送'}, {},value=>reply=value);return reply;
      });
      await new Promise(resolve=>setTimeout(resolve,50));
      results.persisted=savedIssue?.code;
      const reports=requests.filter(message=>message.type==='dtw:request-issue').length;
      fixture.currentRequestIssue();await new Promise(resolve=>setTimeout(resolve,20));
      results.noDuplicate=reports===requests.filter(message=>message.type==='dtw:request-issue').length;
      results.noPrepare=!requests.some(message=>message.type==='dtw:prepare-send');
      results.blockedSends=nativeSends;
      host.replaceChildren();results.keepsPause=fixture.currentRequestIssue()?.code;
      clear();const waiting=fixture.waitEditor();
      setTimeout(notice,20);
      results.waitingCode=await waiting.then(()=>null,error=>error.code);
      await new Promise(resolve=>setTimeout(resolve,50));
      clear();const delayedComposer=document.createElement('div');host.append(delayedComposer);
      const delayedEditor=document.createElement('textarea');delayedEditor.id='chat-input';delayedComposer.append(delayedEditor);
      const delayedButton=document.createElement('button');delayedButton.className='ds-button--primary ds-button--circle';
      delayedButton.disabled=true;delayedButton.onclick=()=>nativeSends++;delayedComposer.append(delayedButton);
      const sending=fixture.submit(delayedEditor);
      setTimeout(()=>{delayedEditor.style.display='none';notice();},20);
      results.sendingCode=await sending.then(()=>null,error=>error.code);
      results.delayedSends=nativeSends;
      await new Promise(resolve=>setTimeout(resolve,50));
      clear();state.accountId='';notice();fixture.currentRequestIssue();
      results.beforeAccount=requests.length===0&&state.networkIssue?.code==='ACCOUNT_RESTRICTED';
      await fixture.initializeAccount('ui-test-account',Date.now());
      results.issueBeforeReady=requests.findIndex(message=>message.type==='dtw:request-issue')<requests.findIndex(message=>message.type==='dtw:request-ready');
      results.issueBeforeStorage=requests.findIndex(message=>message.type==='dtw:request-issue')<requests.findIndex(message=>message.type==='storage:set');
      clear();const disabled=document.createElement('textarea');disabled.id='chat-input';disabled.disabled=true;
      disabled.placeholder='您的账号已被禁言';host.append(disabled);
      results.disabled=fixture.currentRequestIssue()?.code;
      await new Promise(resolve=>setTimeout(resolve,50));
      clear();const english=notice();english.textContent='Your account has been suspended.';
      results.english=fixture.currentRequestIssue()?.code;
      await new Promise(resolve=>setTimeout(resolve,50));
    } finally {
      host.remove();window.removeEventListener('dtw:request-state',onState);
      chrome.runtime.sendMessage=sendMessage;chrome.storage.local=storage;
    }
    return results;
  })()`);
  for (const key of ['excluded','invisible','normal','noDuplicate','noPrepare','beforeAccount','issueBeforeReady','issueBeforeStorage'])
    assert.equal(restrictionChecks[key],true,key);
  for (const key of ['detected','pageBlocked','waitCode','submitCode','persisted','keepsPause','waitingCode','sendingCode','disabled','english'])
    assert.equal(restrictionChecks[key],'ACCOUNT_RESTRICTED',key);
  for (const reply of restrictionChecks.taskReplies) {
    assert.equal(reply.ok,false);assert.equal(reply.code,'ACCOUNT_RESTRICTED');
  }
  assert.equal(restrictionChecks.normalSends,1);assert.equal(restrictionChecks.blockedSends,1,'禁言后不得触发原生发送');
  assert.equal(restrictionChecks.delayedSends,1,'等待发送按钮期间出现禁言也必须停止');
  console.log(JSON.stringify({ ok: true, checks: "settings, uncached memory visibility, prefix tokens, quick reply sync, local send confirmation, mute detection and blocked sends in local DOM", screenshot: path.join(root, ".live-fs", "settings-ui.png") }));
} finally {
  if (browser) await browser.call("Browser.close").catch(() => {});
  page?.close(); browser?.close(); chrome.kill();
  await delay(500);
  assert.equal(path.dirname(profile), path.resolve(os.tmpdir()));
  assert.ok(path.basename(profile).startsWith("dtw-settings-test-"));
  await fs.rm(profile, { recursive: true, force: true, maxRetries: 4, retryDelay: 200 });
}
