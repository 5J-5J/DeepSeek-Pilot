/** Real Chrome layout/interaction checks with local fixtures; no DeepSeek requests or user data. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const profile = await fs.mkdtemp(path.join(os.tmpdir(), "dtw-sidebar-test-"));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const [source, css, historySource, uiSource, displaySource] = await Promise.all(["content/workbench.js", "content/workbench.css", "logic/history-core.js", "ui.js", "logic/memory-display.js"]
  .map(file => fs.readFile(path.join(root, "core", file), "utf8")));
const titles = ["设计IP流量展示图", "G6展示模板比较", "功能分析与架构设计", "梳理推理可视化需求", "未知IP负责人应用成果", "展开显示"];
const html = `<!doctype html><html lang="zh"><head><meta charset="UTF-8"><style>
  body{margin:0;font:14px Arial,"Microsoft YaHei",sans-serif;background:#171717;color:#ececec}
  aside{position:absolute;inset:0 auto 0 0;width:280px;background:#101010;display:flex;flex-direction:column}
  .new-chat{padding:24px 18px;cursor:pointer}.ds-scroll-area{overflow:auto;flex:1;padding:0 4px}
  .native-row{display:flex;padding:10px}.native-row button{margin-left:auto}.native-row a{color:inherit}
  .ds-dropdown-menu{position:fixed;width:210px;padding:6px;background:#252525;border:1px solid #ffffff1f;border-radius:12px;box-shadow:0 8px 28px #0003}
  .ds-dropdown-menu-option{display:flex;align-items:center;gap:10px;width:100%;height:36px;padding:8px 10px;border:0;border-radius:7px;background:transparent;color:inherit;font:inherit;text-align:left;box-sizing:border-box;cursor:pointer}
  .ds-dropdown-menu-option:hover{background:#ffffff14}.ds-dropdown-menu-option--error{color:#ef5350}
  body:not(.dark){background:#f7f7f7;color:#292929}body:not(.dark) aside,body:not(.dark) .ds-dropdown-menu{background:white}
  ${css}</style></head><body class="dark"><aside><div class="new-chat"><span>开启新对话</span></div><div class="ds-scroll-area"><div id="native-history">
  ${[...titles, "旅行计划", "读书笔记"].map((title, i) => `<a class="native-row" href="/a/chat/s/s${i + 1}">${title}<button aria-label="更多">⋯</button></a>`).join("")}
  </div></div></aside></body></html>`;
const server = createServer((_request, response) => { response.setHeader("Content-Type", "text/html; charset=utf-8"); response.end(html); });
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const connect = async url => {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => { socket.addEventListener("open", resolve, { once: true }); socket.addEventListener("error", reject, { once: true }); });
  let id = 0; const pending = new Map();
  socket.addEventListener("message", ({ data }) => {
    const result = JSON.parse(data); const callback = pending.get(result.id);
    if (!callback) return;
    pending.delete(result.id);
    result.error ? callback.reject(new Error(result.error.message)) : callback.resolve(result.result);
  });
  return { call(method, params = {}) { return new Promise((resolve, reject) => {
    const next = ++id; pending.set(next, { resolve, reject }); socket.send(JSON.stringify({ id: next, method, params }));
  }); }, close() { socket.close(); } };
};
async function evaluate(expression) {
  const result = await page.call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result.value;
}
async function waitFor(label, get) {
  for (let i = 0; i < 80; i++) { const value = await get(); if (value) return value; await delay(50); }
  throw new Error(`${label}超时`);
}
const click = async (action, id) => evaluate(`document.querySelector('[data-action="${action}"]${id === undefined ? "" : `[data-id="${id}"]`}').click()`);
const pointerClick = async (action, id) => {
  const point = await evaluate(`(()=>{const button=document.querySelector('[data-action="${action}"][data-id="${id}"]');button.scrollIntoView({block:'nearest'});const rect=button.getBoundingClientRect();return {x:rect.left+rect.width/2,y:rect.top+rect.height/2};})()`);
  await page.call("Input.dispatchMouseEvent", {type:"mouseMoved",...point});
  await page.call("Input.dispatchMouseEvent", {type:"mousePressed",button:"left",clickCount:1,...point});
  await page.call("Input.dispatchMouseEvent", {type:"mouseReleased",button:"left",clickCount:1,...point});
};
const group = 'document.querySelector(\'[data-group="p1"]\')';
async function checkMenuPosition(selector, action, id) {
  const bounds = await evaluate(`(()=>{
    const menu=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
    const anchor=document.querySelector('[data-action="${action}"][data-id="${id}"]').getBoundingClientRect();
    const left=Math.max(8,Math.min(anchor.left,innerWidth-menu.width-8));
    const top=anchor.bottom+menu.height+14<=innerHeight?anchor.bottom+6:Math.max(8,anchor.top-menu.height-6);
    return {left:menu.left,top:menu.top,expectedLeft:left,expectedTop:top,right:menu.right,bottom:menu.bottom,width:innerWidth,height:innerHeight};
  })()`);
  assert.ok(Math.abs(bounds.left-bounds.expectedLeft)<1&&Math.abs(bounds.top-bounds.expectedTop)<1, JSON.stringify(bounds));
  assert.ok(bounds.left>=8&&bounds.right<=bounds.width-8&&bounds.top>=8&&bounds.bottom<=bounds.height-8, JSON.stringify(bounds));
}
let browser; let page;
const chrome = spawn("C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", [
  "--headless=new", "--no-first-run", "--disable-background-networking", "--remote-debugging-port=0",
  `--user-data-dir=${profile}`, "--window-size=1100,900", "about:blank",
], { windowsHide: true, stdio: "ignore" });
try {
  const port = await waitFor("调试端口", async () => {
    try { return Number((await fs.readFile(path.join(profile, "DevToolsActivePort"), "utf8")).split(/\r?\n/)[0]); } catch { return null; }
  });
  const targets = () => fetch(`http://127.0.0.1:${port}/json/list`).then(response => response.json());
  const version = await fetch(`http://127.0.0.1:${port}/json/version`).then(response => response.json());
  browser = await connect(version.webSocketDebuggerUrl);
  page = await connect((await targets()).find(item => item.type === "page").webSocketDebuggerUrl);
  await page.call("Runtime.enable"); await page.call("Page.enable");
  await page.call("Page.bringToFront");
  await page.call("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "no-preference" }] });
  await page.call("Page.navigate", { url: `http://127.0.0.1:${server.address().port}/a/chat/s/s1` });
  await waitFor("本地页面", () => evaluate("Boolean(document.querySelector('#native-history'))"));
  await evaluate(`globalThis.fixtureRequests=[];globalThis.fixtureStorage={};globalThis.fixtureNative=[];globalThis.fixtureNewChats=0;
    globalThis.fixtureOpenTrigger=null;globalThis.fixtureMenuTimer=0;globalThis.prompt=()=>"插件改名测试";globalThis.confirm=()=>true;
    globalThis.chrome={runtime:{getURL:()=>"data:text/javascript,",onMessage:{addListener(){}},sendMessage:async message=>{
      fixtureRequests.push(message);
      const data=fixture.state.snapshot;
      if(message.type==='dtw:membership-move'){
        const row=data.memberships.find(row=>row.sessionId===message.sessionId);
        row.projectId=message.projectId;
      }
      if(message.type==='dtw:session-delete')data.sessions.forEach(row=>{if(message.sessionIds.includes(row.sessionId))row.deleted=true});
      if(message.type==='dtw:session-observe'){
        let row=data.sessions.find(row=>row.sessionId===message.sessionId);
        if(!row){row={sessionId:message.sessionId,purpose:'USER'};data.sessions.push(row);}Object.assign(row,message);
      }
      if(message.type==='dtw:project-update')Object.assign(data.projects.find(row=>row.projectId===message.projectId),message);
      return {ok:true};
    }},storage:{local:{set:async values=>Object.assign(fixtureStorage,values)}}};
    ${historySource}
    ${displaySource}
    ${uiSource}
    ${source.replace('  start().catch((error) => console.warn("[DeepSeek Pilot]", error));', `
      globalThis.fixture={state,renderTree,showLoadingTree,toggleGroup,handleAction,renderModal,syncVisibleSessions,titleSync,registerCreatedSession,renderMessageInfo};
      refresh=async()=>renderTree(); syncChangedSessions=async()=>{}; renderMemoryButton=()=>{};
      history=async()=>({records:[]});
      document.body.append(root);
    `)}
    fixture.state.accountId='sidebar-test-account';
    fixture.state.snapshot={projects:[{projectId:'p1',name:'ip_relation'},{projectId:'p2',name:'metafinger'},
      {projectId:'archived',name:'已归档项目',archived:true},{projectId:'dtw-automation',name:'自动化会话',systemKind:'AUTOMATION'}],
      sessions:${JSON.stringify([...titles, "旅行计划", "读书笔记"].map((title, i) => ({ sessionId: `s${i + 1}`, title, purpose: "USER", updatedAtMs: 20 - i })))}.concat([{sessionId:'helper',title:'记忆整理',purpose:'AUTOMATION',updatedAtMs:1},{sessionId:'archived-session',title:'归档会话',purpose:'USER'}]),
      memberships:${JSON.stringify(Array.from({ length: 8 }, (_, i) => ({ sessionId: `s${i + 1}`, projectId: i < 6 ? "p1" : null })))}.concat([{sessionId:'archived-session',projectId:'archived'}]),settings:{},jobs:[]};
    fixture.publishList=(rows=fixture.state.snapshot.sessions.filter(row=>!row.deleted),hasMore=false)=>window.dispatchEvent(new CustomEvent('dtw:session-list',
      {detail:JSON.stringify({accountId:fixture.state.accountId,hasMore,sessions:rows.map(({sessionId,title,updatedAtMs,pinned})=>({sessionId,title,updatedAtMs,pinned}))})}));
    document.querySelector('.new-chat').addEventListener('click',()=>{fixtureNewChats++;history.pushState(null,'','/a/chat');});
    document.querySelectorAll('.native-row').forEach(row=>{
      row.addEventListener('click',event=>event.preventDefault());
      row.querySelector('button').addEventListener('click',event=>{
        event.preventDefault();event.stopPropagation();
        if(fixtureOpenTrigger===event.currentTarget){
          fixtureOpenTrigger=null;clearTimeout(fixtureMenuTimer);document.querySelector('.ds-floating-container')?.remove();return;
        }
        clearTimeout(fixtureMenuTimer);document.querySelector('.ds-floating-container')?.remove();fixtureOpenTrigger=event.currentTarget;
        fixtureTriggerRect=event.currentTarget.getBoundingClientRect().toJSON();
        fixtureMenuTimer=setTimeout(()=>{
          const floating=document.createElement('div');floating.className='ds-floating-container';
          floating.style.cssText='position:fixed;left:0;top:0;transform:translate(100px,60px);translate:40px 30px';
          const menu=document.createElement('div');menu.className='ds-dropdown-menu';menu.setAttribute('role','menu');
          menu.style.cssText='position:absolute;left:52px;top:80px;transform:translate(90px,24px);translate:20px 10px;margin:12px';
          menu.innerHTML=['重命名',fixture.state.snapshot.sessions.find(s=>s.sessionId===row.href.split('/').at(-1))?.pinned?'取消置顶':'置顶','分享','多选','删除'].map(label=>'<button class="ds-dropdown-menu-option '+(label==='删除'?'ds-dropdown-menu-option--error':'')+'" role="menuitem">'+label+'</button>').join('');
          menu.querySelectorAll('button').forEach(button=>button.onclick=()=>{fixtureNative.push(button.textContent);fixtureOpenTrigger=null;floating.remove();
            if(button.textContent==='重命名'){
              const wrapper=document.createElement('div');const input=document.createElement('input');input.type='text';input.value=row.firstChild.nodeValue;wrapper.append(input);
              row.replaceWith(wrapper);input.addEventListener('keydown',event=>{if(event.keyCode===13){row.firstChild.nodeValue=input.value;wrapper.replaceWith(row);}});
            }});
          floating.append(menu);document.body.append(floating);
        },25);
      });
    });
    window.addEventListener('dtw:delete-request',event=>window.dispatchEvent(new CustomEvent('dtw:delete-result',{detail:JSON.stringify({requestId:JSON.parse(event.detail).requestId})})));
    fixture.publishList();fixture.renderTree();`);
  assert.equal(await evaluate("document.querySelectorAll('.dtw-session').length"), 9);
  assert.equal(await evaluate("document.querySelectorAll('.dtw-session.active').length"), 1);
  assert.equal(await evaluate("document.querySelector('[data-group=dtw-automation] .dtw-group-body').inert"), true, "自动化会话默认收起");
  assert.equal(await evaluate("document.querySelector('.dtw-unassigned .dtw-group-label').textContent"), "未归类会话");
  assert.equal(await evaluate("document.querySelector('#native-history').style.display"), "none");
  assert.equal(await evaluate("document.querySelectorAll('.native-row').length"), 8, "原生节点保持挂载");
  assert.equal(await evaluate("Boolean(document.querySelector('[data-group=archived]'))"), false, "聊天侧栏隐藏归档项目");
  assert.equal(await evaluate("Boolean(document.querySelector('[data-session=archived-session]'))"), false, "归档会话不转入未归类");
  assert.equal(await evaluate("fixture.state.snapshot.sessions.some(session=>session.sessionId==='archived-session')"), true, "隐藏归档项目不删除数据");
  await evaluate("globalThis.fixtureHelp=document.querySelector('.dtw-help-trigger');fixtureHelp.focus()");
  assert.equal(await evaluate("document.querySelector('.dtw-help-tip').matches(':popover-open')"), true);
  assert.match(await evaluate("document.querySelector('.dtw-help-tip').textContent"), /记忆整理和压缩/);
  assert.match(await evaluate("document.querySelector('.dtw-help-tip').textContent"), /不参与.*记忆学习/);
  await evaluate("fixtureHelp.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));fixtureHelp.blur()");
  assert.equal(await evaluate("document.querySelector('.dtw-help-tip').matches(':popover-open')"), false);
  const hintPoint = await evaluate("(()=>{const r=fixtureHelp.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()");
  await page.call("Input.dispatchMouseEvent", {type:"mouseMoved",...hintPoint});
  assert.equal(await evaluate("document.querySelector('.dtw-help-tip').matches(':popover-open')"), true);
  assert.equal(await evaluate("(()=>{const r=document.querySelector('.dtw-help-tip').getBoundingClientRect();return r.left>=12&&r.right<=innerWidth-12&&r.top>=12&&r.bottom<=innerHeight-12})()"),true,'详情提示保持在窗口内');
  await fs.mkdir(path.join(root,".live-fs"),{recursive:true});
  const helpScreenshot=await page.call('Page.captureScreenshot',{format:'png',clip:{x:0,y:0,width:680,height:760,scale:1}});
  await fs.writeFile(path.join(root,'.live-fs','sidebar-help.png'),Buffer.from(helpScreenshot.data,'base64'));
  await page.call("Input.dispatchMouseEvent", {type:"mouseMoved",x:500,y:0});
  await waitFor("移开自动化详情提示",()=>evaluate("!document.querySelector('.dtw-help-tip').matches(':popover-open')"));
  await evaluate("fixture.state.snapshot.alerts={count:2};fixture.renderTree()");
  assert.equal(await evaluate("fixtureHelp===document.querySelector('.dtw-help-trigger')&&document.querySelectorAll('.dtw-help-tip').length===1"), true, "刷新复用详情按钮和提示");
  assert.equal(await evaluate("Boolean(document.querySelector('[data-action=\"open-options\"].has-alert .dtw-alert-dot'))"), true);
  assert.match(await evaluate("document.querySelector('[data-action=\"open-options\"]').getAttribute('aria-label')"), /2/);
  const height = await evaluate(`${group}.querySelector('.dtw-group-body').getBoundingClientRect().height`);
  await evaluate(`globalThis.fixtureRow=${group}.querySelector('.dtw-session');fixture.renderTree();fixture.renderTree()`);
  assert.equal(await evaluate(`fixtureRow===${group}.querySelector('.dtw-session')`), true, "相同数据刷新不重建树");
  await evaluate("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))");
  await click("collapse", "p1");
  assert.equal(await evaluate(`${group}.querySelector('.dtw-group-body').inert`), true);
  assert.deepEqual(await evaluate("fixtureStorage['dtw.collapsed:sidebar-test-account']"), ["dtw-automation", "p1"]);
  await delay(80);
  const intermediate = await evaluate(`${group}.querySelector('.dtw-group-body').getBoundingClientRect().height`);
  assert.ok(intermediate > 0 && intermediate < height, `应有连续高度过渡：${intermediate}/${height} ${JSON.stringify(await evaluate(`({class:${group}.className,rows:getComputedStyle(${group}.querySelector('.dtw-group-body')).gridTemplateRows,duration:getComputedStyle(${group}.querySelector('.dtw-group-body')).transitionDuration})`))}`);
  await delay(200);
  assert.equal(await evaluate(`${group}.querySelector('.dtw-group-body').getBoundingClientRect().height`), 0);
  assert.equal(await evaluate(`fixtureRow===${group}.querySelector('.dtw-session')`), true, "折叠不卸载会话");
  await evaluate("fixture.state.snapshot.projects[1].name='metafinger 更新';fixture.renderTree()");
  assert.equal(await evaluate(`${group}.querySelector('.dtw-group-body').getBoundingClientRect().height`), 0, "数据更新仍保持折叠状态");
  await click("collapse", "p1"); await click("collapse", "p1"); await click("collapse", "p1");
  await delay(260);
  assert.equal(await evaluate(`${group}.querySelector('.dtw-group-body').getBoundingClientRect().height`), height);
  assert.deepEqual(await evaluate("fixtureStorage['dtw.collapsed:sidebar-test-account']"), ["dtw-automation"]);
  await click("collapse", "__projects__"); await delay(260);
  assert.equal(await evaluate("document.querySelector('.dtw-projects').getBoundingClientRect().height"), 0);
  assert.ok(await evaluate("document.querySelector('.dtw-unassigned').getBoundingClientRect().height") > 0);
  await click("collapse", "__projects__"); await delay(260);
  await click("project-menu", "p1");
  assert.equal(await evaluate("Boolean(document.querySelector('.dtw-modal'))"), false);
  assert.equal(await evaluate("document.querySelectorAll('.dtw-menu button').length"), 5);
  await evaluate("document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}))");
  assert.equal(await evaluate("document.activeElement.dataset.action"), "rename-project");
  await evaluate("document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
  assert.equal(await evaluate("document.activeElement.dataset.action"), "project-menu");
  await click("project-menu", "p1"); await click("pin-project", "p1");
  await waitFor("项目置顶", () => evaluate("fixture.state.snapshot.projects[0].pinned===true"));
  await pointerClick("session-menu", "s1");
  assert.equal(await evaluate("fixture.state.menu?.kind"), "session");
  assert.equal(await evaluate("Boolean(document.querySelector('.ds-dropdown-menu'))"), false, "打开插件菜单不触发原生菜单");
  assert.deepEqual(await evaluate("[...document.querySelectorAll('.dtw-menu button')].map(b=>b.textContent.trim())"),
    ["打开会话", "重命名", "置顶", "分享", "多选", "从项目中移除", "删除会话"]);
  await checkMenuPosition(".dtw-menu", "session-menu", "s1");
  await evaluate("fixture.state.snapshot.sessions.find(s=>s.sessionId==='s1').title='菜单打开时更新';fixture.renderTree()");
  assert.equal(await evaluate("fixture.state.menu.anchor===document.querySelector('[data-action=session-menu][data-id=s1]')"),true);
  await checkMenuPosition(".dtw-menu", "session-menu", "s1");
  await fs.mkdir(path.join(root, ".live-fs"), { recursive: true });
  let screenshot = await page.call("Page.captureScreenshot", { format: "png", clip: { x: 0, y: 0, width: 520, height: 760, scale: 1 } });
  await fs.writeFile(path.join(root, ".live-fs", "sidebar-dark.png"), Buffer.from(screenshot.data, "base64"));
  await pointerClick("session-menu","s1");
  assert.equal(await evaluate("fixture.state.menu===null"),true,"再次点击关闭");
  await pointerClick("session-menu","s7");
  await checkMenuPosition(".dtw-menu","session-menu","s7");
  await evaluate("document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
  assert.equal(await evaluate("document.activeElement.dataset.id"),"s7");
  for (const [action,label] of [["rename","重命名"],["pin","置顶"],["pin","取消置顶"],["share","分享"],["delete","删除"]]) {
    await pointerClick("session-menu","s1");
    await click(`session-${action}`,"s1");
    await waitFor("执行原有操作",()=>evaluate(`fixtureNative.at(-1)===${JSON.stringify(label)}&&!fixture.state.nativeActionRunning`));
    assert.equal(await evaluate("Boolean(document.querySelector('.dtw-menu'))"),false);
    assert.equal(await evaluate("document.querySelector('#native-history').style.display"),"none");
  }
  assert.deepEqual(await evaluate("fixtureNative"),["重命名","置顶","取消置顶","分享","删除"]);
  assert.equal(await evaluate("fixture.state.snapshot.sessions.find(s=>s.sessionId==='s1').pinned"),false);
  assert.equal(await evaluate("document.querySelector('.native-row[href$=s1]').firstChild.nodeValue"),"插件改名测试","插件改名输入应保存到原生行");
  await evaluate(`globalThis.fixtureFlashes=0;
    new MutationObserver(()=>{if([...document.querySelectorAll('.ds-dropdown-menu')].some(n=>getComputedStyle(n).visibility!=='hidden'))fixtureFlashes++;})
      .observe(document.body,{childList:true,subtree:true});`);
  await pointerClick("session-menu","s1");await click("session-rename","s1");
  await waitFor("原生交互不展示弹层",()=>evaluate("!fixture.state.nativeActionRunning"));
  assert.equal(await evaluate("fixtureFlashes"),0);
  await pointerClick("session-menu","s7");
  await click("open-picker", "s7");
  assert.equal(await evaluate("Boolean(document.querySelector('.ds-dropdown-menu'))"), false);
  await click("move-to", "p2");
  await waitFor("未归类会话移入项目", () => evaluate("Boolean(document.querySelector('[data-group=\"p2\"] [data-session=\"s7\"]'))"));
  assert.equal(await evaluate("Boolean(document.querySelector('.dtw-menu'))"), false);
  await click("session-menu", "s7");
  await waitFor("从项目移除入口", () => evaluate("Boolean(document.querySelector('[data-action=\"remove-from-project\"]'))"));
  assert.equal(await evaluate("Boolean(document.querySelector('.dtw-menu [data-action=\"open-picker\"]'))"), false, "归入项目后不提供跨项目移动入口");
  await click("remove-from-project", "s7");
  await waitFor("移到未归类", () => evaluate("Boolean(document.querySelector('.dtw-unassigned [data-session=\"s7\"]'))"));
  await click("session-menu", "helper");
  assert.equal(await evaluate("Boolean(document.querySelector('.dtw-menu [data-action=\"automation-unmark\"]'))"), true, "无可见原生行时保留插件菜单");
  await checkMenuPosition(".dtw-menu","session-menu","helper");
  await evaluate("document.body.click()");
  assert.equal(await evaluate("Boolean(document.querySelector('.dtw-menu'))"), false);
  await click("session-menu","s7");await click("session-select","s7");
  assert.equal(await evaluate("document.querySelector('[data-action=select-session][data-id=s7]').getAttribute('aria-checked')"),"true");
  await click("select-session","s8");
  assert.equal(await evaluate("fixture.state.selectedSessions.size"),2);
  await click("cancel-selection");
  assert.equal(await evaluate("fixture.state.selectedSessions===null"),true);
  await click("session-menu","s8");await click("session-select","s8");
  await evaluate("globalThis.confirm=()=>false");
  await click("delete-selected");assert.equal(await evaluate("fixture.state.selectedSessions.size"),1);
  await evaluate("globalThis.confirm=()=>true");await click("delete-selected");
  await waitFor("批量删除成功后更新插件列表",()=>evaluate("fixture.state.selectedSessions===null&&!document.querySelector('[data-session=s8]')"));
  await click("project-new-chat", "p2");
  assert.equal(await evaluate("fixtureNewChats"), 1);
  assert.equal(await evaluate("fixture.state.pendingNewProjectId"), "p2");
  assert.equal(await evaluate("fixtureRequests.some(message=>message.type==='dtw:prepare-send')"), false, "新建项目会话不自动发送");
  await evaluate("fixture.renderTree();document.body.classList.remove('dark')");
  await click("project-menu", "p2");
  assert.equal(await evaluate("getComputedStyle(document.querySelector('.dtw-menu')).backgroundColor"), "rgb(255, 255, 255)");
  screenshot = await page.call("Page.captureScreenshot", { format: "png", clip: { x: 0, y: 0, width: 520, height: 760, scale: 1 } });
  await fs.writeFile(path.join(root, ".live-fs", "sidebar-light.png"), Buffer.from(screenshot.data, "base64"));
  await page.call("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  assert.equal(await evaluate(`${group} && getComputedStyle(${group}.querySelector('.dtw-group-body')).transitionDuration`), "0s");
  await page.call("Emulation.setDeviceMetricsOverride", { width: 380, height: 380, deviceScaleFactor: 1, mobile: false });
  await waitFor("窄屏尺寸与菜单关闭", () => evaluate("innerWidth===380 && !document.querySelector('.dtw-menu')"));
  await click("project-menu", "p2");
  const bounds = await evaluate("(()=>{const rect=document.querySelector('.dtw-menu').getBoundingClientRect();return {left:rect.left,right:rect.right,top:rect.top,bottom:rect.bottom};})()");
  assert.ok(bounds.left >= 8 && bounds.right <= 372 && bounds.top >= 8 && bounds.bottom <= 372, JSON.stringify(bounds));
  await evaluate("document.body.click();document.querySelector('[data-session=s7]').scrollIntoView({block:'center',behavior:'instant'});new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))");
  await click("session-menu", "s7");
  await checkMenuPosition(".dtw-menu","session-menu","s7");
  await evaluate("document.querySelector('.ds-scroll-area').dispatchEvent(new Event('scroll'))");
  assert.equal(await evaluate("Boolean(document.querySelector('.dtw-menu'))"), false, "滚动后关闭浮层");
  await click("project-menu","p2");await click("archive-project","p2");
  await waitFor("归档后隐藏项目",()=>evaluate("!document.querySelector('[data-group=p2]')"));
  assert.equal(await evaluate("fixture.state.snapshot.projects.find(project=>project.projectId==='p2').archived"),true);
  await evaluate("fixture.state.snapshot.projects.find(project=>project.projectId==='archived').archived=false;fixture.renderTree()");
  assert.equal(await evaluate("Boolean(document.querySelector('[data-group=archived] [data-session=archived-session]'))"),true,'恢复后原会话仍在所属项目中');
  await evaluate(`fixture.state.snapshot.sessions.push(...Array.from({length:14},(_,i)=>({sessionId:'p0-helper-'+i,purpose:'MEMORY',automationOrigin:'PLUGIN',updatedAtMs:i})));fixture.publishList()`);
  assert.deepEqual(await evaluate("[...document.querySelectorAll('[data-session^=p0-helper-]')].map(node=>node.dataset.session)"),
    ['p0-helper-13','p0-helper-12','p0-helper-11','p0-helper-10','p0-helper-9'], "仅展示最近五条");
  assert.equal(await evaluate("fixture.state.snapshot.sessions.filter(row=>row.sessionId.startsWith('p0-helper-')).length"), 14, "显示数量不删除会话数据");
  await evaluate(`fixture.state.snapshot.sessions.push({sessionId:'p0-manual',purpose:'AUTOMATION',automationOrigin:'MANUAL',updatedAtMs:100},
    {sessionId:'p0-unknown',purpose:'AUTOMATION',automationOrigin:'UNKNOWN',updatedAtMs:99});fixture.publishList()`);
  assert.equal(await evaluate("document.querySelectorAll('[data-group=dtw-automation] .dtw-session').length"), 5);
  assert.equal(await evaluate("Boolean(document.querySelector('[data-session=p0-manual]'))&&Boolean(document.querySelector('[data-session=p0-unknown]'))"), true);
  await evaluate("fixture.state.snapshot.settings.showAutomationSessions=false;fixture.renderTree()");
  assert.equal(await evaluate("Boolean(document.querySelector('[data-group=dtw-automation]'))"),false,'关闭时整个自动化分组隐藏');
  assert.equal(await evaluate("document.querySelectorAll('[data-session^=p0-]').length"),0,'隐藏的自动化会话不能出现在其他分组');
  assert.equal(await evaluate("fixture.state.snapshot.sessions.filter(row=>row.sessionId.startsWith('p0-')).length"),16,'隐藏不删除会话');
  await evaluate("fixture.state.snapshot.settings.showAutomationSessions=true;fixture.renderTree()");
  assert.equal(await evaluate("document.querySelectorAll('[data-group=dtw-automation] .dtw-session').length"),5,'重新开启恢复分组');
  await click("collapse", "dtw-automation");
  assert.equal(await evaluate("document.querySelector('[data-group=dtw-automation] .dtw-group-body').inert"), false);
  await click("session-menu", "p0-manual");
  assert.equal(await evaluate("Boolean(document.querySelector('[data-action=automation-unmark]'))"), true);
  await evaluate(`document.body.click();fixture.state.snapshot.sessions=fixture.state.snapshot.sessions.filter(row=>row.sessionId!=='s3');
    fixture.state.snapshot.sessions.push({sessionId:'offline-deleted',purpose:'USER',title:'本地旧会话'});
    fixture.state.snapshot.memberships.push({sessionId:'offline-deleted',projectId:'p1'});
    fixture.publishList([{sessionId:'s3',title:'官方最新标题',updatedAtMs:100},{sessionId:'fresh-official',title:'新会话',updatedAtMs:101}],true)`);
  await waitFor("未知 ID 显示未归类", () => evaluate("Boolean(document.querySelector('.dtw-unassigned [data-session=fresh-official]'))"));
  assert.equal(await evaluate("Boolean(document.querySelector('[data-session=offline-deleted]'))"), false, "关闭插件期间删除的旧会话不会由缓存补回");
  assert.equal(await evaluate("Boolean(document.querySelector('[data-group=p1] [data-session=s3]'))"), true, "官方 ID 按本地项目归属分类");
  assert.match(await evaluate("document.querySelector('[data-session=s3]').textContent"), /官方最新标题/);
  assert.equal(await evaluate("Boolean(document.querySelector('[data-action=load-sessions]'))"), true);
  assert.equal(await evaluate("fixture.state.snapshot.memberships.find(row=>row.sessionId==='s6').projectId"), 'p1', "未加载的分页保留项目归属");
  await evaluate(`fixture.publishList([{sessionId:'s3',title:'官方最新标题',updatedAtMs:100},{sessionId:'fresh-official',title:'新会话',updatedAtMs:101},
    {sessionId:'s6',title:'分页会话',updatedAtMs:1}]);fixture.renderTree()`);
  assert.equal(await evaluate("Boolean(document.querySelector('[data-group=p1] [data-session=s6]'))"), true, "分页加载后恢复到原项目");
  await evaluate("fixture.publishList([{sessionId:'fresh-official',title:'新会话',updatedAtMs:101}]);fixture.renderTree();fixture.renderTree()");
  assert.equal(await evaluate("Boolean(document.querySelector('[data-session=s3]'))"), false);
  assert.equal(await evaluate("fixture.state.snapshot.memberships.find(row=>row.sessionId==='s3').projectId"), 'p1', "列表缺席不删除归属记录");
  await evaluate(`window.dispatchEvent(new CustomEvent('dtw:session-list',{detail:JSON.stringify({accountId:'other-account',sessions:[{sessionId:'wrong-account'}]})}))`);
  assert.equal(await evaluate("Boolean(document.querySelector('[data-session=wrong-account]'))"), false);
  await evaluate(`const staleLink=document.createElement('a');staleLink.className='native-row';staleLink.href='/a/chat/s/offline-deleted';staleLink.textContent='迟到的旧节点';
    document.querySelector('#native-history').append(staleLink);fixture.syncVisibleSessions()`);
  assert.equal(await evaluate("Boolean(document.querySelector('[data-session=offline-deleted]'))"), false, "旧的原生节点重挂载也不能补回官方列表外的会话");
  await evaluate(`const link=document.createElement('a');link.className='native-row';link.href='/a/chat/s/native-fresh';link.textContent='原生新建会话';
    fixture.state.newSessionIds.add('native-fresh');document.querySelector('#native-history').append(link);fixture.syncVisibleSessions()`);
  await waitFor("原生页面新建会话", () => evaluate("Boolean(document.querySelector('.dtw-unassigned [data-session=native-fresh]'))"));
  await evaluate(`globalThis.beforeCreatedList=fixture.state.officialSessions;
    fixture.state.snapshot.sessions.push({sessionId:'confirmed-created',purpose:'USER',title:'确认创建的项目会话'});
    fixture.state.snapshot.memberships.push({sessionId:'confirmed-created',projectId:'p1'});
    fixture.registerCreatedSession('confirmed-created','确认创建的项目会话');fixture.renderTree()`);
  assert.equal(await evaluate("Boolean(document.querySelector('[data-group=p1] [data-action=open-session][data-id=confirmed-created]'))"), true,
    "发送确认后原生列表尚未更新也立即显示项目新会话");
  assert.equal(await evaluate("fixture.state.officialSessions!==beforeCreatedList"), true, "新增会话触发官方列表重新同步记忆范围");
  await evaluate("fixture.publishList([])");
  assert.equal(await evaluate("document.querySelectorAll('.dtw-session').length"), 0, "官方空列表不显示本地旧会话");
  await evaluate("document.querySelector('#native-history').replaceChildren();fixture.renderTree()");
  assert.equal(await evaluate("Boolean(document.querySelector('.dtw-tree [data-action=create-project]'))"), true, "没有官方会话时仍可管理项目");
  // DeepSeek adds native links inside a nested scroller after the loading tree was mounted.
  await evaluate(`(()=>{
    const scroller=document.querySelector('.ds-scroll-area');
    const outer=document.createElement('div');outer.className='ds-scroll-area';scroller.before(outer);outer.append(scroller);
    document.querySelectorAll('.dtw-tree').forEach(tree=>tree.remove());
    const savedSnapshot=fixture.state.snapshot;fixture.state.snapshot=null;fixture.showLoadingTree();
    const link=document.createElement('a');link.href='/a/chat/s/s1';link.textContent='后加载的官方会话';scroller.append(link);
    fixture.state.snapshot=savedSnapshot;fixture.renderTree();
  })()`);
  assert.equal(await evaluate("document.querySelectorAll('.dtw-tree').length"), 1, "原生列表挂载位置变化后只能保留一个项目树");
  assert.equal(await evaluate("Boolean(document.querySelector('.dtw-loading'))"), false, "就绪后清除加载占位");
  await evaluate("fixture.toggleGroup('p1',false)");
  await click("collapse", "p1");
  assert.equal(await evaluate(`${group}.classList.contains('is-collapsed')`), true, "点击立即收起当前项目树");
  await click("collapse", "p1");
  assert.equal(await evaluate(`${group}.classList.contains('is-collapsed')`), false, "点击立即展开当前项目树");
  const attachments = await evaluate(`(()=>{
    history.pushState(null,'','/a/chat/s/s1');
    const host=document.createElement('section');document.body.append(host);
    const prompt='<project_memory>\\n## 个人记忆\\n使用中文\\n## 项目记忆：附件测试\\n完成报表\\n</project_memory>\\n\\n<current_question>\\n请分析文件\\n</current_question>';
    const user=document.createElement('div');user.dataset.messageAuthorRole='user';
    const file=document.createElement('div');file.textContent='报告.pdf 25 KB';
    const open=document.createElement('button');open.textContent='打开文件';let clicks=0;open.onclick=()=>clicks++;file.append(open);
    const body=document.createElement('span');body.textContent=prompt;user.append(file,body);host.append(user);
    const add=(role,text)=>{const node=document.createElement('div');node.dataset.messageAuthorRole=role;node.textContent=text;host.append(node);return node;};
    add('assistant','第一轮回答');const next=add('user','');
    const nextFile=document.createElement('div');nextFile.textContent='数据.csv 12 KB';
    const nextBody=document.createElement('span');nextBody.textContent='继续分析';next.append(nextFile,nextBody);add('assistant','第二轮回答');
    fixture.state.snapshot.settings={showPersonalMemory:false,showProjectMemory:false};
    fixture.state.snapshot.memberships=[{sessionId:'s1',projectId:'p1'}];
    fixture.state.lastHistory=null;fixture.renderMessageInfo();
    const hiddenWithoutHistory=body.textContent==='请分析文件';
    const records=[['USER',prompt],['ASSISTANT','第一轮回答'],['USER','继续分析'],['ASSISTANT','第二轮回答']]
      .map(([role,content],i)=>({messageId:i+1,parentId:i?i:null,role,status:'FINISHED',insertedAtMs:100000+i,
        accumulatedTokenUsage:100*(i+1),fragments:[{type:role==='USER'?'REQUEST':'RESPONSE',content}]}));
    fixture.state.lastHistory={conversationId:'s1',currentMessageId:4,records};
    const aligned=fixture.renderMessageInfo();const labels=[...host.querySelectorAll('.dtw-message-meta')].map(n=>n.textContent);
    fixture.state.snapshot.settings.showPersonalMemory=true;fixture.renderMessageInfo();
    fixture.state.snapshot.settings.showMessageTokens=false;fixture.renderMessageInfo();
    const tokensHidden=host.querySelectorAll('.dtw-message-meta').length===0;
    fixture.state.snapshot.settings.showMessageTokens=true;fixture.renderMessageInfo();
    const tokensRestored=host.querySelectorAll('.dtw-message-meta').length===4;
    const toggled=body.textContent.includes('使用中文')&&!body.textContent.includes('完成报表');
    fixture.state.snapshot.settings.showProjectMemory=true;fixture.renderMessageInfo();
    const restored=body.textContent===prompt;
    open.click();const preserved=user.firstChild===file&&file.textContent==='报告.pdf 25 KB打开文件'&&nextFile.textContent==='数据.csv 12 KB'&&clicks===1;
    nextBody.textContent='另一个分支的问题';fixture.renderMessageInfo();
    const branchProtected=host.querySelectorAll('.dtw-message-meta').length===2;
    nextBody.textContent='继续分析';
    const onlyFile=add('user','');const card=document.createElement('div');card.textContent='附件.pdf 42 KB';onlyFile.append(card);
    add('assistant','附件已收到');add('user','请继续总结');add('assistant','后续总结');
    records.push(...[['USER',''],['ASSISTANT','附件已收到'],['USER','请继续总结'],['ASSISTANT','后续总结']]
      .map(([role,content],i)=>({messageId:i+5,parentId:i+4,role,status:'FINISHED',insertedAtMs:100004+i,
        accumulatedTokenUsage:100*(i+5),fragments:[{type:role==='USER'?'REQUEST':'RESPONSE',content}]})));
    fixture.state.lastHistory.currentMessageId=8;
    const attachmentOnlyAligned=fixture.renderMessageInfo();
    const afterFileLabels=[...host.querySelectorAll('.dtw-message-meta')].map(n=>n.textContent);
    const fileOnlyPreserved=onlyFile.firstChild===card&&card.textContent==='附件.pdf 42 KB';
    host.remove();fixture.state.lastHistory=null;
    return {hiddenWithoutHistory,aligned,labels,toggled,restored,preserved,branchProtected,tokensHidden,tokensRestored,
      attachmentOnlyAligned,afterFileLabels,fileOnlyPreserved};
  })()`);
  for (const key of ['hiddenWithoutHistory','aligned','toggled','restored','preserved','branchProtected','tokensHidden','tokensRestored'])
    assert.equal(attachments[key],true,'附件消息显示：'+key);
  assert.equal(attachments.labels.length,4,'附件不能导致本条和后续消息的时间/token消失');
  assert.match(attachments.labels[3],/本次 100 tokens.*累计 400 tokens/);
  assert.equal(attachments.attachmentOnlyAligned,true,'仅有附件时整条分支仍保持对齐');
  assert.equal(attachments.fileOnlyPreserved,true,'纯附件消息保留文件卡片');
  assert.equal(attachments.afterFileLabels.length,8,'纯附件消息之后的回答和后续对话仍显示 token');
  assert.match(attachments.afterFileLabels[7],/本次 100 tokens.*累计 800 tokens/);
  // Exercise the production entry point as well as the isolated rendering helpers above.
  for (const failure of ["queue", "snapshot-error", "snapshot-timeout"]) {
    await page.call("Page.navigate", { url: `http://127.0.0.1:${server.address().port}/a/chat?startup=${failure}` });
    await waitFor("启动页面", () => evaluate(`location.search==='?startup=${failure}' && Boolean(document.querySelector('#native-history'))`));
    await evaluate(`
      globalThis.fixtureRequests=[];globalThis.fixtureFailure=${JSON.stringify(failure)};
      globalThis.fixtureRelease=null;globalThis.fixtureClicks=0;globalThis.fixtureKeys=0;
      const nativeTimer=window.setTimeout.bind(window);
      window.setTimeout=(fn,ms,...args)=>nativeTimer(fn,ms===10000?100:ms,...args);
      const composer=document.createElement('div');composer.innerHTML='<textarea placeholder="给 DeepSeek 发送消息">测试</textarea><button aria-label="发送">发送</button>';
      document.body.append(composer);
      composer.querySelector('button').addEventListener('click',()=>fixtureClicks++);
      composer.querySelector('textarea').addEventListener('keydown',()=>fixtureKeys++);
      globalThis.fixtureSnapshot={ok:true,projects:[],sessions:[],memberships:[],jobs:[],settings:{},alerts:{},memoryListRequired:true};
      globalThis.chrome={runtime:{id:'fixture',getURL:()=>'',onMessage:{addListener(){}},sendMessage:async message=>{
        fixtureRequests.push(message);
        if(message.type==='dtw:snapshot')return new Promise(()=>{});
        if(message.type==='dtw:sidebar-snapshot'){
          if(fixtureFailure==='snapshot-error')throw new Error('模拟后台读取失败');
          if(fixtureFailure==='snapshot-timeout')return new Promise(()=>{});
          return structuredClone(fixtureSnapshot);
        }
        if(message.type==='dtw:request-ready')return new Promise(()=>{});
        if(message.type==='dtw:session-list-observe'){
          await new Promise(resolve=>fixtureRelease=resolve);fixtureSnapshot.memoryListRequired=false;
        }
        return {ok:true};
      }},storage:{local:{get:async()=>({}),set:async()=>{}}}};
      window.addEventListener('dtw:profile-request',event=>window.dispatchEvent(new CustomEvent('dtw:profile-result',
        {detail:JSON.stringify({...JSON.parse(event.detail),accountId:'startup-account'})})));
      window.addEventListener('dtw:session-list-request',()=>window.dispatchEvent(new CustomEvent('dtw:session-list',
        {detail:JSON.stringify({accountId:'startup-account',sessions:[{sessionId:'s1',title:'官方会话'}]})})));
      ${historySource}
      ${uiSource}
      ${source}
    `);
    if (failure === "queue") {
      await waitFor("队列阻塞时侧栏仍可用", () => evaluate("Boolean(document.querySelector('[data-action=open-options]'))"));
      await click("open-options");
      assert.equal(await evaluate("fixtureRequests.some(message=>message.type==='dtw:open-options')"), true);
      await waitFor("官方会话立即显示", () => evaluate("document.querySelector('[data-session=s1]')?.textContent.includes('官方会话')"));
      assert.equal(await evaluate("fixtureRequests.filter(message=>message.type==='dtw:session-list-observe').length"), 1, "同步未完成时不重复提交列表");
      await evaluate("window.dispatchEvent(new CustomEvent('dtw:session-list',{detail:JSON.stringify({accountId:'startup-account',sessions:[{sessionId:'s2',title:'更新后的官方列表'}]})}))");
      assert.equal(await evaluate("Boolean(document.querySelector('[data-session=s2]')) && !document.querySelector('[data-session=s1]')"), true);
      assert.equal(await evaluate("fixtureRequests.filter(message=>message.type==='dtw:session-list-observe').length"), 1);
      await evaluate("fixtureRelease()");
      await waitFor("同步结束后补交最新列表", () => evaluate("fixtureRequests.filter(message=>message.type==='dtw:session-list-observe').length===2"));
      assert.deepEqual(await evaluate("fixtureRequests.findLast(message=>message.type==='dtw:session-list-observe').sessions.map(row=>row.sessionId)"), ["s2"]);
      await evaluate("fixtureRelease()");
    } else {
      if (failure === "snapshot-timeout") {
        assert.equal(await evaluate("document.querySelector('#native-history').style.display"), "", "等待读取期间保留原生列表");
      }
      await waitFor("启动失败恢复原生列表", () => evaluate("!document.querySelector('.dtw-loading') && document.querySelector('#native-history').style.display!== 'none'"));
      assert.match(await evaluate("document.querySelector('.dtw-toast')?.textContent || ''"), /失败|超时/);
      await evaluate("document.querySelector('textarea').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));document.querySelector('button[aria-label=发送]').click()");
      assert.equal(await evaluate("fixtureClicks===1 && fixtureKeys===1"), true, "初始化失败不能拦截原生发送");
      await evaluate("fixtureFailure='queue';window.dispatchEvent(new CustomEvent('dtw:account-ready',{detail:JSON.stringify({accountId:'startup-account'})}))");
      await waitFor("收到账号通知后恢复插件", () => evaluate("Boolean(document.querySelector('[data-action=open-options]'))"));
    }
  }
  const settingsHtml = await fs.readFile(path.join(root,'core/options/options.html'),'utf8');
  const settingsSource = await fs.readFile(path.join(root,'core/options/options.js'),'utf8');
  await page.call('Page.navigate',{url:`http://127.0.0.1:${server.address().port}/a/chat?settings-display`});
  await waitFor('设置测试页面',()=>evaluate("location.search==='?settings-display' && Boolean(document.querySelector('#native-history'))"));
  await evaluate(`document.documentElement.innerHTML=${JSON.stringify(settingsHtml)};
    globalThis.settingsFixture={ok:true,settings:{memoryStartAtMs:1000,maxContextTokens:256000,warningRatio:1,replyReserveTokens:4000,
      showMessageTokens:true,showAutomationSessions:true},projects:[],sessions:[],jobs:[]};
    globalThis.chrome={storage:{local:{get:async()=>({accountId:'display-account'})}},runtime:{sendMessage:async message=>{
      if(message.type==='dtw:settings-update'){settingsFixture.settings[message.key]=message.value;return {ok:true,value:message.value};}
      return structuredClone(settingsFixture);
    }}};
    ${uiSource}
    ${settingsSource}`);
  await waitFor('显示设置加载',()=>evaluate("document.querySelector('#showMessageTokens').checked && document.querySelector('#showAutomationSessions').checked"));
  for(const key of ['showMessageTokens','showAutomationSessions']) {
    await evaluate(`document.getElementById('${key}').click()`);
    await waitFor('关闭显示保存',()=>evaluate(`settingsFixture.settings.${key}===false && !document.getElementById('${key}').disabled`));
    await evaluate(`document.getElementById('${key}').click()`);
    await waitFor('开启显示保存',()=>evaluate(`settingsFixture.settings.${key}===true && !document.getElementById('${key}').disabled`));
  }
  console.log(JSON.stringify({ ok: true, checks: "sidebar interactions; production startup with blocked queue, failed/timed-out snapshot and account recovery" }));
} finally {
  if (browser) await browser.call("Browser.close").catch(() => {});
  page?.close(); browser?.close(); chrome.kill();
  await new Promise(resolve => server.close(resolve));
  await delay(500);
  assert.equal(path.dirname(profile), path.resolve(os.tmpdir()));
  assert.ok(path.basename(profile).startsWith("dtw-sidebar-test-"));
  await fs.rm(profile, { recursive: true, force: true, maxRetries: 4, retryDelay: 200 });
}
