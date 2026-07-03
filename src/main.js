const { app, BrowserWindow, clipboard, dialog, ipcMain, screen } = require("electron");
const fs = require("node:fs");
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
    capturedCount: state.capturedRows.length,
    erpLoaded: Boolean(state.erpMap.size),
    templateLoaded: Boolean(state.templateMatrix.length),
    outputReady: state.templateOutputReady,
    lastError: state.lastError,
  });
}

function showBubble() {
  if (!bubbleWindow || bubbleWindow.isDestroyed()) return;
  if (!bubbleWindow.isVisible()) bubbleWindow.show();
  bubbleWindow.webContents.send("bubble:update", {
    captureRunning: state.captureRunning,
    captureBusy: state.captureBusy,
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
  mainWindow.on("closed", () => {
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

function recomputeOutput() {
  if (!state.templateMatrix.length || !state.erpMap.size || !state.capturedMap.size) {
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
  return { filePath, count: map.size, outputReady: state.templateOutputReady };
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

async function toggleCapture() {
  state.captureRunning = !state.captureRunning;
  state.lastError = "";
  if (state.captureRunning) {
    showBubble();
  } else {
    hideBubble();
  }
  sendState();
  return { captureRunning: state.captureRunning };
}

async function runCapture() {
  if (!state.captureRunning) {
    throw new Error("请先开启开始爬取。");
  }

  state.captureBusy = true;
  state.lastError = "";
  showBubble();
  sendState();

  try {
    const rows = await captureVisibleOrders({
      clipboardText: clipboard.readText(),
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

    state.captureBusy = false;
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
    state.lastError = error.message || String(error);
    sendState();
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
    capturedRows: state.capturedRows,
    erpFilePath: state.erpFilePath,
    templateFilePath: state.templateFilePath,
    outputReady: state.templateOutputReady,
    lastError: state.lastError,
  }));

  ipcMain.handle("capture:toggle", async () => toggleCapture());
  ipcMain.handle("capture:run", async () => runCapture());

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
    if (result.canceled || !result.filePath) return { canceled: true };
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
