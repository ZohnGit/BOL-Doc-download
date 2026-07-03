const appRoot = document.getElementById("app");
const params = new URLSearchParams(window.location.search);
const mode = params.get("mode") || "main";

const state = {
  view: "shipped",
  captureRunning: false,
  captureBusy: false,
  capturePaused: false,
  captureHasCaptured: false,
  captureFinalized: false,
  lastError: "",
  capturedRows: [],
  erpFilePath: "",
  templateFilePath: "",
  outputReady: false,
  summary: {
    orderCount: 0,
    erpCount: 0,
    templateRows: 0,
    filledRows: 0,
  },
};

const columns = ["OrderNum", "购买人姓名", "时间", "跟踪号", "SKU"];

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function render() {
  if (mode === "bubble") {
    document.documentElement.className = "bubble-root-mode";
    document.body.className = "bubble-body";

    const bubbleText = state.captureBusy
      ? "中止爬取"
      : state.captureHasCaptured
        ? "继续爬取"
        : "开始爬取";

    appRoot.innerHTML = `
      <div class="bubble-root">
        <div class="bubble ${state.captureBusy ? "busy" : ""}" id="bubble">
          <span>${bubbleText}</span>
        </div>
      </div>
    `;

    document.getElementById("bubble").onclick = async () => {
      if (state.captureBusy) {
        await window.bolApi.stopCapture();
        return;
      }
      if (!state.captureRunning) {
        await window.bolApi.startCapture();
        return;
      }
      await window.bolApi.runCapture();
    };
    return;
  }

  document.documentElement.className = "";
  document.body.className = "";
  const disabledBlock2 = !state.summary.orderCount;
  const disabledBlock3 = !(state.summary.orderCount && state.summary.erpCount);

  appRoot.innerHTML = `
    <div class="app-shell">
      <aside class="sidebar">
        <div class="brand">
          <h1>BOL订单获取整理</h1>
          <p>Windows桌面工具 / 标发数据流程</p>
        </div>
        <div class="nav">
          <button class="nav-item ${state.view === "daily" ? "active" : ""}" data-view="daily">每日数据</button>
          <button class="nav-item ${state.view === "shipped" ? "active" : ""}" data-view="shipped">标发数据</button>
        </div>
      </aside>
      <main class="content">
        ${state.view === "daily" ? dailyView() : shippedView(disabledBlock2, disabledBlock3)}
      </main>
    </div>
  `;

  document.querySelectorAll("[data-view]").forEach((button) => {
    button.onclick = () => {
      state.view = button.dataset.view;
      render();
    };
  });

  bindShippedActions(disabledBlock2, disabledBlock3);
}

function dailyView() {
  return `
    <h1 class="page-title">每日数据</h1>
    <div class="page-card coming-soon">Coming Soon</div>
  `;
}

function shippedView(disabledBlock2, disabledBlock3) {
  const captureButtonText = state.captureRunning
    ? state.captureBusy
      ? "结束爬取"
      : state.capturePaused
        ? "开始爬取"
        : "结束爬取"
    : "开始爬取";
  return `
    <h1 class="page-title">标发数据</h1>

    <section class="block">
      <div class="block-header">
        <h2>1）爬取Shipped页面数据</h2>
        <div class="small-note">状态：${state.captureRunning ? (state.captureBusy ? "抓取中" : "已开启") : "未开始"}</div>
      </div>
      <div class="block-body">
        <div class="small-note">点击开始后会显示悬浮球。悬浮球每次点击会抓取当前页面可见数据。抓取中可中止，未抓完不允许结束。</div>
        <div class="controls">
          <button class="btn ${state.captureBusy ? "disabled" : ""}" id="captureToggle" ${state.captureBusy ? "disabled" : ""}>${captureButtonText}</button>
        </div>
        <div class="summary-grid">
          <div class="summary-card"><span>已抓取订单</span><strong>${state.summary.orderCount}</strong></div>
          <div class="summary-card"><span>ERP映射</span><strong>${state.summary.erpCount}</strong></div>
          <div class="summary-card"><span>模板行数</span><strong>${state.summary.templateRows}</strong></div>
          <div class="summary-card"><span>已回填</span><strong>${state.summary.filledRows}</strong></div>
        </div>
        <div class="table-shell">
          <table>
            <thead>
              <tr>${columns.map((col) => `<th>${col}</th>`).join("")}</tr>
            </thead>
            <tbody>
              ${state.capturedRows
                .map(
                  (row) => `
                    <tr>
                      <td>${escapeHtml(row.orderNum)}</td>
                      <td>${escapeHtml(row.buyerName)}</td>
                      <td>${escapeHtml(row.time)}</td>
                      <td>${escapeHtml(row.trackingNumber)}</td>
                      <td>${escapeHtml(row.sku)}</td>
                    </tr>
                  `,
                )
                .join("")}
            </tbody>
          </table>
        </div>
      </div>
    </section>

    <section class="block ${disabledBlock2 ? "disabled" : ""}">
      <div class="block-header">
        <h2>2）选择需标发订单ERP信息</h2>
        <div class="small-note">${disabledBlock2 ? "需先完成板块1" : "已激活"}</div>
      </div>
      <div class="block-body">
        <div class="controls">
          <button class="btn ${disabledBlock2 ? "disabled" : ""}" id="loadErp" ${disabledBlock2 ? "disabled" : ""}>选择文件</button>
        </div>
        <div class="path-box" id="erpPath">${escapeHtml(state.erpFilePath || "")}</div>
      </div>
    </section>

    <section class="block ${disabledBlock3 ? "disabled" : ""}">
      <div class="block-header">
        <h2>3）选择批量导入文件模板</h2>
        <div class="small-note">${disabledBlock3 ? "需先完成板块1和板块2" : "已激活"}</div>
      </div>
      <div class="block-body">
        <div class="controls">
          <button class="btn ${disabledBlock3 ? "disabled" : ""}" id="loadTemplate" ${disabledBlock3 ? "disabled" : ""}>选择文件</button>
        </div>
        <div class="path-box" id="templatePath">${escapeHtml(state.templateFilePath || "")}</div>
      </div>
    </section>

    <section class="block">
      <div class="block-header">
        <h2>可批量上传标发文件下载</h2>
        <div class="small-note">${state.outputReady ? "可导出" : "等待产出"}</div>
      </div>
      <div class="block-body">
        <button class="btn ${state.outputReady ? "" : "disabled"}" id="exportFile" ${state.outputReady ? "" : "disabled"}>可批量上传标发文件下载</button>
        <div class="status-line">${state.lastError ? escapeHtml(state.lastError) : state.outputReady ? "处理好的xlsx文件已准备完成。" : "完成前三步并点击结束爬取后启用导出。"}</div>
      </div>
    </section>
  `;
}

function bindShippedActions(disabledBlock2, disabledBlock3) {
  const captureToggle = document.getElementById("captureToggle");
  if (captureToggle) {
    captureToggle.onclick = async () => {
      if (state.captureBusy) {
        return;
      }
      if (!state.captureRunning || state.capturePaused) {
        await window.bolApi.startCapture();
        return;
      }
      await window.bolApi.finishCapture();
    };
  }

  const loadErp = document.getElementById("loadErp");
  if (loadErp) {
    loadErp.onclick = async () => {
      if (disabledBlock2) return;
      const result = await window.bolApi.loadErpFile();
      if (result && !result.canceled) {
        state.erpFilePath = result.filePath;
        state.summary.erpCount = result.count || 0;
        state.outputReady = Boolean(result.outputReady);
        render();
      }
    };
  }

  const loadTemplate = document.getElementById("loadTemplate");
  if (loadTemplate) {
    loadTemplate.onclick = async () => {
      if (disabledBlock3) return;
      const result = await window.bolApi.loadTemplateFile();
      if (result && !result.canceled) {
        state.templateFilePath = result.filePath;
        state.summary.templateRows = result.rows || 0;
        state.outputReady = Boolean(result.outputReady);
        state.summary.filledRows = state.outputReady ? state.summary.orderCount : 0;
        render();
      }
    };
  }

  const exportFile = document.getElementById("exportFile");
  if (exportFile) {
    exportFile.onclick = async () => {
      if (!state.outputReady) return;
      const result = await window.bolApi.exportProcessedFile();
      if (result && !result.canceled) {
        state.lastError = `已导出：${result.filePath}`;
        render();
      }
    };
  }
}

window.bolApi.onStateUpdate((payload) => {
  state.captureRunning = payload.captureRunning;
  state.captureBusy = payload.captureBusy;
  state.capturePaused = payload.capturePaused;
  state.captureHasCaptured = payload.captureHasCaptured;
  state.captureFinalized = payload.captureFinalized;
  state.outputReady = payload.outputReady;
  state.summary.filledRows = payload.outputReady ? state.summary.orderCount : 0;
  state.lastError = payload.lastError || "";
  render();
});

window.bolApi.onCaptureBatch((payload) => {
  state.capturedRows = payload.rows || [];
  state.summary.orderCount = payload.total || state.capturedRows.length;
  state.summary.filledRows = state.outputReady ? state.summary.orderCount : 0;
  render();
});

window.bolApi.onAppError((payload) => {
  state.lastError = payload.message || "发生未知错误";
  render();
});

window.bolApi.onBubbleUpdate((payload) => {
  state.captureRunning = payload.captureRunning;
  state.captureBusy = payload.captureBusy;
  state.capturePaused = payload.capturePaused;
  state.captureHasCaptured = payload.captureHasCaptured;
  render();
});

window.bolApi.getState().then((payload) => {
  state.captureRunning = payload.captureRunning;
  state.captureBusy = payload.captureBusy;
  state.captureHasCaptured = payload.captureHasCaptured;
  state.captureFinalized = payload.captureFinalized;
  state.capturedRows = payload.capturedRows || [];
  state.erpFilePath = payload.erpFilePath || "";
  state.templateFilePath = payload.templateFilePath || "";
  state.outputReady = Boolean(payload.outputReady);
  state.summary.orderCount = state.capturedRows.length;
  render();
});

render();
