/*
 * ui.js — 页面渲染层
 *
 * 只负责把状态画成 DOM，不写业务规则、不直接读写 localStorage。
 * 每个页面一个 render 函数：renderSegments / renderReceipts /
 * renderReels / renderPermits / renderBatches。
 * 状态变更通过 app.js 传入的 actions 触发。
 */
(function (global) {
  "use strict";

  var Rules = global.Rules;

  /* ---------- 工具 ---------- */

  function esc(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function formatDuration(seconds) {
    var value = Number(seconds) || 0;
    var minutes = Math.floor(value / 60);
    var rest = String(value % 60).padStart(2, "0");
    return minutes + ":" + rest;
  }

  function formatTime(iso) {
    if (!iso) return "";
    var d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    var p = function (n) { return String(n).padStart(2, "0"); };
    return p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " +
      p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
  }

  function shiftTagClass(shift) {
    return shift === "正常" ? "ok" : "warn";
  }

  function damageTagClass(damage) {
    return damage === "完好" ? "ok" : "damage";
  }

  /* ---------- 片段页 ---------- */

  function renderSegments(container, state, actions) {
    var segments = state.segments;
    var html =
      '<div class="layout">' +
      '<aside class="panel">' +
      '<h2>录入片段</h2>' +
      '<form id="segmentForm" class="segment-form">' +
      '<label>片段编号<input id="codeInput" required placeholder="A-014" /></label>' +
      '<label>时长秒数<input id="durationInput" required type="number" min="1" value="12" /></label>' +
      '<label>颜色偏移<select id="shiftInput">' +
      options(Rules.SHIFTS, "正常") +
      '</select></label>' +
      '<label>破损情况<select id="damageInput">' +
      options(Rules.DAMAGES, "完好") +
      '</select></label>' +
      '<label>缩略图<input id="thumbInput" type="file" accept="image/*" /></label>' +
      '<label>备注<textarea id="noteInput" rows="3" placeholder="试映前要留意的画面、接片或声音点"></textarea></label>' +
      '<button class="primary" type="submit">加入放映清单</button>' +
      '</form>' +
      '</aside>' +
      '<section class="panel list-panel">' +
      '<div class="panel-head"><h2>放映顺序</h2><span>拖拽或按钮调整顺序，改动后许可与装盘立即作废</span></div>' +
      '<div id="segmentList" class="segment-list">' +
      segments.map(function (item, index) {
        return segmentCard(item, index, segments.length);
      }).join("") +
      '</div>' +
      '</section>' +
      '<aside class="panel warning-panel">' +
      '<h2>试映前核对</h2>' +
      '<div class="warning-list">' +
      warningsHtml(segments) +
      '</div>' +
      '</aside>' +
      '</div>';

    container.innerHTML = html;

    var form = container.querySelector("#segmentForm");
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var fileInput = container.querySelector("#thumbInput");
      var file = fileInput && fileInput.files[0];
      var done = function (thumb) {
        actions.addSegment({
          code: container.querySelector("#codeInput").value.trim(),
          duration: Number(container.querySelector("#durationInput").value),
          shift: container.querySelector("#shiftInput").value,
          damage: container.querySelector("#damageInput").value,
          note: container.querySelector("#noteInput").value.trim(),
          thumb: thumb || ""
        });
        form.reset();
        container.querySelector("#durationInput").value = 12;
      };
      if (file) {
        var reader = new FileReader();
        reader.onload = function () { done(reader.result); };
        reader.onerror = function () { done(""); };
        reader.readAsDataURL(file);
      } else {
        done("");
      }
    });

    var list = container.querySelector("#segmentList");
    list.addEventListener("click", function (event) {
      var up = event.target.closest("[data-move-up]");
      var down = event.target.closest("[data-move-down]");
      var remove = event.target.closest("[data-delete]");
      var confirmBtn = event.target.closest("[data-confirm-receipt]");
      if (up) actions.moveSegment(up.dataset.moveUp, -1);
      if (down) actions.moveSegment(down.dataset.moveDown, 1);
      if (remove) actions.deleteSegment(remove.dataset.delete);
      if (confirmBtn) actions.navigate("receipts");
    });

    // 排片员直接改时长 / 颜色 / 破损
    list.addEventListener("change", function (event) {
      var field = event.target.dataset.field;
      if (!field) return;
      var id = event.target.dataset.id;
      var value = event.target.value;
      if (field === "duration") value = Number(value);
      actions.updateSegment(id, field, value);
    });

    // 拖拽排序
    var draggedId = null;
    list.addEventListener("dragstart", function (event) {
      var card = event.target.closest("[data-id]");
      if (!card) return;
      draggedId = card.dataset.id;
      card.classList.add("dragging");
      event.dataTransfer.effectAllowed = "move";
    });
    list.addEventListener("dragend", function (event) {
      var card = event.target.closest("[data-id]");
      if (card) card.classList.remove("dragging");
      draggedId = null;
    });
    list.addEventListener("dragover", function (event) {
      var card = event.target.closest("[data-id]");
      if (!card || !draggedId || card.dataset.id === draggedId) return;
      event.preventDefault();
      var fromIndex = segments.findIndex(function (s) { return s.id === draggedId; });
      var toIndex = segments.findIndex(function (s) { return s.id === card.dataset.id; });
      if (fromIndex < 0 || toIndex < 0) return;
      actions.reorderSegments(fromIndex, toIndex);
      draggedId = null;
    });
  }

  function options(list, selected) {
    return list.map(function (item) {
      return '<option value="' + esc(item) + '"' + (item === selected ? " selected" : "") + ">" + esc(item) + "</option>";
    }).join("");
  }

  function segmentCard(item, index, total) {
    var hasDamage = item.damage !== "完好";
    var pending = item.receiptStatus === "pending";
    var confirmed = item.receiptStatus === "confirmed";
    var thumbColor = ["#d49b35", "#347d89", "#b54d48", "#4d7656", "#6d6378"][index % 5];
    return (
      '<article class="segment-card' + (pending ? " pending" : "") + '" draggable="true" data-id="' + esc(item.id) + '">' +
      '<div class="thumb">' +
      (item.thumb
        ? '<img src="' + item.thumb + '" alt="" />'
        : '<div class="film-placeholder" style="background:' + thumbColor + '">' + esc(item.code) + "</div>") +
      "</div>" +
      '<div class="segment-main">' +
      '<div class="segment-title">' +
      "<strong>" + (index + 1) + ". " + esc(item.code) + "</strong>" +
      (pending ? '<span class="badge pending">待裁定</span>' : "") +
      (confirmed ? '<span class="badge confirmed">外检已裁定</span>' : "") +
      "</div>" +
      '<div class="tag-row">' +
      '<label class="inline-field">时长 <input type="number" min="1" data-field="duration" data-id="' + esc(item.id) + '" value="' + esc(item.duration) + '" /></label>' +
      '<label class="inline-field">颜色 <select data-field="shift" data-id="' + esc(item.id) + '">' + options(Rules.SHIFTS, item.shift) + "</select></label>" +
      '<label class="inline-field">破损 <select data-field="damage" data-id="' + esc(item.id) + '">' + options(Rules.DAMAGES, item.damage) + "</select></label>" +
      "</div>" +
      (pending
        ? '<div class="pending-note">外检回执与排片员结论不一致，<button type="button" data-confirm-receipt="' + esc(item.id) + '">去回执页裁定</button></div>'
        : "") +
      '<p class="segment-note">' + esc(item.note || "没有备注。") + "</p>" +
      "</div>" +
      '<div class="segment-actions">' +
      '<button type="button" title="上移" data-move-up="' + esc(item.id) + '"' + (index === 0 ? " disabled" : "") + ">↑</button>" +
      '<button type="button" title="下移" data-move-down="' + esc(item.id) + '"' + (index === total - 1 ? " disabled" : "") + ">↓</button>" +
      '<button type="button" title="删除" data-delete="' + esc(item.id) + '">×</button>' +
      "</div>" +
      "</article>"
    );
  }

  function warningsHtml(segments) {
    var warnings = segments.filter(function (item) {
      return item.damage !== "完好" || item.shift !== "正常";
    });
    if (!warnings.length) return '<p class="empty">当前清单没有颜色偏移或破损提醒。</p>';
    return warnings.map(function (item) {
      var index = segments.findIndex(function (s) { return s.id === item.id; }) + 1;
      var reasons = [item.shift !== "正常" ? item.shift : "", item.damage !== "完好" ? item.damage : ""].filter(Boolean).join(" · ");
      return '<div class="warning-item"><strong>' + index + ". " + esc(item.code) + "</strong>" +
        "<span>" + esc(reasons) + (item.note ? "：" + esc(item.note) : "") + "</span></div>";
    }).join("");
  }

  /* ---------- 回执页 ---------- */

  function renderReceipts(container, state, actions) {
    var pending = state.segments.filter(function (s) { return s.receiptStatus === "pending"; });
    var confirmed = state.segments.filter(function (s) { return s.receiptStatus === "confirmed"; });

    var html =
      '<div class="page-grid">' +
      '<section class="panel">' +
      '<h2>粘贴外检回执</h2>' +
      '<p class="hint">纸质外检单回单晚到时，把回执内容贴进来按片段编号归并。同一片段两种结论都保留，标为待裁定，不会盖掉排片员刚改的内容。</p>' +
      '<textarea id="receiptInput" rows="10" placeholder="A-001 时长 20 偏红 轻微划痕&#10;A-006 时长 9 正常 完好"></textarea>' +
      '<div class="btn-row"><button class="primary" id="mergeReceiptBtn">归并到片段</button>' +
      '<button id="loadSampleBtn">填入示例回执</button></div>' +
      '<div id="mergeResult" class="merge-result"></div>' +
      '</section>' +
      '<section class="panel">' +
      '<h2>待裁定（' + pending.length + '）</h2>' +
      (pending.length === 0
        ? '<p class="empty">没有待裁定片段。外检结论与排片员结论一致时会自动标记为已裁定。</p>'
        : pending.map(function (seg) {
            return pendingCard(seg);
          }).join("")) +
      "</section>" +
      "</div>" +
      '<section class="panel" style="margin-top:16px">' +
      '<h2>已裁定（' + confirmed.length + '）</h2>' +
      (confirmed.length === 0
        ? '<p class="empty">还没有已裁定的外检结论。</p>'
        : '<div class="confirmed-list">' + confirmed.map(function (seg) {
            return '<div class="confirmed-row"><strong>' + esc(seg.code) + '</strong>' +
              "<span>" + esc(seg.duration) + " 秒 · " + esc(seg.shift) + " · " + esc(seg.damage) + "</span></div>";
          }).join("") + "</div>") +
      "</section>";

    container.innerHTML = html;

    container.querySelector("#mergeReceiptBtn").addEventListener("click", function () {
      var text = container.querySelector("#receiptInput").value;
      var result = actions.importReceipts(text);
      var box = container.querySelector("#mergeResult");
      var msg = "归并完成：" + result.pending.length + " 个片段待裁定，" +
        result.unmatched.length + " 个编号未匹配。";
      box.innerHTML = '<div class="' + (result.pending.length ? "warn" : "ok") + '">' + msg + "</div>";
      if (result.unmatched.length) {
        box.innerHTML += '<div class="unmatched">未匹配编号：' +
          result.unmatched.map(function (u) { return esc(u.code); }).join("、") + "</div>";
      }
    });

    container.querySelector("#loadSampleBtn").addEventListener("click", function () {
      container.querySelector("#receiptInput").value =
        "A-001 时长 20 偏红 轻微划痕\nA-006 时长 9 正常 完好\nA-012 时长 14 褪色 齿孔破损";
    });

    container.addEventListener("click", function (event) {
      var btn = event.target.closest("[data-adjudicate]");
      if (!btn) return;
      actions.confirmReceipt(btn.dataset.adjudicate, btn.dataset.choice);
    });
  }

  function pendingCard(seg) {
    return (
      '<div class="pending-card">' +
      '<div class="pending-head"><strong>' + esc(seg.code) + "</strong>" +
      '<span class="badge pending">待裁定</span></div>' +
      '<div class="compare-grid">' +
      '<div class="compare-col">' +
      '<h4>排片员结论</h4>' +
      "<div>时长：" + esc(seg.duration) + " 秒</div>" +
      "<div>颜色：" + esc(seg.shift) + "</div>" +
      "<div>破损：" + esc(seg.damage) + "</div>" +
      '<button data-adjudicate="' + esc(seg.id) + '" data-choice="scheduler">采用排片员结论</button>' +
      "</div>" +
      '<div class="compare-col receipt">' +
      '<h4>外检回执结论</h4>' +
      "<div>时长：" + esc(seg.receipt.duration) + " 秒</div>" +
      "<div>颜色：" + esc(seg.receipt.shift) + "</div>" +
      "<div>破损：" + esc(seg.receipt.damage) + "</div>" +
      '<button class="primary" data-adjudicate="' + esc(seg.id) + '" data-choice="receipt">采用外检结论</button>' +
      "</div>" +
      "</div>" +
      "</div>"
    );
  }

  /* ---------- 装盘页 ---------- */

  function renderReels(container, state, actions) {
    var plan = state.reelPlan;
    var fresh = plan && plan.status !== "void";
    var html =
      '<section class="panel">' +
      '<div class="panel-head"><h2>装盘方案（每盘 ' + Rules.SECONDS_PER_REEL + ' 秒）</h2>' +
      '<div class="btn-row">' +
      '<button class="primary" id="replanBtn">' + (plan ? "重新排盘" : "生成装盘方案") + "</button>" +
      "</div></div>" +
      '<p class="hint">按每盘 ' + Rules.SECONDS_PER_REEL + ' 秒贪心排盘。顺序、时长、颜色偏移或破损任一变化，装盘方案立即作废，需重新排盘。</p>';

    if (!plan) {
      html += '<p class="empty">还没有装盘方案，点击上方按钮生成。</p>';
    } else {
      html +=
        '<div class="plan-status ' + (fresh ? "ok" : "void") + '">' +
        (fresh ? "方案有效" : "方案已作废") +
        " · 共 " + plan.reels.length + " 盘 · 生成于 " + formatTime(plan.plannedAt) +
        "</div>";
      if (!fresh && plan.voidReason) {
        html += '<div class="void-reason">作废原因：' + esc(plan.voidReason) + "</div>";
      }
      html += '<div class="reel-grid">' + plan.reels.map(function (reel, i) {
        return reelCard(reel, i, state.segments);
      }).join("") + "</div>";
    }
    html += "</section>";

    container.innerHTML = html;
    container.querySelector("#replanBtn").addEventListener("click", function () {
      actions.replanReels();
    });
  }

  function reelCard(reel, index, segments) {
    return (
      '<div class="reel-card' + (reel.duration > Rules.SECONDS_PER_REEL ? " over" : "") + '">' +
      '<div class="reel-head"><strong>第 ' + (index + 1) + " 盘</strong>" +
      "<span>" + formatDuration(reel.duration) + " / " + Rules.SECONDS_PER_REEL + " 秒</span></div>" +
      '<div class="reel-chips">' +
      reel.segments.map(function (id) {
        var seg = segments.find(function (s) { return s.id === id; });
        if (!seg) return "";
        return '<span class="reel-chip">' + esc(seg.code) + " · " + esc(seg.duration) + "s</span>";
      }).join("") +
      "</div>" +
      "</div>"
    );
  }

  /* ---------- 许可页 ---------- */

  function renderPermits(container, state, actions) {
    var pending = Rules.hasPendingReceipts(state.segments);
    var html =
      '<section class="panel">' +
      '<div class="panel-head"><h2>放映许可</h2>' +
      '<button class="primary" id="issuePermitBtn"' + (pending ? " disabled" : "") + ">生成放映许可</button></div>" +
      (pending
        ? '<div class="void-reason">存在未裁定的外检回执，不能生成放映许可。请先到「回执」页裁定。</div>'
        : '<p class="hint">许可绑定当时的片段顺序、风险结论（颜色偏移 / 破损）和盘数。顺序、时长、颜色偏移或破损任一变化，许可立即作废。</p>') +
      "</section>";

    if (!state.permits.length) {
      html += '<section class="panel" style="margin-top:16px"><p class="empty">还没有放映许可。</p></section>';
    } else {
      html += '<div class="permit-list">' + state.permits.map(function (permit) {
        return permitCard(permit, state.segments);
      }).join("") + "</div>";
    }

    container.innerHTML = html;
    var btn = container.querySelector("#issuePermitBtn");
    if (btn) btn.addEventListener("click", function () {
      actions.issuePermit();
    });
  }

  function permitCard(permit, segments) {
    var fresh = permit.status !== "void";
    var snap = permit.snapshot;
    return (
      '<section class="panel permit-card ' + (fresh ? "valid" : "void") + '">' +
      '<div class="permit-head">' +
      '<strong>放映许可 ' + esc(permit.id.slice(0, 8)) + "</strong>" +
      '<span class="badge ' + (fresh ? "ok" : "void") + '">' + (fresh ? "有效" : "已作废") + "</span>" +
      "</div>" +
      '<div class="permit-meta">签发于 ' + formatTime(permit.issuedAt) +
      " · 每盘 " + snap.secondsPerReel + " 秒 · 共 " + snap.reelCount + " 盘</div>" +
      '<div class="permit-snapshot">' +
      "<h4>绑定的片段顺序</h4>" +
      '<div class="reel-chips">' + snap.order.map(function (id, i) {
        var seg = segments.find(function (s) { return s.id === id; });
        var code = seg ? seg.code : id;
        return '<span class="reel-chip">' + (i + 1) + ". " + esc(code) + "</span>";
      }).join("") + "</div>" +
      "</div>" +
      '<div class="permit-snapshot">' +
      "<h4>绑定的风险结论</h4>" +
      '<div class="risk-rows">' + snap.order.map(function (id) {
        var seg = segments.find(function (s) { return s.id === id; });
        var code = seg ? seg.code : id;
        return '<div class="risk-row"><strong>' + esc(code) + "</strong>" +
          "<span>" + esc(snap.shifts[id] || "—") + " · " + esc(snap.damages[id] || "—") + "</span></div>";
      }).join("") + "</div>" +
      "</div>" +
      (fresh ? "" : '<div class="void-reason">作废原因：' + esc(permit.voidReason || "片段信息已变化") + "</div>") +
      "</section>"
    );
  }

  /* ---------- 批次页 ---------- */

  function renderBatches(container, state, actions, batches) {
    var html =
      '<section class="panel">' +
      '<div class="panel-head"><h2>未完成批次</h2>' +
      '<label class="simulate-toggle"><input type="checkbox" id="simulateFailChk"' + (Storage.isSimulateFail() ? " checked" : "") + "> 模拟下次保存失败</label></div>" +
      '<p class="hint">两个窗口同时保存时，版本落后的那次不会覆盖新数据，冲突字段列在下面等人工确认；保存失败会留下批次，可在此重试。</p>' +
      "</section>";

    if (!batches.length) {
      html += '<section class="panel" style="margin-top:16px"><p class="empty">没有未完成批次。</p></section>';
    } else {
      html += '<div class="batch-list">' + batches.map(function (batch) {
        return batchCard(batch);
      }).join("") + "</div>";
    }

    container.innerHTML = html;

    var chk = container.querySelector("#simulateFailChk");
    chk.addEventListener("change", function () {
      if (chk.checked) Storage.simulateFailOn();
      else Storage.simulateFailOff();
    });

    container.addEventListener("click", function (event) {
      var retry = event.target.closest("[data-retry-batch]");
      var resolveKeep = event.target.closest("[data-resolve-keep]");
      var resolveRemote = event.target.closest("[data-resolve-remote]");
      var mergeBtn = event.target.closest("[data-merge-batch]");
      if (retry) actions.retryBatch(retry.dataset.retryBatch);
      if (resolveKeep) actions.resolveBatchKeepLocal(resolveKeep.dataset.resolveKeep);
      if (resolveRemote) actions.resolveBatchKeepRemote(resolveRemote.dataset.resolveRemote);
      if (mergeBtn) {
        var card = event.target.closest(".batch-card");
        var choices = {};
        card.querySelectorAll("[data-conflict-choice]").forEach(function (input) {
          var idx = input.dataset.conflictChoice;
          if (input.checked) choices[idx] = input.value;
        });
        actions.mergeBatch(mergeBtn.dataset.mergeBatch, choices);
      }
    });
  }

  function batchCard(batch) {
    var reasonLabel = batch.reason === "conflict" ? "版本冲突" : "保存失败";
    var statusLabel = batch.status === "resolved" ? "已解决" : "待处理";
    var statusClass = batch.status === "resolved" ? "ok" : "void";
    var html =
      '<section class="panel batch-card ' + (batch.status === "resolved" ? "resolved" : "") + '" data-batch-id="' + esc(batch.id) + '">' +
      '<div class="batch-head">' +
      '<strong>' + reasonLabel + "</strong>" +
      '<span class="badge ' + statusClass + '">' + statusLabel + "</span>" +
      "<span class=\"batch-time\">" + formatTime(batch.createdAt) + "</span>" +
      "</div>";

    if (batch.status === "resolved") {
      html += '<div class="void-reason">已处理：' + esc(batch.resolution || "") + "</div></section>";
      return html;
    }

    if (batch.reason === "save-failed") {
      html += '<div class="void-reason">保存失败：' + esc(batch.error || "未知错误") + "</div>" +
        '<div class="btn-row"><button class="primary" data-retry-batch="' + esc(batch.id) + '">重试保存</button></div>';
    } else {
      html += '<div class="void-reason">本地版本 v' + esc(batch.baseVersion) +
        " 落后于存储版本 v" + esc(batch.remoteState ? batch.remoteState.version : "?") +
        "，以下字段未被覆盖：</div>";
      if (!batch.conflicts.length) {
        html += '<p class="empty">没有逐字段冲突，可直接整体保留本地或采用远程。</p>';
      } else {
        html += '<table class="conflict-table"><thead><tr><th>字段</th><th>本地（未保存）</th><th>远程（已保存）</th><th>选择</th></tr></thead><tbody>';
        batch.conflicts.forEach(function (c, i) {
          html += "<tr><td>" + esc(c.label) + "</td>" +
            "<td>" + esc(c.local) + "</td>" +
            "<td>" + esc(c.remote) + "</td>" +
            '<td class="choice-cell">' +
            '<label><input type="radio" name="choice-' + esc(batch.id) + '-' + i + '" data-conflict-choice="' + i + '" value="local" checked> 本地</label>' +
            '<label><input type="radio" name="choice-' + esc(batch.id) + '-' + i + '" data-conflict-choice="' + i + '" value="remote"> 远程</label>' +
            "</td></tr>";
        });
        html += "</tbody></table>";
      }
      html += '<div class="btn-row">' +
        '<button class="primary" data-merge-batch="' + esc(batch.id) + '">按选择合并并保存</button>' +
        '<button data-resolve-keep="' + esc(batch.id) + '">整体保留本地</button>' +
        '<button data-resolve-remote="' + esc(batch.id) + '">整体采用远程</button>' +
        "</div>";
    }
    html += "</section>";
    return html;
  }

  /* ---------- 徽标 ---------- */

  function updateBadges(state, batches) {
    var pending = state.segments.filter(function (s) { return s.receiptStatus === "pending"; }).length;
    var openBatches = batches.filter(function (b) { return b.status !== "resolved"; }).length;
    var permitVoid = state.permits.some(function (p) { return p.status === "void"; });

    setBadge("tabBadge-receipts", pending);
    setBadge("tabBadge-batches", openBatches);
    setBadge("tabBadge-permits", permitVoid ? "!" : "");

    var pendingEl = document.querySelector("#pendingCount");
    if (pendingEl) pendingEl.textContent = pending;
  }

  function setBadge(id, value) {
    var el = document.getElementById(id);
    if (!el) return;
    if (value === "" || value === 0) {
      el.textContent = "";
      el.classList.add("hidden");
    } else {
      el.textContent = String(value);
      el.classList.remove("hidden");
    }
  }

  global.UI = {
    renderSegments: renderSegments,
    renderReceipts: renderReceipts,
    renderReels: renderReels,
    renderPermits: renderPermits,
    renderBatches: renderBatches,
    updateBadges: updateBadges,
    formatDuration: formatDuration,
    esc: esc
  };
})(window);
