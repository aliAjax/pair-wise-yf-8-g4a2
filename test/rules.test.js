/* 规则判定层测试：node test/rules.test.js */
const test = require("node:test");
const assert = require("node:assert/strict");
const R = require("../js/rules.js");

function seg(over = {}) {
  return {
    id: over.id || `s-${Math.random().toString(36).slice(2)}`,
    code: over.code || "A-001",
    duration: over.duration ?? 10,
    shift: over.shift || "正常",
    damage: over.damage || "完好",
    note: "",
    thumb: "",
    inspection: over.inspection || null,
    ruling: over.ruling || null
  };
}

test("装盘：贪心填充，每盘不超过 150 秒", () => {
  const state = R.createEmptyState();
  const durations = [60, 90, 140, 30, 10];
  durations.forEach((d, i) => state.segments.push(seg({ id: `x${i}`, code: `A-${i}`, duration: d })));
  const plates = R.packPlates(state.segments);
  // next-fit 只往当前盘装：60+90=150；140 独占；30+10=40
  assert.equal(plates.length, 3);
  assert.deepEqual(
    plates.map((p) => p.total),
    [150, 140, 40]
  );
  assert.ok(plates.every((p) => p.overflow === false));
});

test("装盘：单片超过 150 秒独占一盘并标超时", () => {
  const state = R.createEmptyState();
  state.segments.push(seg({ id: "a", duration: 150 }));
  state.segments.push(seg({ id: "b", code: "A-002", duration: 200 }));
  state.segments.push(seg({ id: "c", code: "A-003", duration: 10 }));
  const plates = R.packPlates(state.segments);
  assert.equal(plates.length, 3);
  assert.equal(plates[0].overflow, false);
  assert.equal(plates[1].overflow, true);
});

test("外检回执晚到：同编号两种结论并存并待裁定，不盖排片员结论", () => {
  let state = R.createEmptyState();
  state = R.addSegment(state, { code: "A-006", duration: 9, shift: "偏红", damage: "轻微划痕" });
  const id = state.segments[0].id;
  state = R.receiveReceipts(state, [{ code: "A-006", duration: 9, shift: "偏红", damage: "齿孔破损", receiptNo: "WJ-1" }]);
  assert.equal(R.statusOf(state.segments[0]), "pending");
  // 排片员的值仍在
  assert.equal(state.segments[0].damage, "轻微划痕");
  assert.equal(state.segments[0].inspection.damage, "齿孔破损");
  // 生效结论回退排片员值但带 pending，签放被拦
  assert.equal(R.effectiveConclusion(state.segments[0]).damage, "轻微划痕");
  assert.equal(R.canIssue(state).ok, false);
  assert.match(R.canIssue(state).reasons[0], /待裁定/);
  // issuePermit 直接拒绝
  assert.equal(R.issuePermit(state).ok, false);
  // 裁定后放行
  state = R.adjudicate(state, id, "inspection");
  assert.equal(R.statusOf(state.segments[0]), "ruled");
  assert.equal(R.effectiveConclusion(state.segments[0]).damage, "齿孔破损");
  assert.equal(R.canIssue(state).ok, true);
});

test("外检结论与排片员一致时直接 agreed，不拦签放", () => {
  let state = R.createEmptyState();
  state = R.addSegment(state, { code: "A-001", duration: 18, shift: "正常", damage: "完好" });
  state = R.receiveReceipts(state, [{ code: "A-001", duration: 18, shift: "正常", damage: "完好" }]);
  assert.equal(R.statusOf(state.segments[0]), "agreed");
  assert.equal(R.canIssue(state).ok, true);
});

test("排片员再改时长/颜色/破损：与外检重新比对，旧裁定失效并重新待裁定", () => {
  let state = R.createDemoState();
  const id = state.segments.find((s) => s.code === "A-006").id;
  state = R.adjudicate(state, id, "inspection");
  assert.equal(R.statusOf(state.segments.find((s) => s.id === id)), "ruled");
  // 把时长改成与外检（9s）仍不同的 20s -> 重新 pending
  state = R.updateSegment(state, id, { duration: 20 });
  assert.equal(R.statusOf(state.segments.find((s) => s.id === id)), "pending");
  // 改成与外检完全一致 -> agreed
  state = R.updateSegment(state, id, { duration: 9, damage: "齿孔破损" });
  assert.equal(R.statusOf(state.segments.find((s) => s.id === id)), "agreed");
});

test("找不到片段的回执拦截签放，补入同编号片段后自动归并", () => {
  let state = R.createEmptyState();
  state = R.addSegment(state, { code: "A-001", duration: 10 });
  state = R.receiveReceipts(state, [{ code: "Z-999", duration: 5, shift: "褪色", damage: "需跳过" }]);
  assert.equal(R.unmatchedReceipts(state).length, 1);
  assert.equal(R.canIssue(state).ok, false);
  state = R.addSegment(state, { code: "Z-999", duration: 5, shift: "褪色", damage: "需跳过" });
  assert.equal(R.unmatchedReceipts(state).length, 0);
  assert.equal(R.statusOf(state.segments.find((s) => s.code === "Z-999")), "agreed");
  assert.equal(R.canIssue(state).ok, true);
});

test("许可绑定顺序/风险结论/盘数：变化即 void 并重排盘", () => {
  let state = R.createEmptyState();
  state = R.addSegment(state, { code: "A-001", duration: 60 });
  state = R.addSegment(state, { code: "A-002", duration: 100 });
  state = R.addSegment(state, { code: "A-003", duration: 60 });
  const issued = R.issuePermit(state);
  assert.equal(issued.ok, true);
  assert.equal(issued.permit.plateCount, 3); // 60、100、60 各自成盘
  state = issued.state;
  assert.equal(R.evaluatePermit(state).status, "valid");

  // 顺序变化
  let changed = R.reorderTo(state, state.segments[0].id, state.segments[2].id);
  assert.equal(R.evaluatePermit(changed).status, "void");
  assert.ok(R.evaluatePermit(changed).reasons.some((r) => r.code === "order"));

  // 时长变化（不改变盘数也要 void 重新签）
  changed = R.updateSegment(state, state.segments[0].id, { duration: 100 });
  const eval0 = R.evaluatePermit(changed);
  assert.equal(eval0.status, "void");
  assert.ok(eval0.reasons.some((r) => r.code === "duration"));
  // 60->100 且顺序在后：100、60、100 仍为 3 盘；改成 50 验证重排为 2 盘
  changed = R.updateSegment(state, state.segments[0].id, { duration: 50 });
  assert.equal(R.evaluatePermit(changed).reasons.some((r) => r.code === "plates"), true);
  assert.equal(R.packPlates(changed.segments).length, 2);

  // 颜色 / 破损变化
  changed = R.updateSegment(state, state.segments[0].id, { shift: "偏红" });
  assert.ok(R.evaluatePermit(changed).reasons.some((r) => r.code === "shift"));
  changed = R.updateSegment(state, state.segments[0].id, { damage: "需跳过" });
  assert.ok(R.evaluatePermit(changed).reasons.some((r) => r.code === "damage"));

  // 新增 / 删除片段
  changed = R.addSegment(state, { code: "A-004", duration: 1 });
  assert.equal(R.evaluatePermit(changed).status, "void");
  changed = R.removeSegment(state, state.segments[2].id);
  assert.equal(R.evaluatePermit(changed).status, "void");
});

test("备注、缩略图、胶片卷名称变化不作废许可", () => {
  let state = R.createEmptyState();
  state = R.addSegment(state, { code: "A-001", duration: 60 });
  state = R.issuePermit(state).state;
  const id = state.segments[0].id;
  let changed = R.updateSegment(state, id, { note: "新备注", thumb: "data:,x" });
  assert.equal(R.evaluatePermit(changed).status, "valid");
  changed = R.setReelTitle(changed, "新卷名");
  assert.equal(R.evaluatePermit(changed).status, "valid");
});

test("许可有效期间晚到不一致回执 -> suspended 暂缓，不是 void；裁定后恢复 valid", () => {
  let state = R.createEmptyState();
  state = R.addSegment(state, { code: "A-001", duration: 18, shift: "正常", damage: "完好" });
  state = R.issuePermit(state).state;
  state = R.receiveReceipts(state, [{ code: "A-001", duration: 18, shift: "偏青", damage: "完好" }]);
  assert.equal(R.evaluatePermit(state).status, "suspended");
  assert.equal(R.canIssue(state).ok, false);
  state = R.adjudicate(state, state.segments[0].id, "scheduler");
  assert.equal(R.evaluatePermit(state).status, "valid");
  // 若裁定采外检 -> 颜色变了 -> void
  let state2 = R.createEmptyState();
  state2 = R.addSegment(state2, { code: "A-001", duration: 18, shift: "正常", damage: "完好" });
  state2 = R.issuePermit(state2).state;
  state2 = R.receiveReceipts(state2, [{ code: "A-001", duration: 18, shift: "偏青", damage: "完好" }]);
  state2 = R.adjudicate(state2, state2.segments[0].id, "inspection");
  assert.equal(R.evaluatePermit(state2).status, "void");
});

test("三方差异：只一方改不冲突；双方改同字段进冲突清单", () => {
  const base = R.normalizeState(R.createEmptyState());
  const a = R.addSegment(base, { code: "A-001", duration: 10, shift: "正常", damage: "完好" });
  const id = a.segments[0].id;
  const local = R.updateSegment(a, id, { duration: 20 });
  const remoteSame = R.updateSegment(a, id, { note: "另一窗口加备注" });
  let diff = R.diffStates(a, local, remoteSame);
  assert.equal(diff.conflicts.length, 0);
  assert.equal(diff.localOnly.length, 1);
  assert.equal(diff.remoteOnly.length, 1);

  const remoteConflict = R.updateSegment(a, id, { duration: 30 });
  diff = R.diffStates(a, local, remoteConflict);
  assert.equal(diff.conflicts.length, 1);
  assert.match(diff.conflicts[0].path, /duration$/);
});

test("批量回执解析：合法行入列，坏行返回错误位置", () => {
  const text = ["A-001,12,正常,完好,WJ-1", "坏行", "A-002,0,偏红,完好", "A-003,5,奇怪颜色,完好", "# 注释行", "A-004,8,褪色,接片松动"].join("\n");
  const { items, errors } = R.parseReceiptBatch(text);
  assert.equal(items.length, 2);
  assert.equal(items[0].code, "A-001");
  assert.equal(errors.length, 3);
});

test("v1 核对台数据迁移", () => {
  const v1 = {
    reelTitle: "旧卷",
    segments: [
      { id: "old-1", code: "A-001", duration: 11, shift: "偏红", damage: "完好", note: "n", thumb: "" }
    ]
  };
  const migrated = R.migrateV1(v1);
  assert.equal(migrated.reelTitle, "旧卷");
  assert.equal(migrated.segments.length, 1);
  assert.equal(migrated.segments[0].code, "A-001");
  assert.equal(R.statusOf(migrated.segments[0]), "local");
});
