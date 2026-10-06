/*
 * rules.js — 规则判定层
 *
 * 所有与持久化、页面无关的业务规则都集中在这里：
 *  - 外检回执解析与按片段编号归并
 *  - 待裁定判定
 *  - 每盘 150 秒排盘
 *  - 放映许可绑定 / 作废
 *  - 装盘方案作废
 *  - 两窗口字段级冲突检测
 *
 * 维护规则时只改这一层，页面与持久化不参与判断。
 */
(function (global) {
  "use strict";

  var SECONDS_PER_REEL = 150;

  var SHIFTS = ["正常", "偏红", "偏青", "偏黄", "褪色"];
  var DAMAGES = ["完好", "轻微划痕", "齿孔破损", "接片松动", "需跳过"];

  /* ---------- 外检回执解析 ---------- */

  // 从一段文本里解析出外检结论。每行一条，形如：
  //   A-001 时长 20 偏红 轻微划痕
  //   A-006,9,正常,完好
  // 字段顺序随意，缺项保留 null（归并时沿用排片员结论）。
  function parseReceiptText(text) {
    var lines = String(text || "").split(/\r?\n/);
    var items = [];
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (!line) continue;
      if (/^(#|\/\/|编号|片段编号|code)/i.test(line)) continue;

      var codeMatch = line.match(/[A-Za-z]-\d+/);
      if (!codeMatch) continue;
      var code = codeMatch[0].toUpperCase();
      var rest = line.slice(codeMatch.index + codeMatch[0].length);

      var numMatch = rest.match(/\d+/);
      var duration = numMatch ? Number(numMatch[0]) : null;

      var shift = null;
      for (var s = 0; s < SHIFTS.length; s++) {
        if (rest.indexOf(SHIFTS[s]) !== -1) { shift = SHIFTS[s]; break; }
      }
      var damage = null;
      for (var d = 0; d < DAMAGES.length; d++) {
        if (rest.indexOf(DAMAGES[d]) !== -1) { damage = DAMAGES[d]; break; }
      }

      items.push({ code: code, duration: duration, shift: shift, damage: damage });
    }
    return items;
  }

  /* ---------- 外检回执归并 ---------- */

  // 按片段编号把外检结论归并到片段上。
  // 同一片段两种结论都留下：排片员结论是片段本身的 duration/shift/damage，
  // 外检结论写入 segment.receipt；两者不一致时 receiptStatus = "pending"（待裁定），
  // 一致时为 "confirmed"。外检不认识的编号放进 unmatched。
  // 返回 { pending, unmatched }。
  function mergeReceipts(segments, items) {
    var pending = [];
    var unmatched = [];
    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      var seg = null;
      for (var j = 0; j < segments.length; j++) {
        if (segments[j].code === item.code) { seg = segments[j]; break; }
      }
      if (!seg) { unmatched.push(item); continue; }

      var receipt = {
        duration: item.duration != null ? item.duration : seg.duration,
        shift: item.shift || seg.shift,
        damage: item.damage || seg.damage
      };
      seg.receipt = receipt;

      var differs =
        Number(receipt.duration) !== Number(seg.duration) ||
        receipt.shift !== seg.shift ||
        receipt.damage !== seg.damage;

      if (differs) {
        seg.receiptStatus = "pending";
        pending.push(seg);
      } else {
        seg.receiptStatus = "confirmed";
      }
    }
    return { pending: pending, unmatched: unmatched };
  }

  function hasPendingReceipts(segments) {
    for (var i = 0; i < segments.length; i++) {
      if (segments[i].receiptStatus === "pending") return true;
    }
    return false;
  }

  // 裁定：choice = "scheduler" 保留排片员结论；"receipt" 采用外检结论。
  function confirmReceipt(segments, segmentId, choice) {
    for (var i = 0; i < segments.length; i++) {
      var seg = segments[i];
      if (seg.id !== segmentId) continue;
      if (choice === "receipt" && seg.receipt) {
        seg.duration = seg.receipt.duration;
        seg.shift = seg.receipt.shift;
        seg.damage = seg.receipt.damage;
      }
      seg.receiptStatus = "confirmed";
      return true;
    }
    return false;
  }

  /* ---------- 排盘 ---------- */

  // 按每盘 150 秒贪心排盘：相邻片段依次装盘，放不下就新开一盘。
  // 每段片段完整放入一盘，不跨盘拆分。
  function planReels(segments, secondsPerReel) {
    secondsPerReel = secondsPerReel || SECONDS_PER_REEL;
    var reels = [];
    var current = { segments: [], duration: 0 };
    for (var i = 0; i < segments.length; i++) {
      var seg = segments[i];
      var d = Number(seg.duration) || 0;
      if (current.segments.length > 0 && current.duration + d > secondsPerReel) {
        reels.push(current);
        current = { segments: [], duration: 0 };
      }
      current.segments.push(seg.id);
      current.duration += d;
    }
    if (current.segments.length > 0) reels.push(current);
    return { secondsPerReel: secondsPerReel, reels: reels };
  }

  /* ---------- 快照 ---------- */

  function buildSnapshot(segments, reelCount, secondsPerReel) {
    var durations = {};
    var shifts = {};
    var damages = {};
    for (var i = 0; i < segments.length; i++) {
      var s = segments[i];
      durations[s.id] = Number(s.duration) || 0;
      shifts[s.id] = s.shift;
      damages[s.id] = s.damage;
    }
    return {
      order: segments.map(function (s) { return s.id; }),
      durations: durations,
      shifts: shifts,
      damages: damages,
      reelCount: reelCount,
      secondsPerReel: secondsPerReel
    };
  }

  // 列出当前片段相对快照发生的变化（顺序 / 时长 / 颜色偏移 / 破损）。
  function voidReasons(snapshot, segments) {
    var reasons = [];
    var currentOrder = segments.map(function (s) { return s.id; });
    var orderChanged = currentOrder.length !== snapshot.order.length ||
      currentOrder.some(function (id, i) { return id !== snapshot.order[i]; });
    if (orderChanged) reasons.push("片段顺序发生变化");

    for (var i = 0; i < segments.length; i++) {
      var seg = segments[i];
      var idx = snapshot.order.indexOf(seg.id);
      if (idx === -1) {
        reasons.push("片段 " + seg.code + " 已加入");
        continue;
      }
      if (Number(seg.duration) !== Number(snapshot.durations[seg.id])) {
        reasons.push("片段 " + seg.code + " 时长变化：" +
          snapshot.durations[seg.id] + " → " + seg.duration);
      }
      if (seg.shift !== snapshot.shifts[seg.id]) {
        reasons.push("片段 " + seg.code + " 颜色偏移变化：" +
          snapshot.shifts[seg.id] + " → " + seg.shift);
      }
      if (seg.damage !== snapshot.damages[seg.id]) {
        reasons.push("片段 " + seg.code + " 破损结论变化：" +
          snapshot.damages[seg.id] + " → " + seg.damage);
      }
    }
    for (var j = 0; j < snapshot.order.length; j++) {
      var id = snapshot.order[j];
      if (!segments.some(function (s) { return s.id === id; })) {
        reasons.push("片段 " + id + " 已移除");
      }
    }
    return reasons;
  }

  /* ---------- 放映许可 ---------- */

  // 生成放映许可。存在未裁定的外检回执时拒绝生成。
  function issuePermit(segments, secondsPerReel) {
    secondsPerReel = secondsPerReel || SECONDS_PER_REEL;
    if (hasPendingReceipts(segments)) {
      return { ok: false, reason: "pending-receipts" };
    }
    var plan = planReels(segments, secondsPerReel);
    var snapshot = buildSnapshot(segments, plan.reels.length, secondsPerReel);
    return {
      ok: true,
      permit: {
        id: uid(),
        issuedAt: new Date().toISOString(),
        snapshot: snapshot,
        status: "valid",
        voidReason: null
      }
    };
  }

  // 许可绑定当时的片段顺序、风险结论和盘数；
  // 顺序、时长、颜色偏移或破损任一变化，许可立即作废。
  function refreshPermit(permit, segments) {
    if (!permit || permit.status === "void") return permit;
    var reasons = voidReasons(permit.snapshot, segments);
    if (reasons.length > 0) {
      return Object.assign({}, permit, {
        status: "void",
        voidReason: reasons.join("；")
      });
    }
    return permit;
  }

  /* ---------- 装盘方案 ---------- */

  function refreshReelPlan(plan, segments) {
    if (!plan || plan.status === "void") return plan;
    var reasons = voidReasons(plan.snapshot, segments);
    if (reasons.length > 0) {
      return Object.assign({}, plan, {
        status: "void",
        voidReason: reasons.join("；")
      });
    }
    return plan;
  }

  /* ---------- 两窗口字段级冲突检测 ---------- */

  // 比较本地保存的状态与存储里的新版本，逐字段列出冲突。
  function detectConflicts(local, remote) {
    var fields = [];
    if ((local.reelTitle || "") !== (remote.reelTitle || "")) {
      fields.push({
        type: "reelTitle",
        label: "胶片卷名称",
        local: local.reelTitle,
        remote: remote.reelTitle
      });
    }

    var lMap = {};
    var rMap = {};
    var i;
    for (i = 0; i < local.segments.length; i++) lMap[local.segments[i].id] = local.segments[i];
    for (i = 0; i < remote.segments.length; i++) rMap[remote.segments[i].id] = remote.segments[i];

    var allIds = {};
    for (var id in lMap) allIds[id] = true;
    for (id in rMap) allIds[id] = true;

    for (id in allIds) {
      var l = lMap[id];
      var r = rMap[id];
      if (l && !r) {
        fields.push({
          type: "removed",
          segmentId: id,
          code: l.code,
          label: "片段 " + l.code + " 被删除",
          local: l.code,
          remote: "—"
        });
        continue;
      }
      if (!l && r) {
        fields.push({
          type: "added",
          segmentId: id,
          code: r.code,
          label: "新增片段 " + r.code,
          local: "—",
          remote: r.code
        });
        continue;
      }
      var segFields = [
        ["code", "编号"],
        ["duration", "时长"],
        ["shift", "颜色偏移"],
        ["damage", "破损"],
        ["note", "备注"]
      ];
      for (var f = 0; f < segFields.length; f++) {
        var key = segFields[f][0];
        var label = segFields[f][1];
        if (String(l[key] == null ? "" : l[key]) !== String(r[key] == null ? "" : r[key])) {
          fields.push({
            type: "field",
            segmentId: id,
            code: l.code,
            field: key,
            label: "片段 " + l.code + " " + label,
            local: l[key],
            remote: r[key]
          });
        }
      }
      var li = local.segments.findIndex(function (s) { return s.id === id; });
      var ri = remote.segments.findIndex(function (s) { return s.id === id; });
      if (li !== ri) {
        fields.push({
          type: "order",
          segmentId: id,
          code: l.code,
          label: "片段 " + l.code + " 顺序",
          local: li + 1,
          remote: ri + 1
        });
      }
    }
    return fields;
  }

  /* ---------- 工具 ---------- */

  function uid() {
    if (global.crypto && global.crypto.randomUUID) return global.crypto.randomUUID();
    return "id-" + Date.now() + "-" + Math.random().toString(16).slice(2);
  }

  global.Rules = {
    SECONDS_PER_REEL: SECONDS_PER_REEL,
    SHIFTS: SHIFTS,
    DAMAGES: DAMAGES,
    parseReceiptText: parseReceiptText,
    mergeReceipts: mergeReceipts,
    hasPendingReceipts: hasPendingReceipts,
    confirmReceipt: confirmReceipt,
    planReels: planReels,
    buildSnapshot: buildSnapshot,
    voidReasons: voidReasons,
    issuePermit: issuePermit,
    refreshPermit: refreshPermit,
    refreshReelPlan: refreshReelPlan,
    detectConflicts: detectConflicts
  };
})(window);
