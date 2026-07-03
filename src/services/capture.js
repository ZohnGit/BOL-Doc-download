const screenshot = require("screenshot-desktop");
const { parseOrdersFromText } = require("../shared/parsers");

async function captureVisibleOrders({ clipboardText = "" } = {}) {
  let recognizedText = "";

  try {
    const image = await screenshot({ format: "png" });
    const { createWorker } = await import("tesseract.js");
    const worker = await createWorker("eng");
    try {
      const result = await worker.recognize(image);
      recognizedText = result?.data?.text || "";
    } finally {
      await worker.terminate();
    }
  } catch (_error) {
    recognizedText = "";
  }

  const sourceText = recognizedText.trim() || String(clipboardText || "").trim();
  if (!sourceText) {
    throw new Error("没有识别到可抓取的数据。请确认当前页面可见内容清晰，或先复制页面文本后重试。");
  }

  return parseOrdersFromText(sourceText);
}

module.exports = {
  captureVisibleOrders,
};

