/**
 * Rào phiên âm: một bản sửa ASR phải đọc GẦN GIỐNG thứ đã nghe được.
 *
 * Cổng port từ `zhvi/phon.py`. Hai ràng buộc trong `suspects()` là kết quả đo, không
 * phải trực giác — bỏ cái nào cũng hỏng theo kiểu riêng, xem chú thích tại chỗ.
 */
import { readFileSync } from "node:fs";

import { pinyin } from "pinyin-pro";
import { Jieba } from "@node-rs/jieba";

const HAN = /[一-鿿]/;
const isHan = (c) => HAN.test(c);

/** Phiên âm không dấu thanh, chỉ lấy phần chữ Hán — so âm chứ không so mặt chữ. */
export function py(s) {
  const han = [...(s || "")].filter(isHan).join("");
  if (!han) return "";
  return pinyin(han, { toneType: "none", type: "array", nonZh: "removed" }).join("");
}

export function lev(a, b) {
  if (a === b) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur.push(Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] !== b[j - 1] ? 1 : 0)));
    }
    prev = cur;
  }
  return prev[b.length];
}

/** 1.0 = đọc y hệt. Sửa mỗi dấu câu / ranh giới câu cũng ra 1.0. */
export function sim(a, b) {
  const pa = py(a), pb = py(b);
  if (!pa && !pb) return 1.0;
  if (!pa || !pb) return 0.0;
  return 1 - lev(pa, pb) / Math.max(pa.length, pb.length);
}

// @node-rs/jieba không có `insertWord`, và `loadDict` THAY từ điển chính chứ không bổ sung
// (đo được: gọi nó với 4 tên riêng xong thì 闯进魔云洞 bị cắt thành từng chữ một, và mọi mảnh
// vắt qua hai từ lọt hết vào danh sách nghi). Nên phải nối từ vựng phim vào SAU từ điển gốc
// của package rồi dựng lại Jieba. Tần suất cao để tên riêng thắng cách cắt mặc định.
const DICT = readFileSync(new URL("../../node_modules/@node-rs/jieba/dict.txt", import.meta.url));
let _jieba = null;
let _added = new Set();
function cuts(text, vocab) {
  // Dòng từ điển là `từ tần-suất loại` cách nhau bằng dấu cách: một khoá có khoảng trắng (nhân vật
  // thêm tay ở trang bible để trống chữ Hán nên khoá lấy tên Việt, «nhiều người») làm cả từ điển hỏng.
  const want = [...vocab].filter((w) => [...w].length > 1 && !/\s/.test(w));
  if (!_jieba || want.some((w) => !_added.has(w))) {
    _added = new Set(want);
    _jieba = Jieba.withDict(
      Buffer.concat([DICT, Buffer.from("\n" + want.map((w) => `${w} 100000 n`).join("\n") + "\n", "utf8")]),
    );
  }
  const out = new Set([0]);
  let p = 0;
  for (const tok of _jieba.cut(text, false)) {
    p += [...tok].length;
    out.add(p);
  }
  return out;
}

/**
 * Chỗ nào trong text đọc GẦN GIỐNG một mục trong vocab nhưng viết khác -> nghi lỗi ASR.
 *
 * Code quét được đầy đủ chỗ mà model tự rà hay bỏ sót (recall model đo được 4/6).
 * Hai ràng buộc giữ cho danh sách dùng được, thiếu cái nào cũng hỏng:
 *   - VỊ TRÍ: lỗi ASR chỉ nghe sai vài chữ, phần còn lại đúng nguyên chỗ
 *     (面修/面首, 结束/结局). Không có nó thì bigram nào cũng khớp: đo được 250 gợi ý.
 *   - RANH GIỚI TỪ: ứng viên phải trùng khít một hoặc vài từ. Không có nó thì các mảnh
 *     vắt qua hai từ lọt vào (闯进+魔云洞 -> "进魔" ≈ "心魔") và model sửa theo là vỡ câu:
 *     đo được 6/8 chỗ vốn đúng bị phá.
 * Dùng đúng vocab của bộ phim (bible) nên các tập dịch rời vẫn nhất quán tên riêng.
 */
export function suspects(text, vocab, { minSim = 0.25, keep = 0.5 } = {}) {
  const chars = [...text];
  const ok = cuts(text, vocab);
  const out = new Map();
  for (const term of vocab) {
    const t = [...term];
    const n = t.length;
    if (n < 2 || !t.every(isHan)) continue;
    for (let i = 0; i + n <= chars.length; i++) {
      if (!ok.has(i) || !ok.has(i + n)) continue;
      const w = chars.slice(i, i + n);
      const ws = w.join("");
      if (ws === term || !w.every(isHan)) continue;
      const same = w.filter((c, k) => c === t[k]).length;
      if (same < Math.max(1, Math.floor(n * keep))) continue;
      const diffTooFar = w.some((c, k) => c !== t[k] && sim(c, t[k]) < minSim);
      if (diffTooFar) continue;
      const sc = sim(ws, term);
      const cur = out.get(ws);
      if (!cur || sc > cur.score) out.set(ws, { term, score: sc });
    }
  }
  return new Map([...out.entries()].sort((a, b) => b[1].score - a[1].score));
}
