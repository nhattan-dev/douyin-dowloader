/**
 * Pass A — sửa ASR (zh → zh). Nguyên bản do code giữ, model chỉ khai báo sửa gì.
 *
 * Chia 4 công đoạn con vì chúng hỏng và đổi độc lập nhau:
 *   A1 clusters  nhãn cụm giọng lấy từ qwenSpeakerId          (code, miễn phí)
 *   A2 ops       model đọc kịch bản, khai một danh sách sửa   (LLM)
 *   A3 scan      code quét theo phiên âm, model phán đúng/sai (LLM)
 *   A4 apply     áp thao tác + gắn lại mốc thời gian          (code, miễn phí)
 *
 * Tách A3 khỏi A2 là chỗ tách có lãi thật: luật quét phiên âm còn phải chỉnh nhiều,
 * mà chỉnh nó thì không có lý do gì phải trả tiền lại cho A2.
 */
import { CharClock } from "../clock.js";
import { jparse } from "../llm.js";
import { applyOps } from "../ops.js";
import { py, sim, suspects } from "../phon.js";
import { REPAIR_OPS_SYS, REPAIR_SCAN_SYS } from "../prompts.js";

/** Chỉ có modification-list ở đầu ra nên nhẹ hơn bản viết-lại ~3 lần: một tập gọn 1 lượt. */
export function planOpsChunks(segments, { outBudget = 6000, tokPerChar = 2.5, floor = 40 } = {}) {
  const est = segments.reduce((n, s) => n + s.text.length, 0) * tokPerChar;
  if (est <= outBudget) return segments.length;
  return Math.max(floor, Math.ceil(segments.length / Math.ceil(est / outBudget)));
}

export function chunk(items, n) {
  const out = [];
  for (let i = 0; i < items.length; i += n) out.push(items.slice(i, i + n));
  return out;
}

/**
 * A1 — Nhãn cụm giọng phải lấy từ `qwenSpeakerId`, KHÔNG lấy từ `speaker`.
 *
 * Vì chính zhvi ghi ngược tên nhân vật vào `transcript.json:speaker` khi chạy với
 * --data-dir. Chạy lần hai trên cùng một tập thì pass A ăn lại đầu ra của chính mình
 * làm cụm giọng: xương sống của pass B biến mất, mà không có lỗi nào nổ ra — đo được
 * ở tập 2, cụm hoá thành "小钻风"/"白骨夫人" và cụm S1 gãy làm hai.
 * `qwenSpeakerId` là của filetrans, không ai ghi đè lên nó.
 */
export function clusterLabels(segments) {
  if (!segments.some((s) => s.qwenSpeakerId !== undefined && s.qwenSpeakerId !== null)) return segments;
  return segments.map((s) =>
    s.qwenSpeakerId !== undefined && s.qwenSpeakerId !== null ? { ...s, speaker: `S${s.qwenSpeakerId}` } : s,
  );
}

/** A2 — một lượt gọi cho một lô segment. Op hỏng bị loại riêng, không gọi lại cả mẻ. */
export async function opsCall(llm, chunkSegs, { model, maxRetry = 2 }) {
  const payload = chunkSegs.map((s, i) => ({
    i, sp: s.speaker ?? null, t: Math.round(s.start * 10) / 10, zh: s.text, py: py(s.text),
  }));
  const msgs = [
    { role: "system", content: REPAIR_OPS_SYS },
    { role: "user", content: JSON.stringify(payload) },
  ];
  let last = "";
  for (let attempt = 0; attempt <= maxRetry; attempt++) {
    const r = await llm.chat(model, msgs, { jsonMode: true, maxTokens: 8000, temperature: 0 });
    try {
      return jparse(r.text).ops || [];
    } catch (e) {
      last = `JSON 解析失败：${e.message}。只输出 {"ops":[...]}。`;
      msgs.push({ role: "assistant", content: r.text }, { role: "user", content: last });
    }
  }
  throw new Error(`repair-ops: không đọc được JSON sau ${maxRetry + 1} lượt — ${last}`);
}

/**
 * A3 — vòng 2: code đưa danh sách nghi vấn quét theo phiên âm, model chỉ phán đúng/sai.
 *
 * Model tự rà cả kịch bản chỉ bắt được 4/6 lỗi đã biết; ba lỗi còn sót đều nằm trong
 * danh sách code quét ra, nên phần recall để code làm, phần phán đoán để model làm.
 */
export async function scanCall(llm, units, vocab, { model }) {
  const cand = vocab && vocab.length ? suspects(units.map((u) => u.text).join(""), vocab) : new Map();
  if (!cand.size) return [];
  const rows = [];
  for (const [w, { term }] of cand) {
    for (const u of units) {
      if (u.text.includes(w)) rows.push({ u: u.ref, 词: w, 本剧词表里读音相近的: term, 整句: u.text });
    }
  }
  if (!rows.length) return [];
  const msgs = [
    { role: "system", content: REPAIR_SCAN_SYS },
    { role: "user", content: "逐条判断：\n" + JSON.stringify(rows, null, 1) },
  ];
  const r = await llm.chat(model, msgs, { jsonMode: true, maxTokens: 4000, temperature: 0 });
  try {
    return (jparse(r.text).ops || []).filter((o) => o.op === "replace");
  } catch {
    return [];
  }
}

/**
 * A4 — áp thao tác lên nguyên bản rồi gắn lại mốc thời gian.
 * Thuần code: mất câu / lặp câu / chèn bình luận là không thể xảy ra ở đây.
 */
export function applyAll(segments, opsPerChunk, size, words) {
  const clock = new CharClock(segments, words);
  const units = [];
  const dropped = [];
  let base = 0;
  let off0 = 0;

  chunk(segments, size).forEach((grp, gi) => {
    const { units: us, bad } = applyOps(grp, opsPerChunk[gi] || []);
    dropped.push(...bad);
    for (const u of us) {
      u.seg = u.seg.map((i) => i + base);
      u.a += off0;
      u.b += off0;
    }
    units.push(...us);
    base += grp.length;
    off0 += grp.reduce((n, s) => n + s.text.length, 0);
  });

  const out = units.map((u, n) => {
    const [st, en] = clock.span(u.a, u.b);
    const asr = u.seg.map((i) => segments[i]?.speaker);
    const risky = u.edits.filter((e) => sim(e.from, e.to) < 0.6);
    const conf = u.edits.length ? Math.min(...u.edits.map((e) => e.conf ?? 1)) : 1;
    return {
      id: n, speaker: u.speaker, start: st, end: en,
      zh_raw: u.raw, zh: u.text, segmentIndexes: u.seg,
      speakerSource: asr.includes(u.speaker) ? "qwen" : "llm-repair",
      edits: u.edits, conf, note: u.note,
      review: risky, aligned: true,
    };
  });
  return { utts: out, dropped };
}
