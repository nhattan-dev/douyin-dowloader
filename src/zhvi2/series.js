/**
 * series init v2 — dựng dàn nhân vật MỘT task todo, chỉ từ lời thoại.
 *
 * Khác v1 (pass A từng tập + B2b trên cụm giọng) ở hai chỗ, đều có chủ ý:
 *   - Không pass A: todo LLM đọc hiểu được qua lỗi ASR; tên nghe nhầm đi vào `alias`. Sửa ASR thật
 *     là việc của task U từng tập.
 *   - Không cụm giọng: cụm là của audio và thuộc về TẬP (cổng soát từng tập lo), bible không giữ cụm.
 *     Thứ duy nhất bước sau cần ở cụm là "câu nào nhân vật này đang nói" để cắt khung tả `look` —
 *     task khai thẳng bằng `speaks` (vài câu chắc chắn, suy từ lời).
 *
 * Code chỉ kiểm, không tự sửa: `check` trả lỗi để hỏi lại; còn sót thì `validateDraft` bỏ và ghi doubt.
 */
import { rawLines } from "./understand.js";

// Trần ký tự kịch bản gửi đi — cùng trần với lượt gộp v1 (dưới 100k của hàng đợi).
const MAX_SCRIPT_CHARS = 90_000;
const NON_DIALOGUE_NAMES = new Set(["旁白"]);
const t1 = (x) => Number(x).toFixed(1);

/** Tập cho init v2: câu lấy thẳng từ transcript, cùng số câu với task U của runEpisode. */
export function episodeLines(transcript) {
  return rawLines(transcript).map(({ words, ...l }) => l);
}

export function context(eps, episodes = [], { pinned = null, log = null } = {}) {
  let keep = 1;
  const total = eps.reduce((n, d) => n + d.utts.reduce((k, u) => k + u.zh.length + 20, 0), 0);
  if (total > MAX_SCRIPT_CHARS) {
    keep = MAX_SCRIPT_CHARS / total;
    log?.warn?.(`kịch bản ${eps.length} tập dài ${total} ký tự — cắt còn ~${Math.round(keep * 100)}% mỗi tập`);
  }
  return {
    videos: episodes.map((e) => ({
      ep: e.use ? String(e.ep) : null, title: e.title || "", tags: e.tags || [],
    })),
    pinnedTerms: pinned || {},
    episodes: eps.map((d) => {
      const n = Math.floor(d.utts.length * keep);
      return {
        ep: String(d.ep),
        title: d.episode?.title || "",
        // mốc thời gian như bản fleex đưa Sonnet trong chat: khoảng lặng dài = chuyển cảnh
        script: d.utts.slice(0, n).map((u) => `#${u.id} ${t1(u.start)}-${t1(u.end)} ${u.zh}`)
          .concat(n < d.utts.length ? [`… (cắt ${d.utts.length - n} câu cuối cho vừa ngân sách)`] : []),
      };
    }),
  };
}

export function schema() {
  const str = { type: "string" };
  const obj = (props) => ({ type: "object", additionalProperties: false, required: Object.keys(props), properties: props });
  return obj({
    series: obj({ titleZh: str, titleVi: str }),
    cast: {
      type: "array",
      items: obj({
        id: str, zh: { type: "string", minLength: 1 }, vi: str, viShort: str,
        gender: { enum: ["male", "female", "?"] },
        role: { enum: ["main", "episodic", "mentioned"] },
        alias: { type: "array", items: str },
        note: str, doubt: str,
        speaks: { type: "array", items: obj({ ep: str, lines: { type: "array", items: { type: "integer" } } }) },
      }),
    },
    terms: { type: "array", items: obj({ zh: { type: "string", minLength: 1 }, vi: { type: "string", minLength: 1 } }) },
    address: {
      type: "array",
      items: obj({ from: str, to: str, self: str, other: str, fromEp: str, why: str }),
    },
    doubts: { type: "array", items: str },
  });
}

/** Lỗi code kiểm được — trả về để hỏi lại. Rỗng là đạt. */
export function check(o, eps) {
  const errs = [];
  const byEp = new Map(eps.map((d) => [String(d.ep), new Set(d.utts.map((u) => u.id))]));
  const text = eps.map((d) => d.utts.map((u) => u.zh).join("\n")).join("\n");
  const seen = (s) => Boolean(s) && (text.includes(s) || NON_DIALOGUE_NAMES.has(s));
  const ids = new Set();
  for (const c of o.cast || []) {
    if (ids.has(c.id)) errs.push(`cast: id ${c.id} trùng`);
    ids.add(c.id);
    if (!seen(c.zh) && !(c.alias || []).some(seen)) {
      errs.push(`cast ${c.id}: cả "${c.zh}" lẫn mọi alias đều không có nguyên văn trong kịch bản`);
    }
    for (const s of c.speaks || []) {
      const have = byEp.get(String(s.ep));
      if (!have) {
        errs.push(`cast ${c.id}: speaks trỏ tập ${s.ep} không có`);
        continue;
      }
      const bad = (s.lines || []).filter((i) => !have.has(i));
      if (bad.length) errs.push(`cast ${c.id}: tập ${s.ep} không có câu #${bad.join(", #")}`);
    }
  }
  for (const a of o.address || []) {
    if (!ids.has(a.from) || !ids.has(a.to)) errs.push(`address ${a.from}→${a.to}: id không có trong cast`);
  }
  const bad = (o.terms || []).filter((t) => !text.includes(t.zh)).map((t) => t.zh);
  if (bad.length) errs.push(`terms: không có nguyên văn trong kịch bản: ${bad.join(", ")}`);
  return errs;
}

/**
 * Đầu ra của task -> đúng hình dạng `validateDraft` nhận (như B2b của v1), với `speaks` thay `clusters`.
 * `validateDraft` vẫn là chốt kiểm cuối: thứ còn sai sau các lượt hỏi lại bị bỏ và thành doubt.
 */
export function toMerged(o) {
  return {
    series: o.series || {},
    cast: (o.cast || []).map((c) => ({
      ...c,
      speaks: Object.fromEntries((c.speaks || []).filter((s) => s.lines?.length).map((s) => [String(s.ep), s.lines])),
    })),
    terms: Object.fromEntries((o.terms || []).map((t) => [t.zh, t.vi])),
    address: o.address || [],
    doubts: o.doubts || [],
  };
}
