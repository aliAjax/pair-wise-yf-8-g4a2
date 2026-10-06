/* 排片核对页：录入、拖拽排序、行内编辑、试映风险提醒 */
(function (global) {
  "use strict";
  const { escapeHtml, formatDuration, readFileAsDataUrl, STATUS_META } = global.DeskUI;
  const R = global.DeskRules;

  const fallbackThumbs = ["#d49b35", "#347d89", "#b54d48", "#4d7656", "#6d6378"];

  function createDeskView(app) {
    const els = {
      reelTitle: document.querySelector("#reelTitle"),
      colorFilter: document.querySelector("#colorFilter"),
      searchInput: document.querySelector("#searchInput"),
      segmentForm: document.querySelector("#segmentForm"),
      codeInput: document.querySelector("#codeInput"),
      durationInput: document.querySelector("#durationInput"),
      shiftInput: document.querySelector("#shiftInput"),
      damageInput: document.querySelector("#damageInput"),
      thumbInput: document.querySelector("#thumbInput"),
      noteInput: document.querySelector("#noteInput"),
      segmentList: document.querySelector("#segmentList"),
      warningList: document.querySelector("#warningList"),
      totalDuration: document.querySelector("#totalDuration"),
      damageCount: document.querySelector("#damageCount"),
      segmentCount: document.querySelector("#segmentCount"),
      pendingCount: document.querySelector("#pendingCount")
    };

    let draggedId = null;
    let editingId = null;

    function getFilteredSegments() {
      const state = app.getState();
      const color = els.colorFilter.value;
      const keyword = els.searchInput.value.trim();
      return state.segments.filter((item) => {
        const eff = R.effectiveConclusion(item);
        const matchesColor = color === "all" || eff.shift === color;
        const matchesKeyword = !keyword || `${item.code}${item.note}${eff.damage}`.includes(keyword);
        return matchesColor && matchesKeyword;
      });
    }

    function renderStats() {
      const state = app.getState();
      const total = state.segments.reduce((sum, item) => sum + R.effectiveConclusion(item).duration, 0);
      const damaged = state.segments.filter((item) => R.effectiveConclusion(item).damage !== "完好").length;
      els.totalDuration.textContent = formatDuration(total);
      els.damageCount.textContent = damaged;
      els.segmentCount.textContent = state.segments.length;
      els.pendingCount.textContent = R.pendingSegments(state).length;
    }

    function renderCard(item, realIndex) {
      const status = R.statusOf(item);
      const eff = R.effectiveConclusion(item);
      const meta = STATUS_META[status];
      const hasDamage = eff.damage !== "完好";
      const inspectionBlock = item.inspection
        ? `
          <div class="conclusion-block">
            <span class="conclusion-label">外检回执${item.inspection.receiptNo ? `（${escapeHtml(item.inspection.receiptNo)}）` : ""}</span>
            <span class="tag">${item.inspection.duration}s</span>
            <span class="tag">${escapeHtml(item.inspection.shift)}</span>
            <span class="tag ${item.inspection.damage !== "完好" ? "damage" : "ok"}">${escapeHtml(item.inspection.damage)}</span>
          </div>`
            : "";

      const ownBlock = `
        <div class="conclusion-block">
          <span class="conclusion-label">排片员</span>
          <span class="tag">${item.duration}s</span>
          <span class="tag">${escapeHtml(item.shift)}</span>
          <span class="tag ${hasDamage ? "damage" : "ok"}">${escapeHtml(item.damage)}</span>
        </div>`;

      if (editingId === item.id) {
        return `
          <article class="segment-card editing" data-id="${item.id}">
            <form class="inline-form" data-edit-form="${item.id}">
              <div class="inline-grid">
                <label>编号<input name="code" required value="${escapeHtml(item.code)}" /></label>
                <label>时长秒<input name="duration" type="number" min="1" required value="${item.duration}" /></label>
                <label>颜色
                  <select name="shift">
                    ${R.SHIFTS.map((v) => `<option value="${v}" ${v === item.shift ? "selected" : ""}>${v}</option>`).join("")}
                  </select>
                </label>
                <label>破损
                  <select name="damage">
                    ${R.DAMAGES.map((v) => `<option value="${v}" ${v === item.damage ? "selected" : ""}>${v}</option>`).join("")}
                  </select>
                </label>
              </div>
              <label class="full">备注<input name="note" value="${escapeHtml(item.note)}" /></label>
              <div class="inline-actions">
                <button class="primary" type="submit">保存修改</button>
                <button type="button" data-edit-cancel="${item.id}">取消</button>
              </div>
            </form>
          </article>`;
      }

      return `
        <article class="segment-card" draggable="true" data-id="${item.id}">
          <div class="thumb">
            ${
              item.thumb
                ? `<img src="${item.thumb}" alt="${escapeHtml(item.code)}缩略图" />`
                : `<div class="film-placeholder" style="background:${fallbackThumbs[realIndex % fallbackThumbs.length]}">${escapeHtml(item.code)}</div>`
            }
          </div>
          <div class="segment-main">
            <div class="segment-title">
              <strong>${realIndex + 1}. ${escapeHtml(item.code)}</strong>
              <span>${formatDuration(eff.duration)}</span>
              <span class="status-tag ${meta.cls}">${meta.text}${status === "ruled" ? `·${item.ruling === "inspection" ? "采外检" : "采自检"}` : ""}</span>
            </div>
            ${ownBlock}
            ${inspectionBlock}
            <p class="segment-note">${escapeHtml(item.note || "没有备注。")}</p>
          </div>
          <div class="segment-actions">
            <button type="button" title="上移" data-move-up="${item.id}">↑</button>
            <button type="button" title="下移" data-move-down="${item.id}">↓</button>
            <button type="button" title="编辑" data-edit="${item.id}">改</button>
            <button type="button" title="删除" data-delete="${item.id}">×</button>
          </div>
        </article>
      `;
    }

    function renderList() {
      const state = app.getState();
      const segments = getFilteredSegments();
      els.segmentList.innerHTML =
        segments
          .map((item) => {
            const realIndex = state.segments.findIndex((segment) => segment.id === item.id);
            return renderCard(item, realIndex);
          })
          .join("") || `<p class="empty">没有符合筛选的片段。</p>`;
    }

    function renderWarnings() {
      const state = app.getState();
      const pending = R.pendingSegments(state);
      const risks = state.segments.filter((item) => {
        const eff = R.effectiveConclusion(item);
        return eff.damage !== "完好" || eff.shift !== "正常";
      });
      const unmatched = R.unmatchedReceipts(state);

      const blocks = [];
      if (pending.length) {
        blocks.push(
          pending
            .map((item) => {
              const index = state.segments.findIndex((segment) => segment.id === item.id) + 1;
              return `
              <div class="warning-item pending">
                <strong>${index}. ${escapeHtml(item.code)}｜外检结论待裁定</strong>
                <span>自检：${item.duration}s · ${escapeHtml(item.shift)} · ${escapeHtml(item.damage)}<br/>
                外检：${item.inspection.duration}s · ${escapeHtml(item.inspection.shift)} · ${escapeHtml(item.inspection.damage)}</span>
              </div>`;
            })
            .join("")
        );
      }
      blocks.push(
        risks
          .map((item) => {
            const index = state.segments.findIndex((segment) => segment.id === item.id) + 1;
            const eff = R.effectiveConclusion(item);
            const reasons = [eff.shift !== "正常" ? eff.shift : "", eff.damage !== "完好" ? eff.damage : ""].filter(Boolean).join(" · ");
            return `
            <div class="warning-item">
              <strong>${index}. ${escapeHtml(item.code)}</strong>
              <span>${escapeHtml(reasons)}${item.note ? `：${escapeHtml(item.note)}` : ""}</span>
            </div>`;
          })
          .join("")
      );
      if (unmatched.length) {
        blocks.push(
          unmatched
            .map(
              (r) => `
            <div class="warning-item pending">
              <strong>${escapeHtml(r.code)}｜外检回执无对应片段</strong>
              <span>回执单 ${escapeHtml(r.receiptNo || "无单号")}：${r.duration}s · ${escapeHtml(r.shift)} · ${escapeHtml(r.damage)}</span>
            </div>`
            )
            .join("")
        );
      }
      els.warningList.innerHTML = blocks.filter(Boolean).join("") || `<p class="empty">当前清单没有颜色偏移或破损提醒。</p>`;
    }

    function render() {
      renderStats();
      renderList();
      renderWarnings();
    }

    function init() {
      els.reelTitle.addEventListener("input", () => app.actions.setTitle(els.reelTitle.value));
      els.colorFilter.addEventListener("change", renderList);
      els.searchInput.addEventListener("input", renderList);

      els.segmentForm.addEventListener("submit", async (event) => {
        event.preventDefault();
        const thumb = await readFileAsDataUrl(els.thumbInput.files[0]);
        app.actions.addSegment({
          code: els.codeInput.value.trim(),
          duration: Number(els.durationInput.value),
          shift: els.shiftInput.value,
          damage: els.damageInput.value,
          note: els.noteInput.value.trim(),
          thumb
        });
        els.segmentForm.reset();
        els.durationInput.value = 12;
      });

      els.segmentList.addEventListener("click", (event) => {
        const up = event.target.closest("[data-move-up]");
        const down = event.target.closest("[data-move-down]");
        const edit = event.target.closest("[data-edit]");
        const cancel = event.target.closest("[data-edit-cancel]");
        const remove = event.target.closest("[data-delete]");
        if (up) app.actions.move(up.dataset.moveUp, -1);
        if (down) app.actions.move(down.dataset.moveDown, 1);
        if (edit) {
          editingId = edit.dataset.edit;
          renderList();
        }
        if (cancel) {
          editingId = null;
          renderList();
        }
        if (remove) app.actions.remove(remove.dataset.delete);
      });

      els.segmentList.addEventListener("submit", (event) => {
        const form = event.target.closest("[data-edit-form]");
        if (!form) return;
        event.preventDefault();
        const data = new FormData(form);
        app.actions.update(form.dataset.editForm, {
          code: data.get("code"),
          duration: Number(data.get("duration")),
          shift: data.get("shift"),
          damage: data.get("damage"),
          note: String(data.get("note") || "")
        });
        editingId = null;
      });

      els.segmentList.addEventListener("dragstart", (event) => {
        const card = event.target.closest("[data-id]");
        if (!card) return;
        draggedId = card.dataset.id;
        card.classList.add("dragging");
        event.dataTransfer.effectAllowed = "move";
      });

      els.segmentList.addEventListener("dragend", (event) => {
        event.target.closest("[data-id]")?.classList.remove("dragging");
        draggedId = null;
      });

      els.segmentList.addEventListener("dragover", (event) => {
        const card = event.target.closest("[data-id]");
        if (!card || !draggedId || card.dataset.id === draggedId) return;
        event.preventDefault();
        const fromExists = app.getState().segments.some((s) => s.id === draggedId);
        if (!fromExists) return;
        app.actions.reorder(draggedId, card.dataset.id, { skipRender: true });
        renderList();
      });
    }

    function syncInputs() {
      const state = app.getState();
      if (document.activeElement !== els.reelTitle) els.reelTitle.value = state.reelTitle;
    }

    return {
      name: "desk",
      render,
      init,
      syncInputs
    };
  }

  global.DeskViews = global.DeskViews || {};
  global.DeskViews.createDeskView = createDeskView;
})(typeof self !== "undefined" ? self : globalThis);
