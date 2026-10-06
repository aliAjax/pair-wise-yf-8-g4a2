/* 页面公共工具：转义、格式化、弹窗与小型渲染辅助 */
(function (global) {
  "use strict";

  function escapeHtml(value) {
    return String(value === undefined || value === null ? "" : value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function formatDuration(seconds) {
    const value = Number(seconds) || 0;
    const minutes = Math.floor(value / 60);
    const rest = String(value % 60).padStart(2, "0");
    return `${minutes}:${rest}`;
  }

  function formatTime(ts) {
    if (!ts) return "";
    const d = new Date(ts);
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function readFileAsDataUrl(file) {
    return new Promise((resolve) => {
      if (!file) {
        resolve("");
        return;
      }
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => resolve("");
      reader.readAsDataURL(file);
    });
  }

  /** 简单的确认弹窗：返回 Promise<boolean> */
  function confirmDialog(message) {
    return Promise.resolve(window.confirm(message));
  }

  const STATUS_META = {
    local: { text: "仅自检", cls: "local" },
    agreed: { text: "外检一致", cls: "ok" },
    pending: { text: "待裁定", cls: "pending" },
    ruled: { text: "已裁定", cls: "ruled" }
  };

  global.DeskUI = {
    escapeHtml,
    formatDuration,
    formatTime,
    readFileAsDataUrl,
    confirmDialog,
    STATUS_META
  };
})(typeof self !== "undefined" ? self : globalThis);
