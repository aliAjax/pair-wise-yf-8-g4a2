/*
 * app.js — 主控制器
 *
 * 持有内存状态、串联规则层与持久化层、响应页面操作。
 * 页面只负责渲染，规则只负责判定，持久化只负责读写。
 */
(function () {
  "use strict";

  var Rules = window.Rules;
  var Storage = window.Storage;
  var UI = window.UI;

  /* ---------- 状态 ---------- */

  var state = Storage.loadState();
  var currentTab = "segments";
  var dirty = false;

  /* ---------- 持久化 ---------- */

  function saveNow() {
    var prevVersion = state.version;
    var result = Storage.attemptSave({ version: prevVersion }, state);
    if (result.ok) {
      state.version = result.state.version;
      dirty = false;
      toast("已保存 v" + state.version);
      refresh();
      return;
    }
    if (result.reason === "conflict") {
      dirty = false;
      toast("保存失败：与新版本冲突，已生成批次待人工确认");
      currentTab = "batches";
    } else {
      dirty = false;
      toast("保存失败：已留下未完成批次，可在批次页重试");
      currentTab = "batches";
    }
    refresh();
  }

  function reloadRemote() {
    state = Storage.loadState();
    dirty = false;
    var banner = document.getElementById("remoteBanner");
    if (banner) banner.hidden = true;
    toast("已重新加载最新版本");
    refresh();
  }

  /* ---------- 变更 ---------- */

  function markDirty() {
    dirty = true;
    refresh();
  }

  function addSegment(data) {
    state.segments.push({
      id: uid(),
      code: data.code,
      duration: Number(data.duration) || 1,
      shift: data.shift,
      damage: data.damage,
      note: data.note,
      thumb: data.thumb || "",
      receipt: null,
      receiptStatus: "none"
    });
    markDirty();
  }

  function updateSegment(id, field, value) {
    var seg = null;
    for (var i = 0; i < state.segments.length; i++) {
      if (state.segments[i].id === id) { seg = state.segments[i]; break; }
    }
    if (!seg) return;
    seg[field] = value;
    markDirty();
  }

  function deleteSegment(id) {
    state.segments = state.segments.filter(function (s) { return s.id !== id; });
    markDirty();
  }

  function moveSegment(id, direction) {
    var index = state.segments.findIndex(function (s) { return s.id === id; });
    var target = index + direction;
    if (index < 0 || target < 0 || target >= state.segments.length) return;
    var item = state.segments.splice(index, 1)[0];
    state.segments.splice(target, 0, item);
    markDirty();
  }

  function reorderSegments(fromIndex, toIndex) {
    if (fromIndex < 0 || toIndex < 0 || fromIndex >= state.segments.length || toIndex >= state.segments.length) return;
    var item = state.segments.splice(fromIndex, 1)[0];
    state.segments.splice(toIndex, 0, item);
    markDirty();
  }

  /* ---------- 外检回执 ---------- */

  function importReceipts(text) {
    var items = Rules.parseReceiptText(text);
    var result = Rules.mergeReceipts(state.segments, items);
    markDirty();
    return result;
  }

  function confirmReceipt(segmentId, choice) {
    Rules.confirmReceipt(state.segments, segmentId, choice);
    markDirty();
  }

  /* ---------- 装盘 ---------- */

  function replanReels() {
    var plan = Rules.planReels(state.segments, Rules.SECONDS_PER_REEL);
    state.reelPlan = {
      plannedAt: new Date().toISOString(),
      secondsPerReel: plan.secondsPerReel,
      reels: plan.reels,
      snapshot: Rules.buildSnapshot(state.segments, plan.reels.length, plan.secondsPerReel),
      status: "valid",
      voidReason: null
    };
    markDirty();
    toast("已按每盘 " + plan.secondsPerReel + " 秒排盘，共 " + plan.reels.length + " 盘");
  }

  /* ---------- 许可 ---------- */

  function issuePermit() {
    var result = Rules.issuePermit(state.segments, Rules.SECONDS_PER_REEL);
    if (!result.ok) {
      toast("存在未裁定的外检回执，不能生成放映许可");
      return;
    }
    state.permits.unshift(result.permit);
    markDirty();
    toast("已生成放映许可，绑定当前顺序、风险结论与盘数");
  }

  /* ---------- 批次处理 ---------- */

  function retryBatch(batchId) {
    var result = Storage.retryBatch(batchId, null);
    if (result.ok) {
      state = Storage.loadState();
      dirty = false;
      toast("批次已重试成功，已保存 v" + state.version);
    } else {
      toast("重试失败：与新版本仍有冲突，请人工确认");
    }
    refresh();
  }

  function resolveBatchKeepLocal(batchId) {
    var batches = Storage.loadBatches();
    var batch = null;
    for (var i = 0; i < batches.length; i++) {
      if (batches[i].id === batchId) { batch = batches[i]; break; }
    }
    if (!batch) return;
    var result = Storage.retryBatch(batchId, batch.localState);
    if (result.ok) {
      state = Storage.loadState();
      dirty = false;
      toast("已整体保留本地并保存 v" + state.version);
    } else {
      toast("保留本地后仍有冲突，请逐字段合并");
    }
    refresh();
  }

  function resolveBatchKeepRemote(batchId) {
    Storage.resolveBatch(batchId, "keep-remote");
    state = Storage.loadState();
    dirty = false;
    toast("已采用远程版本");
    refresh();
  }

  function mergeBatch(batchId, choices) {
    var batches = Storage.loadBatches();
    var batch = null;
    for (var i = 0; i < batches.length; i++) {
      if (batches[i].id === batchId) { batch = batches[i]; break; }
    }
    if (!batch) return;
    var merged = applyConflictChoices(batch, choices);
    var result = Storage.retryBatch(batchId, merged);
    if (result.ok) {
      state = Storage.loadState();
      dirty = false;
      toast("已按选择合并并保存 v" + state.version);
    } else {
      toast("合并后仍有冲突，请调整选择");
    }
    refresh();
  }

  // 按逐字段选择，在远程版本基础上应用本地选择。
  function applyConflictChoices(batch, choices) {
    var local = batch.localState;
    var remote = batch.remoteState;
    var merged = JSON.parse(JSON.stringify(remote));

    for (var i = 0; i < batch.conflicts.length; i++) {
      var c = batch.conflicts[i];
      var choice = choices[i] || "remote";
      if (choice !== "local") continue;

      if (c.type === "reelTitle") {
        merged.reelTitle = local.reelTitle;
      } else if (c.type === "removed") {
        merged.segments = merged.segments.filter(function (s) { return s.id !== c.segmentId; });
      } else if (c.type === "added") {
        var seg = null;
        for (var j = 0; j < local.segments.length; j++) {
          if (local.segments[j].id === c.segmentId) { seg = local.segments[j]; break; }
        }
        if (seg && !merged.segments.some(function (s) { return s.id === c.segmentId; })) {
          var idx = local.segments.findIndex(function (s) { return s.id === c.segmentId; });
          merged.segments.splice(Math.min(idx, merged.segments.length), 0, JSON.parse(JSON.stringify(seg)));
        }
      } else if (c.type === "field") {
        var target = null;
        for (var k = 0; k < merged.segments.length; k++) {
          if (merged.segments[k].id === c.segmentId) { target = merged.segments[k]; break; }
        }
        var source = null;
        for (var m = 0; m < local.segments.length; m++) {
          if (local.segments[m].id === c.segmentId) { source = local.segments[m]; break; }
        }
        if (target && source) target[c.field] = source[c.field];
      }
    }

    // 顺序冲突：把选本地的片段移到本地位置。
    var orderMoves = [];
    for (var n = 0; n < batch.conflicts.length; n++) {
      var oc = batch.conflicts[n];
      if (oc.type === "order" && (choices[n] || "remote") === "local") {
        var localIdx = local.segments.findIndex(function (s) { return s.id === oc.segmentId; });
        orderMoves.push({ id: oc.segmentId, idx: localIdx });
      }
    }
    orderMoves.sort(function (a, b) { return a.idx - b.idx; });
    for (var p = 0; p < orderMoves.length; p++) {
      var cur = merged.segments.findIndex(function (s) { return s.id === orderMoves[p].id; });
      if (cur >= 0) {
        var item = merged.segments.splice(cur, 1)[0];
        merged.segments.splice(Math.min(orderMoves[p].idx, merged.segments.length), 0, item);
      }
    }

    return merged;
  }

  /* ---------- 导航 ---------- */

  function navigate(tab) {
    currentTab = tab;
    refresh();
  }

  /* ---------- 渲染 ---------- */

  function refresh() {
    // 许可与装盘方案在渲染前按当前片段刷新作废状态。
    var changed = false;
    for (var i = 0; i < state.permits.length; i++) {
      var refreshed = Rules.refreshPermit(state.permits[i], state.segments);
      if (refreshed.status !== state.permits[i].status || refreshed.voidReason !== state.permits[i].voidReason) {
        state.permits[i] = refreshed;
        changed = true;
      }
    }
    if (state.reelPlan) {
      var refreshedPlan = Rules.refreshReelPlan(state.reelPlan, state.segments);
      if (refreshedPlan.status !== state.reelPlan.status || refreshedPlan.voidReason !== state.reelPlan.voidReason) {
        state.reelPlan = refreshedPlan;
        changed = true;
      }
    }
    if (changed) dirty = true;

    // 顶部统计
    var total = state.segments.reduce(function (sum, item) { return sum + Number(item.duration); }, 0);
    var damaged = state.segments.filter(function (item) { return item.damage !== "完好"; }).length;
    var el;
    el = document.querySelector("#totalDuration");
    if (el) el.textContent = UI.formatDuration(total);
    el = document.querySelector("#damageCount");
    if (el) el.textContent = damaged;
    el = document.querySelector("#segmentCount");
    if (el) el.textContent = state.segments.length;

    // 保存状态
    var saveStatus = document.querySelector("#saveStatus");
    if (saveStatus) {
      saveStatus.textContent = dirty ? "有未保存更改" : "已保存 v" + state.version;
      saveStatus.classList.toggle("dirty", dirty);
    }
    var saveBtn = document.querySelector("#saveBtn");
    if (saveBtn) saveBtn.classList.toggle("attention", dirty);

    // 徽标
    var batches = Storage.loadBatches();
    UI.updateBadges(state, batches);

    // 当前页
    var page = document.getElementById("page");
    var actions = {
      addSegment: addSegment,
      updateSegment: updateSegment,
      deleteSegment: deleteSegment,
      moveSegment: moveSegment,
      reorderSegments: reorderSegments,
      importReceipts: importReceipts,
      confirmReceipt: confirmReceipt,
      replanReels: replanReels,
      issuePermit: issuePermit,
      retryBatch: retryBatch,
      resolveBatchKeepLocal: resolveBatchKeepLocal,
      resolveBatchKeepRemote: resolveBatchKeepRemote,
      mergeBatch: mergeBatch,
      navigate: navigate
    };

    if (currentTab === "segments") UI.renderSegments(page, state, actions);
    else if (currentTab === "receipts") UI.renderReceipts(page, state, actions);
    else if (currentTab === "reels") UI.renderReels(page, state, actions);
    else if (currentTab === "permits") UI.renderPermits(page, state, actions);
    else if (currentTab === "batches") UI.renderBatches(page, state, actions, batches);

    // 标签激活态
    var tabBtns = document.querySelectorAll("#tabs button");
    for (var i = 0; i < tabBtns.length; i++) {
      tabBtns[i].classList.toggle("active", tabBtns[i].dataset.tab === currentTab);
    }
  }

  /* ---------- 提示 ---------- */

  var toastTimer = null;
  function toast(message) {
    var el = document.getElementById("toast");
    if (!el) return;
    el.textContent = message;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.hidden = true; }, 3200);
  }

  /* ---------- 工具 ---------- */

  function uid() {
    if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID();
    return "id-" + Date.now() + "-" + Math.random().toString(16).slice(2);
  }

  /* ---------- 事件 ---------- */

  document.getElementById("tabs").addEventListener("click", function (event) {
    var btn = event.target.closest("button[data-tab]");
    if (btn) navigate(btn.dataset.tab);
  });

  document.getElementById("saveBtn").addEventListener("click", saveNow);

  document.addEventListener("keydown", function (event) {
    if ((event.ctrlKey || event.metaKey) && event.key === "s") {
      event.preventDefault();
      saveNow();
    }
  });

  document.getElementById("reloadRemoteBtn").addEventListener("click", reloadRemote);

  // 跨窗口同步：另一个窗口保存后给出提示，本窗口不自动覆盖。
  window.addEventListener("storage", function (event) {
    if (event.key === Storage.STATE_KEY) {
      var banner = document.getElementById("remoteBanner");
      if (banner) banner.hidden = false;
    }
    if (event.key === Storage.BATCH_KEY) {
      refresh();
    }
  });

  /* ---------- 启动 ---------- */

  refresh();
})();
