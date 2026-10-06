/* 外检回执页：纸质回单晚到登记（单张 / 批量），按片段编号归并、双结论待裁定 */
(function (global) {
  "use strict";
  const { escapeHtml, formatTime, STATUS_META } = global.DeskUI;
  const R = global.DeskRules;

  function createReceiptsView(app) {
    const els = {
      singleForm: document.querySelector("#receiptSingleForm"),
      rCode: document.querySelector("#rCode"),
      rDuration: document.querySelector("#rDuration"),
      rShift: document.querySelector("#rShift"),
      rDamage: document.querySelector("#rDamage"),
      rNo: document.querySelector("#rNo"),
      batchForm: document.querySelector("#receiptBatchForm"),
      batchText: document.querySelector("#batchText"),
      batchErrors: document.querySelector("#batchErrors"),
      receiptSummary: document.querySelector("#receiptSummary"),
      conflictList: document.querySelector("#conflictList"),
      unmatchedList: document.querySelector("#unmatchedList"),
      ruledList: document.querySelector("#ruledList")
    };

    function conclusionTags(c, clsDamage) {
      return `<span class="tag">${c.duration}s</span>
        <span class="tag">${escapeHtml(c.shift)}</span>
        <span class="tag ${c.damage !== "完好" ? "damage" : "ok"}">${escapeHtml(c.damage)}</span>`;
    }

    function renderSummary() {
      const state = app.getState();
      const withInspection = state.segments.filter((s) => s.inspection);
      const pending = R.pendingSegments(state).length;
      const agreed = withInspection.filter((s) => R.statusOf(s) === "agreed").length;
      const ruled = withInspection.filter((s) => R.statusOf(s) === "ruled").length;
      const unmatched = R.unmatchedReceipts(state).length;
      els.receiptSummary.innerHTML = `
        <div class="mini-stat"><strong>${withInspection.length}</strong><span>已归并回执</span></div>
        <div class="mini-stat ${pending ? "alert" : ""}"><strong>${pending}</strong><span>待裁定</span></div>
        <div class="mini-stat"><strong>${agreed}</strong><span>结论一致</span></div>
        <div class="mini-stat"><strong>${ruled}</strong><span>已裁定</span></div>
        <div class="mini-stat ${unmatched ? "alert" : ""}"><strong>${unmatched}</strong><span>找不到片段</span></div>
      `;
    }

    function renderConflicts() {
      const state = app.getState();
      const pending = state.segments.filter((s) => R.statusOf(s) === "pending");
      if (!pending.length) {
        els.conflictList.innerHTML = `<p class="empty">没有结论不一致的片段。</p>`;
        return;
      }
      els.conflictList.innerHTML = pending
        .map((seg) => {
          const index = state.segments.findIndex((s) => s.id === seg.id) + 1;
          return `
          <article class="conflict-card">
            <header>
              <strong>${index}. ${escapeHtml(seg.code)}</strong>
              <span class="status-tag ${STATUS_META.pending.cls}">待裁定</span>
            </header>
            <div class="conclusion-columns">
              <div>
                <span class="conclusion-label">排片员（刚改）</span>
                <div class="tag-row">${conclusionTags(seg)}</div>
              </div>
              <div>
                <span class="conclusion-label">外检回执${seg.inspection.receiptNo ? `（${escapeHtml(seg.inspection.receiptNo)}）` : ""} · ${formatTime(seg.inspection.receivedAt)}</span>
                <div class="tag-row">${conclusionTags(seg.inspection, true)}</div>
              </div>
            </div>
            <div class="conflict-actions">
              <button type="button" class="primary" data-rule-scheduler="${seg.id}">采用排片员结论</button>
              <button type="button" data-rule-inspection="${seg.id}">采用外检结论</button>
            </div>
          </article>`;
        })
        .join("");
    }

    function renderUnmatched() {
      const state = app.getState();
      const unmatched = R.unmatchedReceipts(state);
      els.unmatchedList.innerHTML = unmatched.length
        ? unmatched
            .map(
              (r) => `
          <article class="conflict-card orphan">
            <header>
              <strong>${escapeHtml(r.code)}</strong>
              <span class="status-tag pending">无对应片段</span>
            </header>
            <div class="tag-row">
              <span class="tag">${r.duration}s</span>
              <span class="tag">${escapeHtml(r.shift)}</span>
              <span class="tag ${r.damage !== "完好" ? "damage" : "ok"}">${escapeHtml(r.damage)}</span>
            </div>
            <p class="segment-note">回执单 ${escapeHtml(r.receiptNo || "无单号")} · ${formatTime(r.receivedAt)} 到达，清单里没有这个编号。</p>
          </article>`
            )
            .join("")
        : `<p class="empty">所有回执都已归并到片段。</p>`;
    }

    function renderRuled() {
      const state = app.getState();
      const ruled = state.segments.filter((s) => R.statusOf(s) === "ruled");
      els.ruledList.innerHTML = ruled.length
        ? ruled
            .map((seg) => {
              const index = state.segments.findIndex((s) => s.id === seg.id) + 1;
              const eff = R.effectiveConclusion(seg);
              return `
          <article class="conflict-card ruled-card">
            <header>
              <strong>${index}. ${escapeHtml(seg.code)}</strong>
              <span class="status-tag ruled">已裁定·${seg.ruling === "inspection" ? "采外检" : "采自检"}</span>
            </header>
            <div class="tag-row">
              <span class="tag">${eff.duration}s</span>
              <span class="tag">${escapeHtml(eff.shift)}</span>
              <span class="tag ${eff.damage !== "完好" ? "damage" : "ok"}">${escapeHtml(eff.damage)}</span>
            </div>
          </article>`;
            })
            .join("")
        : `<p class="empty">还没有人工裁定记录。</p>`;
    }

    function render() {
      renderSummary();
      renderConflicts();
      renderUnmatched();
      renderRuled();
    }

    function init() {
      els.singleForm.addEventListener("submit", (event) => {
        event.preventDefault();
        app.actions.receive([
          {
            code: els.rCode.value.trim(),
            duration: Number(els.rDuration.value),
            shift: els.rShift.value,
            damage: els.rDamage.value,
            receiptNo: els.rNo.value.trim()
          }
        ]);
        els.singleForm.reset();
        els.rDuration.value = 12;
        els.batchErrors.textContent = "";
      });

      els.batchForm.addEventListener("submit", (event) => {
        event.preventDefault();
        const { items, errors } = R.parseReceiptBatch(els.batchText.value);
        if (!items.length) {
          els.batchErrors.textContent = errors.join("\n") || "没有可录入的回执。";
          return;
        }
        app.actions.receive(items);
        els.batchText.value = "";
        els.batchErrors.textContent = errors.length ? `已录入 ${items.length} 条，以下行被跳过：\n${errors.join("\n")}` : `已录入 ${items.length} 条回执。`;
      });

      document.querySelector("#receiptPanels").addEventListener("click", (event) => {
        const useScheduler = event.target.closest("[data-rule-scheduler]");
        const useInspection = event.target.closest("[data-rule-inspection]");
        if (useScheduler) app.actions.adjudicate(useScheduler.dataset.ruleScheduler, "scheduler");
        if (useInspection) app.actions.adjudicate(useInspection.dataset.ruleInspection, "inspection");
      });
    }

    return { name: "receipts", render, init };
  }

  global.DeskViews = global.DeskViews || {};
  global.DeskViews.createReceiptsView = createReceiptsView;
})(typeof self !== "undefined" ? self : globalThis);
