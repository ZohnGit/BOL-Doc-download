const fs = require("node:fs");
const XLSX = require("xlsx");

function normalizeHeader(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[()（）]/g, "");
}

function findHeaderIndex(headers, candidates) {
  const normalizedCandidates = candidates.map(normalizeHeader);
  return headers.findIndex((header) => normalizedCandidates.includes(normalizeHeader(header)));
}

function readXlsxAsMatrix(filePath) {
  const workbook = XLSX.readFile(filePath, { cellDates: true });
  const sheetName = workbook.SheetNames[0];
  const matrix = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], {
    header: 1,
    raw: false,
    defval: "",
  });
  return { workbook, sheetName, matrix };
}

function parseRowsToMap(rows, keyIndex, valueIndex) {
  const map = new Map();
  for (const row of rows) {
    const key = String(row[keyIndex] ?? "").trim();
    const value = String(row[valueIndex] ?? "").trim();
    if (key) {
      map.set(key, value);
    }
  }
  return map;
}

function buildOrderMap(rows) {
  const map = new Map();
  for (const row of rows) {
    if (!row || !row.orderNum) continue;
    map.set(row.orderNum, row);
  }
  return map;
}

function fillTemplateWorkbook({ templateMatrix, erpMap, capturedMap }) {
  if (!templateMatrix.length) return [];
  const matrix = templateMatrix.map((row) => row.slice());
  const headers = matrix[0].map(normalizeHeader);

  let orderIndex = findHeaderIndex(headers, ["订单号", "order_no", "ordernum", "refrence_no_platform", "reference_no_platform"]);
  let trackingIndex = findHeaderIndex(headers, ["跟踪号", "tracking", "tracking_no", "物流单号"]);
  let timeIndex = findHeaderIndex(headers, ["发货时间", "shiptime", "ship_time", "shippingtime"]);

  if (orderIndex < 0) orderIndex = 0;
  if (trackingIndex < 0) {
    trackingIndex = matrix[0].length;
    matrix[0].push("跟踪号");
  }
  if (timeIndex < 0) {
    timeIndex = matrix[0].length;
    matrix[0].push("发货时间");
  }

  const capturedByOrder = buildOrderMap(Array.from(capturedMap.values()));

  for (let rowIndex = 1; rowIndex < matrix.length; rowIndex += 1) {
    const row = matrix[rowIndex];
    const orderNo = String(row[orderIndex] ?? "").trim();
    if (!orderNo) continue;
    const erpNo = erpMap.get(orderNo) || orderNo;
    const captured = capturedByOrder.get(erpNo) || capturedByOrder.get(orderNo);
    row[trackingIndex] = captured ? captured.trackingNumber || "" : "";
    row[timeIndex] = captured ? captured.time || "" : "";
  }

  return matrix;
}

function writeWorkbookToFile(workbook, filePath) {
  const dir = require("node:path").dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  XLSX.writeFile(workbook, filePath, { bookType: "xlsx" });
}

module.exports = {
  buildOrderMap,
  fillTemplateWorkbook,
  findHeaderIndex,
  normalizeHeader,
  parseRowsToMap,
  readXlsxAsMatrix,
  writeWorkbookToFile,
};

