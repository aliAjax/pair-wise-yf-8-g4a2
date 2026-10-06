/*
 * 规则判定层（纯逻辑，不碰 DOM、不碰 localStorage）
 *
 * 负责：
 *  - 排片员结论 / 外检回执结论按片段编号归并，双结论并存、待裁定
 *  - 放映许可的指纹（顺序 + 风险结论 + 盘数）与作废判定
 *  - 每盘 150 秒的装盘方案
 *  - 两个窗口并发保存时的三方字段差异（冲突字段清单）
 */
(function (global, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (global) global.DeskRules = api;
})(typeof self !== "undefined" ? self : globalThis, function () {
  "use strict";

  const PLATE_LIMIT_SECONDS = 150;
  const SHIFTS = ["正常", "偏红", "偏青", "偏黄", "褪色"];
  const DAMAGES = ["完好", "轻微划痕", "齿孔破损", "接片松动", "需跳过"];

  function uid() {
    if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
    return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
  }

  function clone(value) {
    return value === undefined ? value : JSON.parse(JSON.stringify(value));
  }

  function toSeconds(value) {
    const n = Number(value);
    return Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0;
  }

  /* ---------------- 状态骨架 ---------------- */

  function createEmptyState(reelTitle = "") {
    return { reelTitle, segments: [], receipts: [], permit: null };
  }

  function createDemoState() {
    let state = createEmptyState("春日试映A卷");
    state = addSegment(state, { code: "A-001", duration: 18, shift: "正常", damage: "完好", note: "开场街景，节奏平稳，适合保留原顺序。" });
    state = addSegment(state, { code: "A-006", duration: 9, shift: "偏红", damage: "轻微划痕", note: "人物近景左侧有划痕，试映时留意是否明显。" });
    state = addSegment(state, { code: "A-012", duration: 14, shift: "褪色", damage: "接片松动", note: "接片位置靠近段尾，放映前建议重新压平。" });
    // 模拟纸质外检单晚到：A-001 结论一致，A-006 外检结论与排片员不一致 -> 待裁定
    state = receiveReceipts(state, [
      { code: "A-001", duration: 18, shift: "正常", damage: "完好", receiptNo: "WJ-0401" },
      { code: "A-006", duration: 9, shift: "偏红", damage: "齿孔破损", receiptNo: "WJ-0401" }
    ]);
    return state;
  }

  /** 把旧版本（含 v1 核对台）或残缺数据补齐成当前结构 */
  function normalizeState(raw) {
    const state = createEmptyState();
    if (!raw || typeof raw !== "object") return state;
    state.reelTitle = String(raw.reelTitle || "");
    if (Array.isArray(raw.segments)) {
      state.segments = raw.segments.map((seg) => ({
        id: seg.id || uid(),
        code: String(seg.code || ""),
        duration: toSeconds(seg.duration),
        shift: SHIFTS.includes(seg.shift) ? seg.shift : "正常",
        damage: DAMAGES.includes(seg.damage) ? seg.damage : "完好",
        note: String(seg.note || ""),
        thumb: String(seg.thumb || ""),
        inspection: normalizeInspection(seg.inspection),
        ruling: seg.ruling === "scheduler" || seg.ruling === "inspection" ? seg.ruling : null
      }));
    }
    if (Array.isArray(raw.receipts)) {
      state.receipts = raw.receipts
        .map((r) => normalizeReceipt(r))
        .filter(Boolean);
    }
    state.permit = raw.permit && typeof raw.permit === "object" ? clone(raw.permit) : null;
    reconcileInspections(state);
    return state;
  }

  function migrateV1(v1) {
    let state = createEmptyState(v1 && v1.reelTitle);
    if (v1 && Array.isArray(v1.segments)) {
      v1.segments.forEach((seg) => {
        state = addSegment(state, {
          code: seg.code,
          duration: seg.duration,
          shift: seg.shift,
          damage: seg.damage,
          note: seg.note,
          thumb: seg.thumb
        });
      });
    }
    return state;
  }

  function normalizeInspection(value) {
    if (!value || typeof value !== "object") return null;
    return {
      duration: toSeconds(value.duration),
      shift: String(value.shift || ""),
      damage: String(value.damage || ""),
      receiptNo: String(value.receiptNo || ""),
      receivedAt: Number(value.receivedAt) || Date.now()
    };
  }

  function normalizeReceipt(value) {
    if (!value || typeof value !== "object" || !value.code) return null;
    return {
      id: value.id || uid(),
      code: String(value.code),
      duration: toSeconds(value.duration),
      shift: String(value.shift || ""),
      damage: String(value.damage || ""),
      receiptNo: String(value.receiptNo || ""),
      receivedAt: Number(value.receivedAt) || Date.now()
    };
  }

  /* ---------------- 双结论归并 ---------------- */

  function schedulerConclusion(seg) {
    return { duration: toSeconds(seg.duration), shift: seg.shift, damage: seg.damage };
  }

  function sameConclusion(a, b) {
    return !!a && !!b && toSeconds(a.duration) === toSeconds(b.duration) && a.shift === b.shift && a.damage === b.damage;
  }

  /**
   * 片段裁定状态：
   *  local    只有排片员结论
   *  agreed   外检与排片员一致
   *  pending  两种结论不一致，待裁定
   *  ruled    已经人工裁定
   */
  function statusOf(seg) {
    if (!seg.inspection) return "local";
    if (sameConclusion(seg.inspection, schedulerConclusion(seg))) return "agreed";
    if (seg.ruling === "scheduler" || seg.ruling === "inspection") return "ruled";
    return "pending";
  }

  /** 当前生效结论：待裁定时回退排片员值仅供预览，签放会被 canIssue 拦住 */
  function effectiveConclusion(seg) {
    const base = schedulerConclusion(seg);
    if (statusOf(seg) === "ruled" && seg.ruling === "inspection" && seg.inspection) {
      return { duration: toSeconds(seg.inspection.duration), shift: seg.inspection.shift, damage: seg.inspection.damage, source: "inspection" };
    }
    return { duration: base.duration, shift: base.shift, damage: base.damage, source: "scheduler" };
  }

  function findSegment(state, id) {
    return state.segments.find((seg) => seg.id === id) || null;
  }

  function findSegmentByCode(state, code) {
    return state.segments.find((seg) => seg.code === code) || null;
  }

  function latestReceiptFor(state, code) {
    const matches = state.receipts.filter((r) => r.code === code);
    return matches.length ? matches[matches.length - 1] : null;
  }

  /** 新增 / 修改片段后，按编号把晚到的外检回执重新挂上去 */
  function reconcileInspections(state) {
    state.segments.forEach((seg) => {
      if (!seg.inspection) {
        const latest = latestReceiptFor(state, seg.code);
        if (latest) seg.inspection = { duration: latest.duration, shift: latest.shift, damage: latest.damage, receiptNo: latest.receiptNo, receivedAt: latest.receivedAt };
      }
      if (seg.inspection && sameConclusion(seg.inspection, schedulerConclusion(seg))) seg.ruling = null;
    });
  }

  function addSegment(state, input) {
    const next = clone(state);
    const seg = {
      id: uid(),
      code: String(input.code || "").trim(),
      duration: toSeconds(input.duration),
      shift: SHIFTS.includes(input.shift) ? input.shift : "正常",
      damage: DAMAGES.includes(input.damage) ? input.damage : "完好",
      note: String(input.note || ""),
      thumb: String(input.thumb || ""),
      inspection: null,
      ruling: null
    };
    next.segments.push(seg);
    reconcileInspections(next);
    return next;
  }

  /**
   * 排片员修改片段。改时长 / 颜色 / 破损会与外检结论重新比对：
   * 改一致 -> agreed；改出差异 -> 重新待裁定。
   * 改编号会按新编号重新归并回执。
   */
  function updateSegment(state, id, patch) {
    const next = clone(state);
    const seg = findSegment(next, id);
    if (!seg) return next;
    if (patch.code !== undefined) seg.code = String(patch.code).trim();
    if (patch.duration !== undefined) seg.duration = toSeconds(patch.duration);
    if (patch.shift !== undefined && SHIFTS.includes(patch.shift)) seg.shift = patch.shift;
    if (patch.damage !== undefined && DAMAGES.includes(patch.damage)) seg.damage = patch.damage;
    if (patch.note !== undefined) seg.note = String(patch.note);
    if (patch.thumb !== undefined) seg.thumb = String(patch.thumb);

    if (patch.code !== undefined) seg.inspection = null;
    if (patch.code !== undefined || patch.duration !== undefined || patch.shift !== undefined || patch.damage !== undefined) {
      const latest = latestReceiptFor(next, seg.code);
      seg.inspection = latest
        ? { duration: latest.duration, shift: latest.shift, damage: latest.damage, receiptNo: latest.receiptNo, receivedAt: latest.receivedAt }
        : null;
      seg.ruling = null;
    }
    return next;
  }

  function removeSegment(state, id) {
    const next = clone(state);
    next.segments = next.segments.filter((seg) => seg.id !== id);
    return next;
  }

  function moveSegment(state, id, direction) {
    const next = clone(state);
    const from = next.segments.findIndex((seg) => seg.id === id);
    const to = from + direction;
    if (from < 0 || to < 0 || to >= next.segments.length) return next;
    const [item] = next.segments.splice(from, 1);
    next.segments.splice(to, 0, item);
    return next;
  }

  /** 拖拽落点：把 fromId 移动到 targetId 当前位置 */
  function reorderTo(state, fromId, targetId) {
    const next = clone(state);
    const from = next.segments.findIndex((seg) => seg.id === fromId);
    let to = next.segments.findIndex((seg) => seg.id === targetId);
    if (from < 0 || to < 0 || from === to) return next;
    const [item] = next.segments.splice(from, 1);
    to = next.segments.findIndex((seg) => seg.id === targetId);
    next.segments.splice(to, 0, item);
    return next;
  }

  function setReelTitle(state, title) {
    const next = clone(state);
    next.reelTitle = String(title || "");
    return next;
  }

  /* ---------------- 外检回执 ---------------- */

  function receiveReceipts(state, inputs) {
    const next = clone(state);
    inputs.forEach((input) => {
      const receipt = normalizeReceipt({ ...input, id: uid(), receivedAt: input.receivedAt || Date.now() });
      if (!receipt) return;
      next.receipts.push(receipt);
      const seg = findSegmentByCode(next, receipt.code);
      if (seg) {
        seg.inspection = {
          duration: receipt.duration,
          shift: receipt.shift,
          damage: receipt.damage,
          receiptNo: receipt.receiptNo,
          receivedAt: receipt.receivedAt
        };
        // 新一轮纸质回单到达，旧裁定失效，逼排片员重新核对
        seg.ruling = null;
      }
    });
    return next;
  }

  function adjudicate(state, id, choice) {
    if (choice !== "scheduler" && choice !== "inspection") return clone(state);
    const next = clone(state);
    const seg = findSegment(next, id);
    if (!seg || statusOf(seg) === "local" || statusOf(seg) === "agreed") return next;
    seg.ruling = choice;
    return next;
  }

  function pendingSegments(state) {
    return state.segments.filter((seg) => statusOf(seg) === "pending");
  }

  /** 外检回执里有、当前片段清单里找不到编号的单子 */
  function unmatchedReceipts(state) {
    const codes = new Set(state.segments.map((seg) => seg.code));
    const latest = new Map();
    state.receipts.forEach((r) => latest.set(r.code, r));
    return [...latest.values()].filter((r) => !codes.has(r.code));
  }

  /**
   * 解析批量录入文本。每行：
   *   片段编号,时长,颜色偏移,破损结论[,回执单号]
   * 返回 { items, errors }
   */
  function parseReceiptBatch(text) {
    const items = [];
    const errors = [];
    String(text || "")
      .split(/\r?\n/)
      .forEach((line, index) => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) return;
        const fields = trimmed.split(/\s*[|｜,，;；\t]+\s*/);
        if (fields.length < 4 || fields.length > 5) {
          errors.push(`第 ${index + 1} 行字段数不对（需 4~5 列）：${trimmed}`);
          return;
        }
        const [code, durationText, shift, damage, receiptNo] = fields;
        const duration = Number(durationText);
        if (!code.trim()) errors.push(`第 ${index + 1} 行缺少片段编号`);
        else if (!Number.isFinite(duration) || duration <= 0) errors.push(`第 ${index + 1} 行时长无效：${durationText}`);
        else if (!SHIFTS.includes(shift)) errors.push(`第 ${index + 1} 行颜色偏移不在选项内：${shift}`);
        else if (!DAMAGES.includes(damage)) errors.push(`第 ${index + 1} 行破损结论不在选项内：${damage}`);
        else items.push({ code: code.trim(), duration: Math.round(duration), shift, damage, receiptNo: (receiptNo || "").trim() });
      });
    return { items, errors };
  }

  /* ---------------- 装盘（每盘 150 秒） ---------------- */

  /**
   * 按当前顺序贪心装盘：单盘不超过 150 秒。
   * 单片本身超过 150 秒时独占一盘并标 overflow（物理上不能拆段）。
   */
  function packPlates(segments) {
    const plates = [];
    let current = null;
    segments.forEach((seg) => {
      const eff = effectiveConclusion(seg);
      const item = {
        id: seg.id,
        code: seg.code,
        duration: eff.duration,
        shift: eff.shift,
        damage: eff.damage,
        source: eff.source,
        pending: statusOf(seg) === "pending"
      };
      if (item.duration > PLATE_LIMIT_SECONDS) {
        plates.push({ segments: [item], total: item.duration, overflow: true });
        current = null;
        return;
      }
      if (current && current.total + item.duration <= PLATE_LIMIT_SECONDS) {
        current.segments.push(item);
        current.total += item.duration;
      } else {
        current = { segments: [item], total: item.duration, overflow: false };
        plates.push(current);
      }
    });
    return plates;
  }

  /* ---------------- 放映许可 ---------------- */

  function canIssue(state) {
    const reasons = [];
    if (!state.segments.length) reasons.push("还没有任何片段，无法签放。");
    const pending = pendingSegments(state);
    if (pending.length) reasons.push(`有 ${pending.length} 个片段外检结论待裁定：${pending.map((s) => s.code).join("、")}。`);
    const unmatched = unmatchedReceipts(state);
    if (unmatched.length) reasons.push(`有 ${unmatched.length} 张外检回执找不到对应片段：${unmatched.map((r) => r.code).join("、")}。`);
    return { ok: reasons.length === 0, reasons };
  }

  function permitId(now) {
    const d = new Date(now);
    const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
    const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
    return `FX-${ymd}-${rand}`;
  }

  /** 没裁定前不能生成放映许可；许可绑定当时的顺序、风险结论与盘数 */
  function issuePermit(state, now = Date.now()) {
    const check = canIssue(state);
    if (!check.ok) return { ok: false, reasons: check.reasons };
    const plates = packPlates(state.segments);
    const permit = {
      id: permitId(now),
      issuedAt: now,
      limitSeconds: PLATE_LIMIT_SECONDS,
      order: state.segments.map((seg) => seg.id),
      snapshot: state.segments.map((seg) => {
        const eff = effectiveConclusion(seg);
        return { id: seg.id, code: seg.code, duration: eff.duration, shift: eff.shift, damage: eff.damage, source: eff.source };
      }),
      plates: plates.map((plate) => ({
        total: plate.total,
        overflow: plate.overflow,
        segments: plate.segments.map((item) => ({ id: item.id, code: item.code, duration: item.duration, shift: item.shift, damage: item.damage }))
      })),
      plateCount: plates.length
    };
    const next = clone(state);
    next.permit = permit;
    return { ok: true, state: next, permit };
  }

  function sameIdOrder(a, b) {
    return a.length === b.length && a.every((id, index) => id === b[index]);
  }

  /**
   * 评估已签发许可：
   *  valid     指纹一致，许可有效
   *  suspended 指纹一致，但出现待裁定外检结论，暂缓放行
   *  void      顺序 / 时长 / 颜色 / 破损 / 盘数变化，立即作废
   */
  function evaluatePermit(state) {
    const permit = state.permit;
    if (!permit) return null;
    const reasons = [];
    const currentIds = state.segments.map((seg) => seg.id);
    if (!sameIdOrder(permit.order, currentIds)) {
      reasons.push({ code: "order", message: "片段顺序已变化" });
    }

    const currentById = new Map(state.segments.map((seg) => [seg.id, seg]));
    const snapById = new Map(permit.snapshot.map((item) => [item.id, item]));

    permit.snapshot.forEach((item) => {
      const seg = currentById.get(item.id);
      if (!seg) {
        reasons.push({ code: "removed", message: `片段 ${item.code} 已删除` });
        return;
      }
      const eff = effectiveConclusion(seg);
      const label = `片段 ${item.code}`;
      if (eff.duration !== toSeconds(item.duration)) reasons.push({ code: "duration", message: `${label} 时长变化（${toSeconds(item.duration)}s → ${eff.duration}s）` });
      if (eff.shift !== item.shift) reasons.push({ code: "shift", message: `${label} 颜色偏移变化（${item.shift} → ${eff.shift}）` });
      if (eff.damage !== item.damage) reasons.push({ code: "damage", message: `${label} 破损结论变化（${item.damage} → ${eff.damage}）` });
    });
    state.segments.forEach((seg) => {
      if (!snapById.has(seg.id)) reasons.push({ code: "added", message: `新增片段 ${seg.code}，不在许可范围内` });
    });

    const plateCount = packPlates(state.segments).length;
    if (plateCount !== permit.plateCount) {
      reasons.push({ code: "plates", message: `装盘盘数变化（${permit.plateCount} 盘 → ${plateCount} 盘）` });
    }

    const pending = pendingSegments(state);
    const suspended = pending.map((seg) => ({ code: "pending", message: `片段 ${seg.code} 外检结论待裁定，暂缓放行` }));

    if (reasons.length) return { status: "void", reasons, suspended: [] };
    if (suspended.length) return { status: "suspended", reasons: [], suspended };
    return { status: "valid", reasons: [], suspended: [] };
  }

  /* ---------------- 并发保存的三方差异 ---------------- */

  const SEGMENT_FIELDS = [
    ["code", "片段编号"],
    ["duration", "时长"],
    ["shift", "颜色偏移"],
    ["damage", "破损结论"],
    ["note", "备注"],
    ["thumb", "缩略图"]
  ];

  function receiptsSignature(state) {
    return (state.receipts || [])
      .map((r) => `${r.code}:${r.duration}:${r.shift}:${r.damage}:${r.receiptNo}`)
      .sort()
      .join("|");
  }

  function permitSignature(state) {
    if (!state.permit) return "";
    return JSON.stringify({
      order: state.permit.order,
      snapshot: state.permit.snapshot,
      plateCount: state.permit.plateCount
    });
  }

  function displayValue(path, value) {
    if (value === undefined) return "（无）";
    if (path.endsWith("thumb")) return value ? "已设置缩略图" : "未设置缩略图";
    if (path.endsWith("duration")) return `${toSeconds(value)} 秒`;
    if (value === null) return "（无）";
    if (typeof value === "object") return JSON.stringify(value);
    return String(value);
  }

  /**
   * 三方对比：base 为共同祖先（本窗口加载时的版本），
   * local 为本窗口待存数据，remote 为另一窗口已写入的新版本。
   * 返回 entries（每条标注本端/对端是否改过）与 conflicts（双方都改）。
   */
  function diffStates(base, local, remote) {
    const b = base || createEmptyState();
    const l = local || createEmptyState();
    const r = remote || createEmptyState();
    const entries = [];

    function push(path, label, bv, lv, rv) {
      const localChanged = JSON.stringify(bv) !== JSON.stringify(lv);
      const remoteChanged = JSON.stringify(bv) !== JSON.stringify(rv);
      if (!localChanged && !remoteChanged) return;
      entries.push({
        path,
        label,
        localChanged,
        remoteChanged,
        base: displayValue(path, bv),
        local: displayValue(path, lv),
        remote: displayValue(path, rv)
      });
    }

    push("reelTitle", "胶片卷名称", b.reelTitle, l.reelTitle, r.reelTitle);

    const orderB = b.segments.map((s) => s.id);
    const orderL = l.segments.map((s) => s.id);
    const orderR = r.segments.map((s) => s.id);
    push("segments.order", "片段顺序", orderB, orderL, orderR);

    const ids = new Set([...b.segments, ...l.segments, ...r.segments].map((s) => s.id));
    const bMap = new Map(b.segments.map((s) => [s.id, s]));
    const lMap = new Map(l.segments.map((s) => [s.id, s]));
    const rMap = new Map(r.segments.map((s) => [s.id, s]));

    ids.forEach((id) => {
      const sb = bMap.get(id);
      const sl = lMap.get(id);
      const sr = rMap.get(id);
      const code = (sl || sr || sb).code;
      if (!sb && sl && !sr) push(`segment:${id}:added`, `片段 ${code}（本窗口新增）`, undefined, true, undefined);
      else if (!sb && !sl && sr) push(`segment:${id}:added`, `片段 ${code}（另一窗口新增）`, undefined, undefined, true);
      else if (sb && !sl && sr) push(`segment:${id}:removed`, `片段 ${code}（本窗口删除）`, true, undefined, true);
      else if (sb && sl && !sr) push(`segment:${id}:removed`, `片段 ${code}（另一窗口删除）`, true, true, undefined);
      if (!sl || !sr) return;
      SEGMENT_FIELDS.forEach(([field, label]) => {
        push(`segment:${id}:${field}`, `${code} ${label}`, sb ? sb[field] : undefined, sl[field], sr[field]);
      });
      const ib = sb ? sb.inspection : null;
      push(`segment:${id}:inspection`, `${code} 外检结论`, ib, sl.inspection, sr.inspection);
      const rb0 = sb ? sb.ruling : null;
      push(`segment:${id}:ruling`, `${code} 裁定选择`, rb0, sl.ruling, sr.ruling);
    });

    push("receipts", "外检回执清单", receiptsSignature(b), receiptsSignature(l), receiptsSignature(r));
    push("permit", "放映许可", permitSignature(b), permitSignature(l), permitSignature(r));

    const conflicts = entries.filter((e) => e.localChanged && e.remoteChanged);
    const localOnly = entries.filter((e) => e.localChanged && !e.remoteChanged);
    const remoteOnly = entries.filter((e) => !e.localChanged && e.remoteChanged);
    return { entries, conflicts, localOnly, remoteOnly };
  }

  return {
    PLATE_LIMIT_SECONDS,
    SHIFTS,
    DAMAGES,
    uid,
    createEmptyState,
    createDemoState,
    normalizeState,
    migrateV1,
    statusOf,
    schedulerConclusion,
    effectiveConclusion,
    addSegment,
    updateSegment,
    removeSegment,
    moveSegment,
    reorderTo,
    setReelTitle,
    receiveReceipts,
    adjudicate,
    pendingSegments,
    unmatchedReceipts,
    parseReceiptBatch,
    packPlates,
    canIssue,
    issuePermit,
    evaluatePermit,
    diffStates
  };
});
