/* 持久化层测试：乐观锁、模拟失败与未完成批次 */
const test = require("node:test");
const assert = require("node:assert/strict");
const S = require("../js/storage.js");
const R = require("../js/rules.js");

function makeStore() {
  return S.createStore({
    backend: S.createMemoryBackend(),
    prepare: (raw) => R.normalizeState(raw || R.createEmptyState("演示卷"))
  });
}

test("首次加载返回初始数据且版本为 0", () => {
  const store = makeStore();
  const { version, data } = store.load();
  assert.equal(version, 0);
  assert.equal(data.reelTitle, "演示卷");
});

test("commit 递增版本；落后版本不能覆盖新数据（stale）", () => {
  const store = makeStore();
  const first = store.load();
  const r1 = store.commit(R.setReelTitle(first.data, "窗口A"), 0);
  assert.equal(r1.ok, true);
  assert.equal(r1.version, 1);

  // 另一窗口也基于 v0 提交 -> 拒绝
  const r2 = store.commit(R.setReelTitle(first.data, "窗口B"), 0);
  assert.equal(r2.ok, false);
  assert.equal(r2.reason, "stale");
  assert.equal(r2.current.version, 1);

  // 基于最新 v1 提交 -> 成功
  const latest = store.load();
  const r3 = store.commit(R.setReelTitle(latest.data, "窗口B跟进"), 1);
  assert.equal(r3.ok, true);
  assert.equal(r3.version, 2);
});

test("force=true 经人工确认后可覆盖，版本仍向前递增不倒退", () => {
  const store = makeStore();
  const start = store.load();
  store.commit(R.setReelTitle(start.data, "新"), 0);
  const forced = store.commit(R.setReelTitle(start.data, "强制"), 0, true);
  assert.equal(forced.ok, true);
  assert.equal(forced.version, 2);
  assert.equal(store.load().data.reelTitle, "强制");
});

test("保存失败留下未完成批次，重试成功后清除", () => {
  const store = makeStore();
  const start = store.load();
  store.failNextSave();
  const failed = store.commit(R.setReelTitle(start.data, "批次数据"), 0);
  assert.equal(failed.ok, false);
  const batch = store.enqueuePendingBatch({ data: R.setReelTitle(start.data, "批次数据"), baseVersion: 0, reason: failed.reason });
  assert.equal(store.listPendingBatches().length, 1);

  // 期间没有新写入，重试成功
  const retry = store.commit(R.normalizeState(batch.data), batch.baseVersion);
  assert.equal(retry.ok, true);
  store.removePendingBatch(batch.id);
  assert.equal(store.listPendingBatches().length, 0);
  assert.equal(store.load().data.reelTitle, "批次数据");
});

test("重试时若已被别的窗口抢先保存，返回 stale 等人工确认", () => {
  const store = makeStore();
  const start = store.load();
  store.failNextSave();
  const failed = store.commit(R.setReelTitle(start.data, "失败批次"), 0);
  const batch = store.enqueuePendingBatch({ data: R.setReelTitle(start.data, "失败批次"), baseVersion: 0, reason: failed.reason });

  store.commit(R.setReelTitle(start.data, "另一窗口先保存"), 0);
  const retry = store.commit(R.normalizeState(batch.data), batch.baseVersion);
  assert.equal(retry.ok, false);
  assert.equal(retry.reason, "stale");
  assert.equal(retry.current.version, 1);
});
