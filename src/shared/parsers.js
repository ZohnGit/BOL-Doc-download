function normalizeSku(raw) {
  const text = String(raw || "").trim().replace(/\s+/g, " ");
  if (!text) return "";
  const parts = text.split("-").map((part) => part.trim()).filter(Boolean);
  if (parts.length <= 1) return text.replace(/^AO\s*/i, "").trim();
  if (parts.length === 2) {
    if (/^AO$/i.test(parts[0])) return parts[1];
    return parts[0];
  }
  return parts.slice(1, -1).join("-");
}

function normalizeTracking(raw) {
  const text = String(raw || "").trim().replace(/\s+/g, " ");
  if (!text) return "";
  const parts = text.split("-").map((part) => part.trim()).filter(Boolean);
  if (parts.length <= 1) {
    const slashIndex = text.lastIndexOf("/");
    return slashIndex >= 0 ? text.slice(slashIndex + 1).trim() : text;
  }
  return parts[parts.length - 1];
}

function normalizeTime(raw) {
  const text = String(raw || "").trim().replace(/\s+/g, " ");
  const match = text.match(/(\d{1,2})\s+([A-Za-z]+)\s+at\s+(\d{1,2}):(\d{2})/i);
  if (!match) return text;
  const day = String(match[1]).padStart(2, "0");
  const month = monthToNumber(match[2]);
  const hour = String(match[3]).padStart(2, "0");
  const minute = match[4];
  const year = new Date().getFullYear();
  return `${year}/${month}/${day} ${hour}:${minute}`;
}

function monthToNumber(monthName) {
  const map = {
    january: "01",
    february: "02",
    march: "03",
    april: "04",
    may: "05",
    june: "06",
    july: "07",
    august: "08",
    september: "09",
    october: "10",
    november: "11",
    december: "12",
  };
  return map[String(monthName || "").toLowerCase()] || "01";
}

function cleanText(text) {
  return String(text || "")
    .replace(/\u00a0/g, " ")
    .replace(/\r/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function extractBlocks(text) {
  const normalized = cleanText(text);
  const blockMatches = [...normalized.matchAll(/\bC[A-Z0-9]{6,12}\b[\s\S]*?(?=(?:\n\s*C[A-Z0-9]{6,12}\b)|$)/g)];
  if (blockMatches.length) {
    return blockMatches.map((match) => match[0].trim()).filter(Boolean);
  }
  return normalized
    .split(/\n{2,}/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseCardBlock(block) {
  const lines = block
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const joined = lines.join(" ");

  const orderMatch = joined.match(/\bC[A-Z0-9]{8,12}\b/);
  if (!orderMatch) return null;

  const timeMatch = joined.match(/\b\d{1,2}\s+[A-Za-z]+\s+at\s+\d{1,2}:\d{2}\b/i);
  const skuMatch = joined.match(/\bAO-[A-Z0-9-]+\b/i);

  const trackingLine =
    lines.find((line) => /-\s*[A-Z0-9]{6,}/.test(line) && !/AO-/i.test(line)) ||
    lines.find((line) => /[A-Z]{2,}[A-Z0-9-]*\s*-\s*[A-Z0-9-]+/i.test(line)) ||
    "";

  let buyerName = "";
  const orderIndex = lines.findIndex((line) => line.includes(orderMatch[0]));
  for (let i = orderIndex + 1; i < lines.length; i += 1) {
    const candidate = lines[i];
    if (/^\d{1,2}\s+[A-Za-z]+\s+at\s+\d{1,2}:\d{2}$/i.test(candidate)) continue;
    if (/^Logistics via bol/i.test(candidate)) continue;
    if (/^AO-/i.test(candidate)) continue;
    if (/^[A-Z0-9\s/-]+$/i.test(candidate) && candidate.length > 18) continue;
    buyerName = candidate;
    break;
  }

  return {
    orderNum: orderMatch[0],
    buyerName: buyerName || "",
    time: normalizeTime(timeMatch ? timeMatch[0] : ""),
    trackingNumber: normalizeTracking(trackingLine),
    sku: normalizeSku(skuMatch ? skuMatch[0] : lines.find((line) => /AO-/i.test(line)) || ""),
    rawBlock: block,
  };
}

function parseOrdersFromText(text) {
  const blocks = extractBlocks(text);
  const rows = [];
  for (const block of blocks) {
    const row = parseCardBlock(block);
    if (row && row.orderNum) {
      rows.push(row);
    }
  }
  return rows;
}

module.exports = {
  normalizeSku,
  normalizeTracking,
  normalizeTime,
  parseOrdersFromText,
};

