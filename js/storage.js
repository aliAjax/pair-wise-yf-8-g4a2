/*
 * 持久化层：负责落盘与并发控制，不包含任何业务规则。
 *
 * - 每条数据带 version，保存时做乐观锁校验：
 *     本端基于 baseVersion 的修改，若存储里已是更新版本，则拒绝覆盖。
 * - 保存失败（含模拟失败）只写未完成批次，不动已落盘数据，之后可重试。
 * - 跨窗口通过 storage 事件广播最新版本。
 */
(function (global, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (global) global.DeskStorage = api;
})(typeof self !== "undefined" ? self : globalThis, function () {
  "use strict";

  const STATE_KEY = "zfl18-release-desk";
  const LEGACY_STATE_KEY = "zfl17-film-strip-desk";
  const OUTBOX_KEY = "zfl18-release-desk-outbox";

  function clone(value) {
    return value === undefined ? value : JSON.parse(JSON.stringify(value));
  }

  /** 内存后端，供 Node 测试用 */
  function createMemoryBackend(initial) {
    const store = new Map(initial ? Object.entries(initial) : []);
    const listeners = new Set();
    return {
      getItem(key) {
        return store.has(key) ? store.get(key) : null;
      },
      setItem(key, value) {
        store.set(key, String(value));
        listeners.forEach((fn) => fn({ key, newValue: String(value) }));
      },
      removeItem(key) {
        store.delete(key);
      },
      onExternalChange(fn) {
        listeners.add(fn);
        return () => listeners.delete(fn);
      }
    };
  }

  function createLocalBackend() {
    return {
      getItem(key) {
        try {
          return window.localStorage.getItem(key);
        } catch {
          return null;
        }
      },
      setItem(key, value) {
        window.localStorage.setItem(key, value);
      },
      removeItem(key) {
        window.localStorage.removeItem(key);
      },
      onExternalChange(fn) {
        const handler = (event) => {
          if (event.key === STATE_KEY || event.key === OUTBOX_KEY || event.key === null) {
            fn({ key: event.key, newValue: event.newValue });
          }
        };
        window.addEventListener("storage", handler);
        return () => window.removeEventListener("storage", handler);
      }
    };
  }

  function safeParse(raw, fallback) {
    if (raw === null || raw === undefined) return fallback;
    try {
      return JSON.parse(raw);
    } catch {
      return fallback;
    }
  }

  /**
   * @param {object} options
   *   backend  存储后端（默认 localStorage）
   *   prepare(raw, legacyRaw)  由业务层注入：把落盘数据（或 v1 数据）规范化成当前结构
   */
  function createStore(options = {}) {
    const backend = options.backend || createLocalBackend();
    const prepare = options.prepare || ((raw) => raw);
    const subscribers = new Set();

    function readRecord() {
      const raw = safeParse(backend.getItem(STATE_KEY), null);
      if (raw && typeof raw === "object" && raw.data) return raw;
      // 首次：尝试迁移旧的核对台数据
      const legacy = safeParse(backend.getItem(LEGACY_STATE_KEY), null);
      return { version: 0, data: prepare(null, legacy), updatedAt: 0 };
    }

    function load() {
      const record = readRecord();
      return { version: record.version || 0, data: clone(record.data), updatedAt: record.updatedAt || 0 };
    }

    /**
     * 乐观提交。
     * @param data         本窗口要写入的完整数据
     * @param baseVersion  本窗口读取时所依据的版本号
     * @param force        人工确认冲突后强制覆盖
     * @returns {ok, reason, current} —— 失败时 current 是存储里的最新版本
     */
    function commit(data, baseVersion, force = false) {
      if (failMode.simulateNext) {
        failMode.simulateNext = false;
        return { ok: false, reason: "simulated", error: new Error("模拟保存失败（存储不可用）") };
      }
      const record = readRecord();
      const currentVersion = record.version || 0;
      if (!force && baseVersion !== undefined && baseVersion < currentVersion) {
        return {
          ok: false,
          reason: "stale",
          conflict: true,
          current: { version: currentVersion, data: clone(record.data), updatedAt: record.updatedAt }
        };
      }
      const nextVersion = Math.max(currentVersion, baseVersion || 0) + 1;
      const next = { version: nextVersion, data: clone(data), updatedAt: Date.now() };
      try {
        backend.setItem(STATE_KEY, JSON.stringify(next));
      } catch (error) {
        return { ok: false, reason: "write-failed", error };
      }
      return { ok: true, version: nextVersion, data: clone(data) };
    }

    /* ---------------- 未完成批次 ---------------- */

    function listPendingBatches() {
      return safeParse(backend.getItem(OUTBOX_KEY), []) || [];
    }

    function savePendingBatches(batches) {
      backend.setItem(OUTBOX_KEY, JSON.stringify(batches));
    }

    /** 保存失败后把这次完整数据留成未完成批次，供稍后重试 */
    function enqueuePendingBatch(entry) {
      const batches = listPendingBatches();
      const batch = {
        id: `batch-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
        createdAt: Date.now(),
        reason: entry.reason || "write-failed",
        data: clone(entry.data),
        baseVersion: entry.baseVersion
      };
      batches.push(batch);
      savePendingBatches(batches);
      return batch;
    }

    function removePendingBatch(id) {
      savePendingBatches(listPendingBatches().filter((batch) => batch.id !== id));
    }

    function clearPendingBatches() {
      savePendingBatches([]);
    }

    /* ---------------- 失败模拟 & 跨窗口广播 ---------------- */

    const failMode = { simulateNext: false };
    function failNextSave() {
      failMode.simulateNext = true;
    }

    let unsubscribe = null;
    function start() {
      if (unsubscribe || !backend.onExternalChange) return;
      unsubscribe = backend.onExternalChange((event) => {
        const snapshot = event.key === STATE_KEY ? load() : null;
        subscribers.forEach((fn) => fn({ key: event.key, snapshot }));
      });
    }
    function stop() {
      if (unsubscribe) unsubscribe();
      unsubscribe = null;
    }
    function subscribe(fn) {
      subscribers.add(fn);
      return () => subscribers.delete(fn);
    }

    return {
      backend,
      load,
      commit,
      listPendingBatches,
      enqueuePendingBatch,
      removePendingBatch,
      clearPendingBatches,
      failNextSave,
      subscribe,
      start,
      stop
    };
  }

  return {
    STATE_KEY,
    LEGACY_STATE_KEY,
    OUTBOX_KEY,
    createStore,
    createMemoryBackend,
    createLocalBackend
  };
});
