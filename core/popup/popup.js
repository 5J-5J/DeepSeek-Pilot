/* global chrome, DTWFS */
"use strict";

const STATUS_LABELS = {
  ok: "已连接文件夹",
  degraded: "授权失效，记忆暂存于浏览器副本",
  unauthorized: "未选择文件夹（记忆只存浏览器本地）",
};
const STATUS_CLASSES = { ok: "is-ok", degraded: "is-degraded", unauthorized: "is-unauthorized" };

const $ = (id) => document.getElementById(id);
const send = (message) => chrome.runtime.sendMessage(message);
const report = (text) => {
  $("report").textContent = text;
  $("report").style.display = "block";
};

async function refresh() {
  try {
    const status = await send({ type: "dtw:fs-status" });
    if (!status?.ok) throw new Error(status?.error || "无法读取状态");
    const el = $("status");
    el.className = `status ${STATUS_CLASSES[status.status] || ""}`;
    el.innerHTML = `<strong>${STATUS_LABELS[status.status] || status.status}</strong>` +
      `<small>${[
        status.handleName ? `文件夹：${status.handleName}` : "",
        status.lastSyncAt ? `上次同步：${status.lastSyncAt.replace("T", " ").slice(0, 19)}` : "",
        status.lastError || "",
      ].filter(Boolean).join("<br>")}</small>`;
    return status;
  } catch (error) {
    $("status").innerHTML = `<strong>状态读取失败</strong><small>${error.message}</small>`;
    return null;
  }
}

$("authorize").addEventListener("click", async () => {
  report("授权中…");
  try {
    // handle 不能经 runtime 消息传递（序列化会剥掉方法）；popup 与后台共享
    // 同一个扩展源 IndexedDB，从这里自取、自存，消息只做通知。
    let handle = await DTWFS.loadStoredHandle();
    if (handle) {
      // 先尝试恢复存量授权（popup 点击即用户手势），失败再让用户重选文件夹。
      if (await handle.queryPermission({ mode: "readwrite" }) !== "granted") {
        await handle.requestPermission({ mode: "readwrite" });
      }
    } else {
      handle = await window.showDirectoryPicker({ mode: "readwrite" });
    }
    await DTWFS.saveStoredHandle(handle);
    const result = await send({ type: "dtw:fs-authorize" });
    if (!result?.ok) throw new Error(result?.error || "授权失败");
    report(`已连接。任务 ${result.loaded?.tasks ?? "-"} / 事实 ${result.loaded?.facts ?? "-"}，跳过坏文件：${result.skipped?.length ? result.skipped.join("、") : "无"}`);
  } catch (error) {
    if (error?.name === "AbortError") return report("已取消选择。");
    report(`授权失败：${error.message}`);
  }
  await refresh();
});

$("reload").addEventListener("click", async () => {
  report("重新载入中…");
  try {
    const result = await send({ type: "dtw:fs-reload" });
    if (!result?.ok) throw new Error(result?.error || `当前状态不支持（${result?.status || "未知"}）`);
    report(`已从文件夹载入：任务 ${result.loaded.tasks} 个、用户事实 ${result.loaded.facts} 条。` +
      (result.skipped?.length ? `跳过坏文件：${result.skipped.join("、")}` : ""));
  } catch (error) {
    report(`重新载入失败：${error.message}`);
  }
  await refresh();
});

refresh();
