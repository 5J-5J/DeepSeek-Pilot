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
const [source, css, historySource, uiSource] = await Promise.all(["content/workbench.js", "content/workbench.css", "logic/history-core.js", "ui.js"]
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
      if(message.type==='dtw:session-observe')Object.assign(data.sessions.find(row=>row.sessionId===message.sessionId),message);
      if(message.type==='dtw:project-update')Object.assign(data.projects.find(row=>row.projectId===message.projectId),message);
      return {ok:true};
    }},storage:{local:{set:async values=>Object.assign(fixtureStorage,values)}}};
    ${historySource}
    ${uiSource}
    ${source.replace('  start().catch((error) => console.warn("[DeepSeek Pilot]", error));', `
      globalThis.fixture={state,renderTree,toggleGroup,handleAction,renderModal};
      refresh=async()=>renderTree(); syncChangedSessions=async()=>{}; renderMemoryButton=()=>{};
      history=async()=>({records:[]});
      document.body.append(root);
    `)}
    fixture.state.accountId='sidebar-test-account';
    fixture.state.snapshot={projects:[{projectId:'p1',name:'ip_relation'},{projectId:'p2',name:'metafinger'},
      {projectId:'archived',name:'已归档项目',archived:true},{projectId:'auto',name:'自动化会话',systemKind:'AUTOMATION'}],
      sessions:${JSON.stringify([...titles, "旅行计划", "读书笔记"].map((title, i) => ({ sessionId: `s${i + 1}`, title, purpose: "USER", updatedAtMs: 20 - i })))}.concat([{sessionId:'helper',title:'记忆整理',purpose:'AUTOMATION',updatedAtMs:1},{sessionId:'archived-session',title:'归档会话',purpose:'USER'}]),
      memberships:${JSON.stringify(Array.from({ length: 8 }, (_, i) => ({ sessionId: `s${i + 1}`, projectId: i < 6 ? "p1" : null })))}.concat([{sessionId:'archived-session',projectId:'archived'}]),settings:{},jobs:[]};
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
    fixture.renderTree();`);
  assert.equal(await evaluate("document.querySelectorAll('.dtw-session').length"), 9);
  assert.equal(await evaluate("document.querySelectorAll('.dtw-session.active').length"), 1);
  assert.equal(await evaluate("document.querySelector('#native-history').style.display"), "none");
  assert.equal(await evaluate("document.querySelectorAll('.native-row').length"), 8, "原生节点保持挂载");
  assert.equal(await evaluate("Boolean(document.querySelector('[data-group=archived]'))"), false, "聊天侧栏隐藏归档项目");
  assert.equal(await evaluate("Boolean(document.querySelector('[data-session=archived-session]'))"), false, "归档会话不转入未归类");
  assert.equal(await evaluate("fixture.state.snapshot.sessions.some(session=>session.sessionId==='archived-session')"), true, "隐藏归档项目不删除数据");
  await evaluate("globalThis.fixtureHelp=document.querySelector('.dtw-help-trigger');fixtureHelp.focus()");
  assert.equal(await evaluate("document.querySelector('.dtw-help-tip').matches(':popover-open')"), true);
  assert.match(await evaluate("document.querySelector('.dtw-help-tip').textContent"), /归类、记忆整理和压缩/);
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
  assert.deepEqual(await evaluate("fixtureStorage['dtw.collapsed:sidebar-test-account']"), ["p1"]);
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
  assert.deepEqual(await evaluate("fixtureStorage['dtw.collapsed:sidebar-test-account']"), []);
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
    ["打开会话", "重命名", "置顶", "分享", "多选", "移到项目", "从项目中移除", "删除会话"]);
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
  await pointerClick("session-menu","s1");
  await click("open-picker", "s1");
  assert.equal(await evaluate("Boolean(document.querySelector('.ds-dropdown-menu'))"), false);
  await click("move-to", "p2");
  await waitFor("会话归类", () => evaluate("Boolean(document.querySelector('[data-group=\"p2\"] [data-session=\"s1\"]'))"));
  assert.equal(await evaluate("Boolean(document.querySelector('.dtw-menu'))"), false);
  await click("session-menu", "s1");
  await waitFor("从项目移除入口", () => evaluate("Boolean(document.querySelector('[data-action=\"remove-from-project\"]'))"));
  await click("remove-from-project", "s1");
  await waitFor("移到未归类", () => evaluate("Boolean(document.querySelector('.dtw-unassigned [data-session=\"s1\"]'))"));
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
  await evaluate(`fixture.state.snapshot.sessions.push(...Array.from({length:14},(_,i)=>({sessionId:'p0-helper-'+i,purpose:'MEMORY',automationOrigin:'PLUGIN',updatedAtMs:i})),
    {sessionId:'p0-manual',purpose:'AUTOMATION',automationOrigin:'MANUAL',updatedAtMs:-2},
    {sessionId:'p0-unknown',purpose:'AUTOMATION',automationOrigin:'UNKNOWN',updatedAtMs:-3});fixture.renderTree()`);
  assert.equal(await evaluate("document.querySelectorAll('[data-session^=p0-helper-]').length"), 10);
  assert.equal(await evaluate("Boolean(document.querySelector('[data-session=p0-manual]'))&&Boolean(document.querySelector('[data-session=p0-unknown]'))"), true, "手动收纳和来源不明会话不被数量上限隐藏");
  await click("session-menu", "p0-manual");
  assert.equal(await evaluate("Boolean(document.querySelector('[data-action=automation-unmark]'))"), true);
  console.log(JSON.stringify({ ok: true, checks: "plugin menus open on one click, refreshed anchors, original callbacks without visible dropdowns, pin state, hints, archives and viewport" }));
} finally {
  if (browser) await browser.call("Browser.close").catch(() => {});
  page?.close(); browser?.close(); chrome.kill();
  await new Promise(resolve => server.close(resolve));
  await delay(500);
  assert.equal(path.dirname(profile), path.resolve(os.tmpdir()));
  assert.ok(path.basename(profile).startsWith("dtw-sidebar-test-"));
  await fs.rm(profile, { recursive: true, force: true, maxRetries: 4, retryDelay: 200 });
}
