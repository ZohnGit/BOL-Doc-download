const screenshot = require("screenshot-desktop");
const { parseOrdersFromText } = require("../shared/parsers");

function waitForAbort(signal) {
  if (!signal) return Promise.resolve(false);
  if (signal.aborted) {
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      resolve(true);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function captureVisibleOrders({ clipboardText = "", signal } = {}) {
  let recognizedText = "";

  const textFromClipboard = String(clipboardText || "").trim();
  if (textFromClipboard) {
    const rows = parseOrdersFromText(textFromClipboard);
    if (rows.length > 0) {
      return rows;
    }
  }

  if (signal?.aborted) {
    throw new Error("已中止爬取");
  }

  let image;
  try {
    image = await Promise.race([screenshot({ format: "png" }), waitForAbort(signal)]);
    if (image === true) {
      throw new Error("已中止爬取");
    }
  } catch (error) {
    throw error;
  }

  const { createWorker } = await import("tesseract.js");
  const worker = await createWorker("eng");
  let aborted = false;

  const release = () => {
    if (signal && signal.aborted) {
      aborted = true;
      worker.terminate();
    }
  };

  signal?.addEventListener("abort", release, { once: true });

  try {
    const result = await Promise.race([
      worker.recognize(image),
      waitForAbort(signal).then(() => {
        release();
        throw new Error("已中止爬取");
      }),
    ]);
    recognizedText = result?.data?.text || "";
  } finally {
    signal?.removeEventListener("abort", release);
    await worker.terminate();
  }

  if (aborted || signal?.aborted) {
    throw new Error("已中止爬取");
  }

  const sourceText = recognizedText.trim();
  if (!sourceText) {
    throw new Error("没有识别到可抓取的数据。请确认当前页面可见内容清晰，或先复制页面文本后重试。");
  }

  return parseOrdersFromText(sourceText);
}

module.exports = {
  captureVisibleOrders,
};
