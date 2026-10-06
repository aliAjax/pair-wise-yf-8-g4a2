/*
 * 控制器（编排层）：维护工作区状态、基版本（三方合并祖先）、
 * 保存/冲突裁定、未完成批次重试、跨窗口同步与页面切换。
 * 规则判定见 DeskRules，落盘见 DeskStorage。
 */
(function () {
  "use strict";
  const R = window.DeskRules;
  const S = window.DeskStorage;
  const UI = window.DeskUI;
  const Views = window.DeskViews;

  const store = S.createStore({
    prepare(raw, legacy) {
      if (raw) return R.normalizeState(raw);
      if (legacy) return R.migrateV1(legacy);
      return R.createDemoState();
    }
  });

  let snapshot = store.load();
  let state = snapshot.data; // 本窗口工作区
  let baseVersion = snapshot.version; // 保存冲突三方对比的祖先版本
  let baseState = R.normalizeState(snapshot.data); // 祖先数据
  let remoteInfo = null; // 另一窗口写入的新版本
  let conflictInfo = null; // 当前弹窗里的冲突
  let activeView = "desk";

  const els = {
    pages: document.querySelectorAll("[data-page]"),
    navButtons: document.querySelectorAll("[data-nav]"),
    badgePending: document.querySelector("#badgePending"),
    saveBtn: document.querySelector("#saveBtn"),
    failToggle: document.querySelector("#failToggle"),
    saveStatus: document.querySelector("#saveStatus"),
    remoteBanner: document.querySelector("#remoteBanner"),
    adoptRemoteBtn: document.querySelector("#adoptRemoteBtn"),
    outboxBanner: document.querySelector("#outboxBanner"),
    outboxList: document.querySelector("#outboxList"),
    retryAllBtn: document.querySelector("#retryAllBtn"),
    discardOutboxBtn: document.querySelector("#discardOutboxBtn"),
    exportBtn: document.querySelector("#exportBtn"),
    conflictModal: document.querySelector("#conflictModal"),
    conflictSummary: document.querySelector("#conflictSummary"),
    conflictList: document.querySelector("#conflictDiffList"),
    forceOverwrite: document.querySelector("#forceOverwrite"),
    mergeForceBtn: document.querySelector("#mergeForceBtn"),
    mergeAdoptBtn: document.querySelector("#mergeAdoptBtn"),
    mergeCancelBtn: document.querySelector("#mergeCancelBtn")
  };

  function getState() {
    return state;
  }

  /* ---------------- 渲染 ---------------- */

  function renderAll() {
    Object.values(views).forEach((view) => view.render());
    views.desk.syncInputs();
    renderChrome();
  }

  function renderChrome() {
    const pendingCount = R.pendingSegments(state).length;
    els.badgePending.textContent = pendingCount;
    els.badgePending.hidden = pendingCount === 0;

    const dirty = JSON.stringify(baseState) !== JSON.stringify(state);
    els.saveBtn.textContent = dirty ? "保存修改" : "已是最新";
    els.saveBtn.disabled = !dirty && !store.listPendingBatches().length;

    const batches = store.listPendingBatches();
    if (batches.length) {
      els.outboxBanner.hidden = false;
      els.outboxList.innerHTML = batches
        .map(
          (b) => `
        <li>
          <span>${UI.formatTime(b.createdAt)} 未完成批次（${b.reason === "simulated" ? "模拟失败" : b.reason}）· 基版本 v${b.baseVersion}</span>
          <button type="button" data-retry-batch="${b.id}">重试</button>
          <button type="button" data-discard-batch="${b.id}">放弃</button>
        </li>`
        )
        .join("");
    } else {
      els.outboxBanner.hidden = true;
    }

    if (remoteInfo) {
      els.remoteBanner.hidden = false;
      els.remoteBanner.querySelector("#remoteVersion").textContent = `另一窗口已保存 v${remoteInfo.version}（${UI.formatTime(remoteInfo.updatedAt)}）`;
    } else {
      els.remoteBanner.hidden = true;
    }

    els.saveStatus.textContent = `当前版本 v${baseVersion}${dirty ? " · 有未保存修改" : ""}`;
  }

  /* ---------------- 变更动作（只改工作区，不自动落盘） ---------------- */

  function mutate(next, opts = {}) {
    state = next;
    if (!opts.skipRender) renderAll();
    renderChrome();
  }

  const actions = {
    setTitle(title) {
      mutate(R.setReelTitle(state, title), { skipRender: true });
      renderChrome();
    },
    addSegment(input) {
      mutate(R.addSegment(state, input));
    },
    update(id, patch) {
      mutate(R.updateSegment(state, id, patch));
    },
    remove(id) {
      mutate(R.removeSegment(state, id));
    },
    move(id, direction) {
      mutate(R.moveSegment(state, id, direction));
    },
    reorder(fromId, targetId, opts) {
      mutate(R.reorderTo(state, fromId, targetId), opts || {});
    },
    receive(items) {
      mutate(R.receiveReceipts(state, items));
    },
    adjudicate(id, choice) {
      mutate(R.adjudicate(state, id, choice));
    },
    issuePermit() {
      const result = R.issuePermit(state);
      if (!result.ok) {
        window.alert(result.reasons.join("\n"));
        return;
      }
      state = result.state;
      renderAll();
      window.alert(`放映许可 ${result.permit.id} 已生成，共 ${result.permit.plateCount} 盘。请点击"保存修改"落盘。`);
    }
  };

  const views = {
    desk: Views.createDeskView({ getState, actions }),
    receipts: Views.createReceiptsView({ getState, actions }),
    release: Views.createReleaseView({ getState, actions })
  };

  /* ---------------- 保存 / 冲突 / 重试 ---------------- */

  function setTransientStatus(text) {
    els.saveStatus.textContent = text;
  }

  function persist({ force = false } = {}) {
    if (JSON.stringify(baseState) === JSON.stringify(state) && !force) return;
    if (force && conflictInfo) {
      // 强制覆盖时仍以当前存储版本为基，避免版本号倒退
      baseVersion = conflictInfo.current.version;
      baseState = R.normalizeState(conflictInfo.current.data);
    }
    const result = store.commit(state, baseVersion, force);
    if (result.ok) {
      baseVersion = result.version;
      baseState = R.normalizeState(result.data);
      remoteInfo = null;
      conflictInfo = null;
      closeConflictModal();
      setTransientStatus(`已保存为 v${result.version} · ${UI.formatTime(Date.now())}`);
      renderAll();
      return;
    }
    if (result.reason === "stale") {
      // 版本落后：绝不覆盖，列出冲突字段等人工确认
      const remote = R.normalizeState(result.current.data);
      const diff = R.diffStates(baseState, state, remote);
      conflictInfo = { diff, current: result.current, remote };
      remoteInfo = result.current;
      openConflictModal(diff);
      renderChrome();
      return;
    }
    // 写盘失败 / 模拟失败：留未完成批次，可重试
    const batch = store.enqueuePendingBatch({
      data: state,
      baseVersion,
      baseState,
      reason: result.reason
    });
    setTransientStatus(`保存失败，已留下未完成批次 ${batch.id}，可稍后重试。`);
    renderChrome();
  }

  function retryBatch(id, force = false) {
    const batch = store.listPendingBatches().find((b) => b.id === id);
    if (!batch) return;
    const ancestor = R.normalizeState(batch.baseState || baseState);
    if (force && conflictInfo) {
      // 重试强制覆盖：以存储最新版本为基
      batch.baseVersion = conflictInfo.current.version;
      batch.baseState = R.normalizeState(conflictInfo.current.data);
    }
    const result = store.commit(R.normalizeState(batch.data), batch.baseVersion, force);
    if (result.ok) {
      store.removePendingBatch(id);
      state = R.normalizeState(result.data);
      baseVersion = result.version;
      baseState = R.normalizeState(result.data);
      remoteInfo = null;
      conflictInfo = null;
      closeConflictModal();
      setTransientStatus(`批次 ${id} 重试成功，已保存为 v${result.version}。`);
      renderAll();
      return;
    }
    if (result.reason === "stale") {
      const remote = R.normalizeState(result.current.data);
      const diff = R.diffStates(ancestor, R.normalizeState(batch.data), remote);
      conflictInfo = { diff, current: result.current, remote, batchId: id };
      remoteInfo = result.current;
      openConflictModal(diff);
      return;
    }
    setTransientStatus(`批次 ${id} 重试仍失败，保留在未完成列表中。`);
    renderChrome();
  }

  function openConflictModal(diff) {
    els.conflictModal.hidden = false;
    els.conflictSummary.textContent =
      diff.conflicts.length > 0
        ? `检测到 ${diff.conflicts.length} 个双方都改过的冲突字段，另有 ${diff.remoteOnly.length} 项仅另一窗口修改、${diff.localOnly.length} 项仅本窗口修改。落后版本不会覆盖新数据，请逐项确认。`
        : `双方修改没有落在同一字段：另一窗口改了 ${diff.remoteOnly.length} 项，本窗口改了 ${diff.localOnly.length} 项。请确认后再保存。`;

    const row = (e) => `
      <tr class="${e.localChanged && e.remoteChanged ? "is-conflict" : ""}">
        <td>${UI.escapeHtml(e.label)}${e.localChanged && e.remoteChanged ? ' <span class="conflict-flag">冲突</span>' : ""}</td>
        <td>${UI.escapeHtml(e.local)}</td>
        <td>${UI.escapeHtml(e.remote)}</td>
      </tr>`;
    const sections = [
      ["双方都修改（冲突，必须人工确认）", diff.conflicts],
      ["仅本窗口修改", diff.localOnly],
      ["仅另一窗口修改", diff.remoteOnly]
    ];
    els.conflictList.innerHTML = sections
      .map(
        ([title, entries]) => `
        <tbody class="diff-section">
          <tr><th colspan="3">${UI.escapeHtml(title)}（${entries.length}）</th></tr>
        </tbody>
        <tbody>${entries.length ? entries.map(row).join("") : `<tr><td colspan="3" class="empty">无</td></tr>`}</tbody>`
      )
      .join("");
  }

  function closeConflictModal() {
    els.conflictModal.hidden = true;
    els.forceOverwrite.checked = false;
  }

  function adoptRemote() {
    if (!remoteInfo) return;
    state = R.normalizeState(remoteInfo.data);
    baseVersion = remoteInfo.version;
    baseState = R.normalizeState(remoteInfo.data);
    remoteInfo = null;
    conflictInfo = null;
    closeConflictModal();
    renderAll();
    setTransientStatus(`已采用另一窗口的 v${baseVersion}，本窗口未落盘修改已撤回。`);
  }

  /* ---------------- 跨窗口同步 ---------------- */

  store.subscribe((event) => {
    if (event.key !== S.STATE_KEY || !event.snapshot) return;
    if (event.snapshot.version <= baseVersion) return;
    const dirty = JSON.stringify(baseState) !== JSON.stringify(state);
    if (!dirty && !conflictInfo) {
      // 本窗口没有未落盘修改：静默跟进新版本
      state = R.normalizeState(event.snapshot.data);
      baseVersion = event.snapshot.version;
      baseState = R.normalizeState(event.snapshot.data);
      renderAll();
      setTransientStatus(`检测到另一窗口保存，已自动跟进到 v${baseVersion}。`);
    } else {
      remoteInfo = event.snapshot;
      renderChrome();
    }
  });
  store.start();

  /* ---------------- 页面切换 ---------------- */

  function switchView(name) {
    activeView = name;
    els.pages.forEach((page) => {
      page.hidden = page.dataset.page !== name;
    });
    els.navButtons.forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.nav === name);
    });
    views[name].render();
  }

  /* ---------------- 导出 ---------------- */

  function exportList() {
    const plates = R.packPlates(state.segments);
    const lines = [
      `胶片卷：${state.reelTitle || "未命名胶片卷"}`,
      `总时长：${UI.formatDuration(state.segments.reduce((sum, item) => sum + R.effectiveConclusion(item).duration, 0))}`,
      `装盘：${plates.length} 盘（每盘上限 ${R.PLATE_LIMIT_SECONDS} 秒）`,
      state.permit ? `放映许可：${state.permit.id}` : "放映许可：未签发",
      "",
      ...state.segments.map((item, index) => {
        const eff = R.effectiveConclusion(item);
        const status = { local: "仅自检", agreed: "外检一致", pending: "待裁定", ruled: "已裁定" }[R.statusOf(item)];
        return `${index + 1}. ${item.code}｜${UI.formatDuration(eff.duration)}｜${eff.shift}｜${eff.damage}｜${status}｜${item.note || "无备注"}`;
      }),
      "",
      ...plates.flatMap((plate, pi) => [
        `第 ${pi + 1} 盘（${plate.total}s${plate.overflow ? "，超时" : ""}）`,
        ...plate.segments.map((item) => `  - ${item.code} ${item.duration}s ${item.shift} ${item.damage}`)
      ])
    ];
    const blob = new Blob([lines.join("\n")], { type: "text/plain;charset=utf-8" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `${state.reelTitle || "film-reel"}-release.txt`;
    link.click();
    URL.revokeObjectURL(link.href);
  }

  /* ---------------- 事件绑定 ---------------- */

  els.navButtons.forEach((btn) => btn.addEventListener("click", () => switchView(btn.dataset.nav)));
  els.saveBtn.addEventListener("click", () => persist());
  els.exportBtn.addEventListener("click", exportList);
  els.failToggle.addEventListener("change", (event) => {
    if (event.target.checked) {
      store.failNextSave();
      setTransientStatus("已开启故障演练：下一次保存会失败并留下未完成批次。");
    }
  });
  els.adoptRemoteBtn.addEventListener("click", async () => {
    if (await UI.confirmDialog("采用另一窗口的新版本？本窗口未落盘的修改将撤回（仍保留在未完成批次里，如已保存失败）。")) {
      adoptRemote();
    }
  });
  els.retryAllBtn.addEventListener("click", () => {
    const ids = store.listPendingBatches().map((b) => b.id);
    ids.forEach((id) => retryBatch(id));
  });
  els.discardOutboxBtn.addEventListener("click", async () => {
    if (await UI.confirmDialog("清空全部未完成批次？未保存的修改会随批次一起丢弃。")) {
      store.clearPendingBatches();
      renderChrome();
    }
  });
  els.outboxList.addEventListener("click", (event) => {
    const retry = event.target.closest("[data-retry-batch]");
    const discard = event.target.closest("[data-discard-batch]");
    if (retry) retryBatch(retry.dataset.retryBatch);
    if (discard) {
      store.removePendingBatch(discard.dataset.discardBatch);
      renderChrome();
    }
  });

  els.mergeForceBtn.addEventListener("click", () => {
    if (!els.forceOverwrite.checked) {
      window.alert("请先勾选'我已逐项核对冲突字段'，再强制以本窗口版本覆盖。");
      return;
    }
    if (conflictInfo && conflictInfo.batchId) retryBatch(conflictInfo.batchId, true);
    else persist({ force: true });
  });
  els.mergeAdoptBtn.addEventListener("click", adoptRemote);
  els.mergeCancelBtn.addEventListener("click", closeConflictModal);

  Object.values(views).forEach((view) => view.init());
  switchView(activeView);
  renderAll();
})();
