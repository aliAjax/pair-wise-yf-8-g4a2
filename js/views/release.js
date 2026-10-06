/* 放行签放页：待裁定闸口、生成放映许可、许可状态、按每盘 150 秒的装盘方案 */
(function (global) {
  "use strict";
  const { escapeHtml, formatDuration, formatTime, STATUS_META } = global.DeskUI;
  const R = global.DeskRules;

  function createReleaseView(app) {
    const els = {
      gateList: document.querySelector("#gateList"),
      issueBtn: document.querySelector("#issuePermitBtn"),
      permitPanel: document.querySelector("#permitPanel"),
      platePlan: document.querySelector("#platePlan")
    };

    function renderGate() {
      const state = app.getState();
      const check = R.canIssue(state);
      if (check.ok) {
        els.gateList.innerHTML = `<p class="empty ok-empty">所有片段外检结论均已归并并裁定，可以生成放映许可。</p>`;
        els.issueBtn.disabled = false;
        els.issueBtn.textContent = `生成放映许可（${R.packPlates(state.segments).length} 盘 · ${formatDuration(state.segments.reduce((s, x) => s + R.effectiveConclusion(x).duration, 0))}）`;
        return;
      }
      els.issueBtn.disabled = true;
      els.issueBtn.textContent = "有待裁定事项，暂不能签放";
      els.gateList.innerHTML = check.reasons.map((reason) => `<div class="warning-item pending"><span>${escapeHtml(reason)}</span></div>`).join("");
    }

    function renderPermit() {
      const state = app.getState();
      if (!state.permit) {
        els.permitPanel.innerHTML = `<div class="permit-card absent"><p class="empty">尚未生成放映许可。</p></div>`;
        return;
      }
      const evaluation = R.evaluatePermit(state);
      const p = state.permit;
      const meta = {
        valid: { cls: "valid", title: "许可有效", desc: "指纹与当前清单一致，可照常放映。" },
        suspended: { cls: "suspended", title: "暂缓放行", desc: "许可本身未失效，但出现待裁定外检结论，裁定前不得放行。" },
        void: { cls: "void", title: "许可已作废", desc: "顺序 / 时长 / 颜色偏移 / 破损 / 盘数发生变化，装盘方案同步作废，需重新排盘签放。" }
      }[evaluation.status];

      const reasonHtml = (items) =>
        items.length ? `<ul class="permit-reasons">${items.map((x) => `<li>${escapeHtml(x.message)}</li>`).join("")}</ul>` : "";

      els.permitPanel.innerHTML = `
        <div class="permit-card ${meta.cls}">
          <div class="permit-head">
            <div>
              <span class="permit-id">${escapeHtml(p.id)}</span>
              <h3>${meta.title}</h3>
            </div>
            <span class="status-tag ${evaluation.status}">${meta.title}</span>
          </div>
          <p class="segment-note">${meta.desc}</p>
          <div class="permit-meta">
            <span>签发时间：${formatTime(p.issuedAt)}</span>
            <span>绑定盘数：${p.plateCount} 盘（每盘上限 ${p.limitSeconds} 秒）</span>
            <span>绑定片段：${p.snapshot.length} 个</span>
          </div>
          ${reasonHtml(evaluation.reasons)}
          ${reasonHtml(evaluation.suspended)}
          ${
            evaluation.status === "void"
              ? `<button class="primary" type="button" data-scroll-gate>重新核对后签放</button>`
              : ""
          }
        </div>`;
    }

    function renderPlates() {
      const state = app.getState();
      const plates = R.packPlates(state.segments);
      const bound = state.permit ? state.permit.plates : null;
      const changed = state.permit && plates.length !== state.permit.plateCount;

      els.platePlan.innerHTML = `
        <div class="panel-head">
          <h3>装盘方案（每盘 ${R.PLATE_LIMIT_SECONDS} 秒）</h3>
          <span>${changed ? "盘数已变，许可方案作废" : bound ? "与许可绑定方案一致" : "当前预排，未签发"}</span>
        </div>
        ${plates
          .map((plate, pi) => {
            const boundPlate = bound ? bound[pi] : null;
            const plateChanged = boundPlate && JSON.stringify(boundPlate.segments.map((s) => s.id)) !== JSON.stringify(plate.segments.map((s) => s.id));
            return `
            <div class="plate ${plate.overflow ? "overflow" : ""} ${plateChanged ? "changed" : ""}">
              <header>
                <strong>第 ${pi + 1} 盘</strong>
                <span>${formatDuration(plate.total)} / ${formatDuration(R.PLATE_LIMIT_SECONDS)}</span>
                ${plate.overflow ? `<span class="status-tag void">单片超时</span>` : ""}
                ${plateChanged ? `<span class="status-tag void">已偏离许可</span>` : ""}
              </header>
              <ol class="plate-items">
                ${plate.segments
                  .map((item) => {
                    const seg = state.segments.find((s) => s.id === item.id);
                    const status = seg ? R.statusOf(seg) : "local";
                    return `<li>
                      <span>${escapeHtml(item.code)}</span>
                      <span>${formatDuration(item.duration)}</span>
                      <span>${escapeHtml(item.shift)}</span>
                      <span>${escapeHtml(item.damage)}</span>
                      ${status === "pending" ? `<span class="status-tag pending">待裁定</span>` : ""}
                    </li>`;
                  })
                  .join("")}
              </ol>
            </div>`;
          })
          .join("") || `<p class="empty">还没有可装盘的片段。</p>`}
      `;
    }

    function render() {
      renderGate();
      renderPermit();
      renderPlates();
    }

    function init() {
      els.issueBtn.addEventListener("click", () => app.actions.issuePermit());
      els.permitPanel.addEventListener("click", (event) => {
        if (event.target.closest("[data-scroll-gate]")) {
          els.gateList.scrollIntoView({ behavior: "smooth", block: "center" });
        }
      });
    }

    return { name: "release", render, init };
  }

  global.DeskViews = global.DeskViews || {};
  global.DeskViews.createReleaseView = createReleaseView;
})(typeof self !== "undefined" ? self : globalThis);
