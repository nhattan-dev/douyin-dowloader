import fs from "node:fs/promises";
import path from "node:path";

import OpenAI from "openai";

import { logApiCall, OPENAI_V1 } from "./apiLog.js";
import { config, paths } from "./config.js";
import { createLogger } from "./logger.js";

const log = createLogger("SPEAKERS");

/**
 * Liệt kê những nhãn do LLM suy ra, kèm ngữ cảnh trước/sau để soát nhanh.
 *
 * Bắt buộc phải có trước khi đem đi lồng tiếng: nhãn `inferred` là suy đoán từ nội
 * dung chứ không phải nhận dạng giọng, và gán sai giọng giữa cảnh chiến đấu thì
 * nghe ra ngay.
 */
export async function reviewSpeakers(userId, videoIds) {
  let total = 0;
  for (const videoId of videoIds) {
    let transcript;
    try {
      transcript = JSON.parse(
        await fs.readFile(path.join(paths.videoDir(userId, videoId), "transcript.json"), "utf8"),
      );
    } catch {
      continue;
    }
    const segs = transcript.segments ?? [];
    const flagged = segs.map((s, i) => ({ ...s, i })).filter((s) => s.speakerSource === "inferred");
    if (flagged.length === 0) continue;

    console.log(`\n${videoId} — ${flagged.length}/${segs.length} nhãn suy đoán`);
    for (const s of flagged) {
      const before = segs[s.i - 1];
      const after = segs[s.i + 1];
      if (before) console.log(`     ${String(before.speaker ?? "—").padEnd(12)} ${before.text}`);
      console.log(`  →  ${String(s.speaker).padEnd(12)} ${s.text}   [${s.start.toFixed(1)}s]`);
      if (after) console.log(`     ${String(after.speaker ?? "—").padEnd(12)} ${after.text}`);
      console.log();
    }
    total += flagged.length;
  }
  if (total === 0) console.log("Không có nhãn suy đoán nào cần soát.");
  else console.log(`Tổng ${total} nhãn cần soát. Sai thì sửa thẳng trong transcript.json.`);
  return total;
}

/**
 * Suy nhãn cho những segment diarize bỏ trống.
 *
 * Cần vì mục tiêu là lồng tiếng: segment nào cũng phải gán được một giọng, kể cả
 * `杀!` giữa cảnh chiến đấu. Diarize không nhận dạng được vùng nhạc/hiệu ứng chạy
 * liên tục — đã thử cắt riêng vùng đó gọi lại, vẫn không ra.
 *
 * Suy từ mạch hội thoại: truyện có logic (ai đang trong cảnh, ai đáp ai). Kết quả
 * đánh dấu `speakerSource: "inferred"` để `review-speakers` lọc ra soát lại.
 */
export async function inferMissingSpeakers(segments) {
  const missing = segments.map((s, i) => (s.speaker ? null : i)).filter((i) => i !== null);
  if (missing.length === 0) return segments;

  const known = [...new Set(segments.map((s) => s.speaker).filter(Boolean))];
  if (known.length === 0) {
    log.warn("không có nhãn nào làm mốc — bỏ qua bước suy nhãn");
    return segments;
  }

  const numbered = segments
    .map((s, i) => `${i + 1}. [${s.speaker ?? "?"}] ${s.text}`)
    .join("\n");

  const openai = new OpenAI({
    apiKey: config.openaiApiKey,
    maxRetries: config.sttMaxRetries,
    timeout: config.sttTimeoutMs,
  });

  const params = {
    model: config.translateModel,
    temperature: 0,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: [
          "Bạn phân định người nói trong lời thoại truyện tiên hiệp Trung Quốc.",
          `Các người nói đã biết: ${known.join(", ")}.`,
          "Mỗi dòng có dạng `số. [người nói] nội dung`. Dòng nào là [?] thì bạn phải xác định.",
          "Suy từ mạch hội thoại: ai đang trong cảnh, ai đáp lời ai, ai xưng hô thế nào.",
          "CHỈ chọn trong danh sách người nói đã biết, không tạo tên mới.",
          'Trả JSON: {"assignments": [{"line": <số dòng>, "speaker": "<tên>"}]}',
          "Chỉ liệt kê các dòng [?], không liệt kê dòng đã có nhãn.",
        ].join("\n"),
      },
      { role: "user", content: numbered },
    ],
  };

  const res = await logApiCall(log, { url: `${OPENAI_V1}/chat/completions`, body: params }, () =>
    openai.chat.completions.create(params),
  );

  let assignments = [];
  try {
    assignments = JSON.parse(res.choices[0]?.message?.content ?? "{}").assignments ?? [];
  } catch (err) {
    log.warn(`không đọc được kết quả suy nhãn: ${err.message}`);
    return segments;
  }

  const out = segments.map((s) => ({ ...s }));
  let filled = 0;
  for (const a of assignments) {
    const idx = Number(a.line) - 1;
    // Chỉ nhận nhãn nằm trong danh sách đã biết và đúng dòng còn trống — model
    // đôi khi ghi đè cả dòng đã có nhãn hoặc bịa tên mới.
    if (!out[idx] || out[idx].speaker || !known.includes(a.speaker)) continue;
    out[idx].speaker = a.speaker;
    out[idx].speakerSource = "inferred";
    filled += 1;
  }

  log.info(`suy được ${filled}/${missing.length} nhãn còn trống`);
  return out;
}
