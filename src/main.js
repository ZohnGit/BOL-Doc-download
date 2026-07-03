const { app, BrowserWindow, clipboard, dialog, ipcMain, screen } = require("electron");
const path = require("node:path");
const XLSX = require("xlsx");
const { captureVisibleOrders } = require("./services/capture");
const {
  findHeaderIndex,
  fillTemplateWorkbook,
  normalizeHeader,
  parseRowsToMap,
  readXlsxAsMatrix,
  writeWorkbookToFile,
} = require("./shared/xlsx");

let mainWindow = null;
let bubbleWindow = null;

const state = {
  captureRunning: false,
  captureBusy: false,
  capturePaused: false,
  captureHasCaptured: false,
  captureFinalized: false,
  captureAborted: false,
  captureAbortController: null,

  capturedRows: [],
  capturedMap: new Map(),

  erpFilePath: "",
  erpMap: new Map(),
  templateFilePath: "",
  templateSheetName: "",
  templateMatrix: [],
  templateOutputMatrix: [],
  templateOutputReady: false,

  lastError: "",
};

function sendState() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send("state:update", {
    captureRunning: state.captureRunning,
    captureBusy: state.captureBusy,
    capturePaused: state.capturePaused,
    captureHasCaptured: state.captureHasCaptured,
    captureFinalized: state.captureFinalized,
    capturedCount: state.capturedRows.length,
    erpLoaded: Boolean(state.erpMap.size),
    templateLoaded: Boolean(state.templateMatrix.length),
    outputReady: state.templateOutputReady,
    lastError: state.lastError,
  });
}

function showBubble() {
  if (!bubbleWindow || bubbleWindow.isDestroyed()) return;
  if (!bubbleWindow.isVisible()) {
    bubbleWindow.showInactive();
  }
  bubbleWindow.webContents.send("bubble:update", {
    captureRunning: state.captureRunning,
    captureBusy: state.captureBusy,
    captureHasCaptured: state.captureHasCaptured,
    capturePaused: state.capturePaused,
  });
}

function hideBubble() {
  if (!bubbleWindow || bubbleWindow.isDestroyed()) return;
  bubbleWindow.hide();
}

function createWindow() {
  const mainBounds = { width: 1280, height: 860 };
  mainWindow = new BrowserWindow({
    width: mainBounds.width,
    height: mainBounds.height,
    minWidth: 1180,
    minHeight: 780,
    backgroundColor: "#151515",
    title: "BOL订单获取整理",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"), {
    query: { mode: "main" },
  });

  mainWindow.on("close", () => {
    if (state.captureBusy && state.captureAbortController) {
      state.captureAbortController.abort("window-close");
    }
    if (!state.captureFinalized && state.captureHasCaptured) {
      state.captureFinalized = true;
      recomputeOutput();
    }
  });

  mainWindow.on("closed", () => {
    if (bubbleWindow && !bubbleWindow.isDestroyed()) {
      bubbleWindow.close();
      bubbleWindow = null;
    }
    mainWindow = null;
  });

  const display = screen.getPrimaryDisplay();
  const { workArea } = display;
  bubbleWindow = new BrowserWindow({
    width: 144,
    height: 144,
    x: workArea.x + workArea.width - 170,
    y: workArea.y + 60,
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    show: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    backgroundColor: "#00000000",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  bubbleWindow.setAlwaysOnTop(true, "screen-saver");
  bubbleWindow.loadFile(path.join(__dirname, "renderer", "index.html"), {
    query: { mode: "bubble" },
  });
  bubbleWindow.on("closed", () => {
    bubbleWindow = null;
  });
}

function setAbortController() {
  state.captureAbortController = new AbortController();
  return state.captureAbortController;
}

function clearAbortController() {
  state.captureAbortController = null;
}

function recomputeOutput() {
  if (!state.captureFinalized || !state.templateMatrix.length || !state.erpMap.size || !state.capturedMap.size) {
    state.templateOutputMatrix = [];
    state.templateOutputReady = false;
    sendState();
    return;
  }

  state.templateOutputMatrix = fillTemplateWorkbook({
    templateMatrix: state.templateMatrix,
    erpMap: state.erpMap,
    capturedMap: state.capturedMap,
  });
  state.templateOutputReady = state.templateOutputMatrix.length > 1;
  sendState();
}

async function loadErpFile(filePath) {
  const { matrix } = readXlsxAsMatrix(filePath);
  if (!matrix.length) {
    throw new Error("ERP文件为空。");
  }

  const headers = matrix[0].map(normalizeHeader);
  const platformIndex = findHeaderIndex(headers, [
    "refrence_no_platform",
    "reference_no_platform",
    "订单号",
    "order_no",
    "ordernum",
  ]);
  const refIndex = findHeaderIndex(headers, ["refrence_no", "reference_no", "erp订单号", "erp_no"]);
  if (platformIndex < 0 || refIndex < 0) {
    throw new Error("ERP文件里找不到 refrence_no_platform 或 refrence_no 列。");
  }

  const map = parseRowsToMap(matrix.slice(1), platformIndex, refIndex);
  state.erpFilePath = filePath;
  state.erpMap = map;
  recomputeOutput();
  return {
    filePath,
    count: map.size,
    outputReady: state.templateOutputReady,
  };
}

async function loadTemplateFile(filePath) {
  const workbook = XLSX.readFile(filePath, { cellDates: true });
  const sheetName = workbook.SheetNames[0];
  const matrix = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], {
    header: 1,
    raw: false,
    defval: "",
  });

  if (!matrix.length) {
    throw new Error("模板文件为空。");
  }

  state.templateFilePath = filePath;
  state.templateSheetName = sheetName;
  state.templateMatrix = matrix;
  recomputeOutput();
  return {
    filePath,
    sheetName,
    rows: Math.max(0, matrix.length - 1),
    outputReady: state.templateOutputReady,
  };
}

async function exportTemplateFile(savePath) {
  if (!state.templateOutputReady) {
    throw new Error("没有可导出的数据。");
  }

  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet(state.templateOutputMatrix);
  XLSX.utils.book_append_sheet(workbook, sheet, state.templateSheetName || "Sheet1");
  writeWorkbookToFile(workbook, savePath);
}

async function startCapture() {
  if (state.captureRunning) {
    if (state.capturePaused && !state.captureBusy) {
      state.capturePaused = false;
      state.captureAborted = false;
      showBubble();
      sendState();
    }
    return {
      captureRunning: state.captureRunning,
      capturePaused: state.capturePaused,
    };
  }

  state.captureRunning = true;
  state.captureBusy = false;
  state.capturePaused = false;
  state.captureHasCaptured = false;
  state.captureFinalized = false;
  state.captureAborted = false;
  state.lastError = "";
  state.capturedRows = [];
  state.capturedMap = new Map();
  showBubble();
  sendState();

  return {
    captureRunning: state.captureRunning,
    capturePaused: state.capturePaused,
  };
}

async function stopCapture() {
  if (!state.captureBusy || !state.captureAbortController) {
    return { captureBusy: state.captureBusy };
  }

  state.captureAborted = true;
  state.capturePaused = true;
  state.captureAbortController.abort("user-stop");
  return { captureBusy: state.captureBusy };
}

async function finishCapture() {
  if (!state.captureRunning) {
    return {
      captureRunning: state.captureRunning,
      captureFinalized: state.captureFinalized,
      capturePaused: state.capturePaused,
    };
  }

  if (state.captureBusy) {
    throw new Error("正在抓取中，请先点击悬浮球中的中止爬取。");
  }

  state.captureRunning = false;
  state.capturePaused = false;
  state.captureFinalized = true;
  hideBubble();
  recomputeOutput();
  sendState();
  return {
    captureRunning: state.captureRunning,
    capturePaused: state.capturePaused,
    captureFinalized: state.captureFinalized,
  };
}

async function runCapture() {
  if (!state.captureRunning) {
    throw new Error("请先开启开始爬取。");
  }
  if (state.captureBusy) {
    throw new Error("抓取进行中，请稍后再试。");
  }

  state.captureBusy = true;
  state.captureAborted = false;
  state.capturePaused = false;
  state.lastError = "";
  const controller = setAbortController();
  showBubble();
  sendState();

  try {
    const rows = await captureVisibleOrders({
      clipboardText: clipboard.readText(),
      signal: controller.signal,
    });

    const merged = [];
    for (const row of rows) {
      if (!row.orderNum) continue;
      const key = row.orderNum;
      const exists = state.capturedMap.get(key);
      if (exists) {
        state.capturedMap.set(key, { ...exists, ...row });
      } else {
        state.capturedMap.set(key, row);
      }
    }

    state.capturedRows = Array.from(state.capturedMap.values());
    merged.push(...rows);
    state.captureHasCaptured = state.captureHasCaptured || rows.length > 0;

    state.captureBusy = false;
    clearAbortController();
    sendState();

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("capture:batch", {
        rows: merged,
        total: state.capturedRows.length,
      });
    }

    return { rows: merged, total: state.capturedRows.length };
  } catch (error) {
    state.captureBusy = false;
    state.capturePaused = true;
    clearAbortController();
    state.lastError = error.message || String(error);
    sendState();

    if (state.lastError.includes("已中止爬取")) {
      return { rows: [], total: state.capturedRows.length };
    }

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("app:error", { message: state.lastError });
    }
    throw error;
  }
}

function initIpc() {
  ipcMain.handle("app:getState", async () => ({
    captureRunning: state.captureRunning,
    captureBusy: state.captureBusy,
    capturePaused: state.capturePaused,
    captureHasCaptured: state.captureHasCaptured,
    captureFinalized: state.captureFinalized,
    capturedRows: state.capturedRows,
    erpFilePath: state.erpFilePath,
    templateFilePath: state.templateFilePath,
    outputReady: state.templateOutputReady,
    lastError: state.lastError,
  }));

  ipcMain.handle("capture:toggle", async () => {
    if (!state.captureRunning || state.capturePaused) {
      return startCapture();
    }
    return finishCapture();
  });

  ipcMain.handle("capture:start", async () => startCapture());
  ipcMain.handle("capture:run", async () => runCapture());
  ipcMain.handle("capture:stop", async () => stopCapture());
  ipcMain.handle("capture:finish", async () => finishCapture());

  ipcMain.handle("file:loadErp", async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: "选择需标发订单ERP信息",
      properties: ["openFile"],
      filters: [{ name: "Excel", extensions: ["xlsx", "xls"] }],
    });
    if (result.canceled || !result.filePaths[0]) return { canceled: true };
    return loadErpFile(result.filePaths[0]);
  });

  ipcMain.handle("file:loadTemplate", async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: "选择批量导入文件模板",
      properties: ["openFile"],
      filters: [{ name: "Excel", extensions: ["xlsx", "xls"] }],
    });
    if (result.canceled || !result.filePaths[0]) return { canceled: true };
    return loadTemplateFile(result.filePaths[0]);
  });

  ipcMain.handle("file:exportProcessed", async () => {
    if (!state.templateOutputReady) {
      throw new Error("还没有可导出的处理结果。");
    }

    const today = new Date();
    const filename = [
      today.getFullYear(),
      String(today.getMonth() + 1).padStart(2, "0"),
      String(today.getDate()).padStart(2, "0"),
    ].join(".") + ".xlsx";

    const result = await dialog.showSaveDialog(mainWindow, {
      title: "导出标发文件",
      defaultPath: filename,
      filters: [{ name: "Excel", extensions: ["xlsx"] }],
    });

    if (result.canceled || !result.filePath) {
      return { canceled: true };
    }

    await exportTemplateFile(result.filePath);
    return { filePath: result.filePath };
  });
}

app.whenReady().then(() => {
  initIpc();
  createWindow();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

