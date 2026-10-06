/*
 * storage.js — 持久化层
 *
 * 负责 localStorage 读写、版本号乐观并发控制、未完成批次（batch）的落盘与重试。
 * 页面与规则都不直接碰 localStorage，统一走这里。
 *
 * 并发模型：
 *  - 每份状态带 version。保存时比较 baseVersion 与存储中的 version，
 *    不一致说明另一个窗口已保存更新版本 → 记冲突批次，不覆盖新数据。
 *  - 保存异常（配额 / 模拟失败）→ 记失败批次，保留 localState 供重试。
 *  - 批次单独存一个 key，冲突或失败都不丢，可随时重试 / 人工确认。
 */
(function (global) {
  "use strict";

  var STATE_KEY = "film-release-desk-v1";
  var BATCH_KEY = "film-release-desk-batches-v1";
  var FAIL_FLAG_KEY = "film-release-desk-simulate-fail";

  /* ---------- 默认状态 ---------- */

  function defaultState() {
    return {
      version: 1,
      reelTitle: "春日试映A卷",
      segments: [
        {
          id: uid(),
          code: "A-001",
          duration: 18,
          shift: "正常",
          damage: "完好",
          note: "开场街景，节奏平稳，适合保留原顺序。",
          thumb: "",
          receipt: null,
          receiptStatus: "none"
        },
        {
          id: uid(),
          code: "A-006",
          duration: 9,
          shift: "偏红",
          damage: "轻微划痕",
          note: "人物近景左侧有划痕，试映时留意是否明显。",
          thumb: "",
          receipt: null,
          receiptStatus: "none"
        },
        {
          id: uid(),
          code: "A-012",
          duration: 14,
          shift: "褪色",
          damage: "接片松动",
          note: "接片位置靠近段尾，放映前建议重新压平。",
          thumb: "",
          receipt: null,
          receiptStatus: "none"
        }
      ],
      permits: [],
      reelPlan: null
    };
  }

  /* ---------- 状态读写 ---------- */

  function loadState() {
    var raw = null;
    try { raw = global.localStorage.getItem(STATE_KEY); } catch (e) { raw = null; }
    if (!raw) return defaultState();
    try {
      var parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") return defaultState();
      var base = defaultState();
      return {
        version: parsed.version || base.version,
        reelTitle: parsed.reelTitle != null ? parsed.reelTitle : base.reelTitle,
        segments: Array.isArray(parsed.segments) ? parsed.segments : base.segments,
        permits: Array.isArray(parsed.permits) ? parsed.permits : [],
        reelPlan: parsed.reelPlan || null
      };
    } catch (e) {
      return defaultState();
    }
  }

  function readStored() {
    try {
      var raw = global.localStorage.getItem(STATE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }

  function writeStored(state) {
    global.localStorage.setItem(STATE_KEY, JSON.stringify(state));
  }

  /* ---------- 失败注入（演示用） ---------- */

  function simulateFailOn() { global.localStorage.setItem(FAIL_FLAG_KEY, "1"); }
  function simulateFailOff() { global.localStorage.removeItem(FAIL_FLAG_KEY); }
  function isSimulateFail() { return global.localStorage.getItem(FAIL_FLAG_KEY) === "1"; }

  /* ---------- 批次 ---------- */

  function loadBatches() {
    try {
      var raw = global.localStorage.getItem(BATCH_KEY);
      var arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch (e) {
      return [];
    }
  }

  function saveBatches(batches) {
    try {
      global.localStorage.setItem(BATCH_KEY, JSON.stringify(batches));
    } catch (e) {
      /* 批次落盘失败时至少保留在内存 */
    }
  }

  function addBatch(batch) {
    var batches = loadBatches();
    batches.unshift(batch);
    saveBatches(batches);
    return batch;
  }

  function updateBatch(id, patch) {
    var batches = loadBatches();
    for (var i = 0; i < batches.length; i++) {
      if (batches[i].id === id) {
        batches[i] = Object.assign({}, batches[i], patch);
        saveBatches(batches);
        return batches[i];
      }
    }
    return null;
  }

  /* ---------- 保存（乐观并发） ---------- */

  // prevState：保存前内存中的状态（取其 version 作为 baseVersion）。
  // nextState：要写入的新状态。
  // 返回 { ok: true, state } 或 { ok: false, reason, batch, remoteState }。
  function attemptSave(prevState, nextState) {
    // 演示用：模拟一次保存失败，失败后保留批次可重试。
    if (isSimulateFail()) {
      simulateFailOff();
      var batch = addBatch({
        id: uid(),
        createdAt: new Date().toISOString(),
        reason: "save-failed",
        status: "pending",
        baseVersion: prevState ? prevState.version : 1,
        localState: clone(nextState),
        remoteState: null,
        conflicts: [],
        resolution: null,
        error: "已开启保存失败模拟（演示）"
      });
      return { ok: false, reason: "save-failed", batch: batch };
    }

    var stored = readStored();
    if (stored && prevState && stored.version !== prevState.version) {
      // 版本落后：不覆盖，逐字段列出冲突，等人工确认。
      var conflicts = global.Rules.detectConflicts(nextState, stored);
      var conflictBatch = addBatch({
        id: uid(),
        createdAt: new Date().toISOString(),
        reason: "conflict",
        status: "pending",
        baseVersion: prevState.version,
        localState: clone(nextState),
        remoteState: clone(stored),
        conflicts: conflicts,
        resolution: null,
        error: null
      });
      return { ok: false, reason: "conflict", batch: conflictBatch, remoteState: stored };
    }

    // 正常写入。版本号在 baseVersion 基础上递增。
    nextState.version = (prevState ? prevState.version : 0) + 1;
    try {
      writeStored(nextState);
      return { ok: true, state: nextState };
    } catch (e) {
      var failedBatch = addBatch({
        id: uid(),
        createdAt: new Date().toISOString(),
        reason: "save-failed",
        status: "pending",
        baseVersion: prevState ? prevState.version : 1,
        localState: clone(nextState),
        remoteState: null,
        conflicts: [],
        resolution: null,
        error: String((e && e.message) || e)
      });
      return { ok: false, reason: "save-failed", batch: failedBatch };
    }
  }

  // 重试某个批次：用合并后的状态（或本地状态）再次保存。
  function retryBatch(batchId, mergedState) {
    var batches = loadBatches();
    var batch = null;
    for (var i = 0; i < batches.length; i++) {
      if (batches[i].id === batchId) { batch = batches[i]; break; }
    }
    if (!batch) return { ok: false, reason: "not-found" };

    var stateToSave = clone(mergedState || batch.localState);
    var base = batch.remoteState
      ? { version: batch.remoteState.version }
      : { version: batch.baseVersion };

    var result = attemptSave(base, stateToSave);
    if (result.ok) {
      updateBatch(batchId, { status: "resolved", resolution: "retry", resolvedAt: new Date().toISOString() });
    }
    return result;
  }

  function resolveBatch(batchId, resolution) {
    updateBatch(batchId, {
      status: "resolved",
      resolution: resolution,
      resolvedAt: new Date().toISOString()
    });
  }

  /* ---------- 工具 ---------- */

  function clone(obj) {
    return JSON.parse(JSON.stringify(obj));
  }

  function uid() {
    if (global.crypto && global.crypto.randomUUID) return global.crypto.randomUUID();
    return "id-" + Date.now() + "-" + Math.random().toString(16).slice(2);
  }

  global.Storage = {
    STATE_KEY: STATE_KEY,
    BATCH_KEY: BATCH_KEY,
    FAIL_FLAG_KEY: FAIL_FLAG_KEY,
    loadState: loadState,
    attemptSave: attemptSave,
    loadBatches: loadBatches,
    retryBatch: retryBatch,
    resolveBatch: resolveBatch,
    simulateFailOn: simulateFailOn,
    simulateFailOff: simulateFailOff,
    isSimulateFail: isSimulateFail
  };
})(window);
