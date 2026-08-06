'use strict';

// 让小红书详情页在不同分辨率下至少拥有可完整展示评论编辑器的 CSS 空间。
// 大屏保持 100%，小窗口最多缩到 80%，避免固定缩放导致字体过小。
function xhsZoomFactor(width, height) {
  const w = Math.max(1, Number(width) || 1);
  const h = Math.max(1, Number(height) || 1);
  const fit = Math.min(w / 840, h / 980, 1);
  return Math.round(Math.max(0.8, fit) * 100) / 100;
}

module.exports = { xhsZoomFactor };
