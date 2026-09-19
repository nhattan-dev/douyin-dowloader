/**
 * Pass A dạng THAO TÁC CÓ KIỂU: model không viết lại kịch bản, chỉ khai báo chỗ cần sửa.
 *
 * Lý do đổi hợp đồng (đo được, xem DESIGN.md): khi model trả về bản viết lại, bản đó
 * không có neo cấu trúc nào — nó tự do xoá câu, lặp câu, chèn chú thích, thêm rác `**`.
 * Mỗi kiểu hỏng lại phải thêm một bộ dò riêng (đã phải thêm 5 bộ) và bộ dò nào cũng có
 * ngưỡng sai. Ở đây code sở hữu văn bản nguồn; model chỉ được nói SỬA GÌ, nên mất nội
 * dung / lặp nội dung / chèn bình luận là KHÔNG THỂ XẢY RA, không phải "bị phát hiện sau".
 *
 * Thao tác (đơn vị tham chiếu `u`: số nguyên = segment, chuỗi "i.k" = mảnh k của segment i):
 *   {"op":"split",   "u":2, "parts":["前半。","后半。"]}   tách một segment thành nhiều câu
 *   {"op":"merge",   "u":[0,1]}                            gộp các đơn vị liền kề
 *   {"op":"replace", "u":7, "from":"面修","to":"面首","why":"同音"}
 *   {"op":"punct",   "u":4, "to":"？"}                     đổi dấu cuối câu
 *   {"op":"speaker", "u":2, "to":"S2"}
 *   {"op":"note",    "u":2, "text":"转述牛魔王的话"}
 *
 * Thứ tự áp dụng do code quyết định: split -> merge -> replace -> punct -> speaker -> note.
 */
import { sim } from "./phon.js";

const PUNCT = "。，？！";
const BARE_ONE = /^[^㐀-鿿豈-﫿0-9A-Za-z]$/;
const BARE_ALL = /[^㐀-鿿豈-﫿0-9A-Za-z]/g;
const PRON = new Set("我你妳他她它您咱俺");
const MIN_SIM = 0.2; // 面修->面首 chỉ được 0.25; đổi nghĩa (东西->宝物) rơi về 0.0

/** Thao tác không áp được lên nguồn. Thông điệp bằng tiếng Trung để trả thẳng cho model. */
export class OpError extends Error {}

export const bare = (t) => (t || "").replace(BARE_ALL, "");

const rstrip = (s, chars) => {
  let i = s.length;
  while (i > 0 && chars.includes(s[i - 1])) i--;
  return s.slice(0, i);
};

/**
 * Cắt phần đầu/đuôi giống nhau -> chỉ còn đúng chỗ model thật sự đổi.
 *
 * Bắt buộc phải so trên phần này: so cả chuỗi thì 父王留给我的这些东西->...宝物 được
 * 0.79 (cao hơn cả bản sửa đúng 面修->面首 = 0.63) vì phần giống nhau kéo điểm lên.
 */
export function delta(a, b) {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  let j = 0;
  while (j < a.length - i && j < b.length - i && a[a.length - 1 - j] === b[b.length - 1 - j]) j++;
  return [a.slice(i, a.length - j), b.slice(i, b.length - j)];
}

/**
 * Phân loại một replace và kiểm luật của đúng loại đó. Ném OpError nếu không thuộc loại nào.
 *
 * Sửa lỗi ASR chỉ có hai kiểu hợp lệ: nghe nhầm chữ (phải gần âm) và nhầm đại từ nhân xưng
 * (你/我/他 — không gần âm nhưng tập rất hẹp). Mọi thứ khác là model tự ý đổi nội dung.
 */
export function kindOf(a, b) {
  const [da, db] = delta(a, b);
  if (!bare(da) && !bare(db)) {
    throw new OpError(`replace "${a}"->"${b}" 只动了标点。标点请用 punct 或 split，不要用 replace。`);
  }
  if (!bare(da)) {
    throw new OpError(
      `replace "${a}"->"${b}" 是在往台词里加字（"${db}"）。ASR 纠错只能改听错的字，不能补敬称、补主语、补说明。`,
    );
  }
  if (!bare(db)) {
    if (bare(da).length > 4) {
      throw new OpError(
        `replace "${a}"->"" 想删掉 ${bare(da).length} 个字。ASR 纠错不许删台词，听不出来就原样保留。`,
      );
    }
    return ["drop", 0.0];
  }
  if (da.length === 1 && db.length === 1 && PRON.has(da) && PRON.has(db)) return ["pronoun", 1.0];
  if (Math.abs(bare(da).length - bare(db).length) > 2) {
    throw new OpError(`replace "${a}"->"${b}" 改动的长度差太多，不像听错，像改写。`);
  }
  const sm = sim(da, db);
  if (sm < MIN_SIM) {
    throw new OpError(
      `replace "${a}"->"${b}" 里 "${da}" 和 "${db}" 读音差太远（${sm.toFixed(2)}），不是听错而是改意思。听不出来就别改。`,
    );
  }
  return ["homophone", sm];
}

/** Chuẩn hoá một tham chiếu đơn vị -> [seg, part|null]. */
function refOf(o, nseg) {
  const u = o.u !== undefined ? o.u : o.i;
  if (Array.isArray(u)) throw new OpError(`op ${o.op} 的 u 必须是单个单元，不能是列表。`);
  if (typeof u === "string" && u.includes(".")) {
    const [a, b] = u.split(".", 2);
    if (!/^\d+$/.test(a) || !/^\d+$/.test(b)) {
      throw new OpError(`单元号 ${JSON.stringify(u)} 格式不对，应为 3 或 "3.1"。`);
    }
    return [parseInt(a, 10), parseInt(b, 10)];
  }
  const i = typeof u === "number" ? u : parseInt(u, 10);
  if (!Number.isInteger(i)) throw new OpError(`op ${o.op} 缺少合法的 u。`);
  if (!(i >= 0 && i < nseg)) throw new OpError(`单元号 ${i} 超出范围 0..${nseg - 1}。`);
  return [i, null];
}

/** Ánh xạ từng mảnh về đúng khoảng ký tự trong nguyên bản (đếm theo ký tự có nghĩa). */
function splitSpans(text, parts, a0) {
  let idx = 0;
  const out = [];
  parts.forEach((p, k) => {
    const need = bare(p).length;
    let got = 0;
    const st = idx;
    while (idx < text.length && got < need) {
      if (!BARE_ONE.test(text[idx])) got++;
      idx++;
    }
    if (k === parts.length - 1) {
      idx = text.length;
    } else {
      // nuốt nốt dấu câu đi liền sau
      while (idx < text.length && BARE_ONE.test(text[idx])) idx++;
    }
    out.push([a0 + st, a0 + idx]);
  });
  return out;
}

/**
 * Áp danh sách thao tác lên segments -> {units, bad}.
 *
 * Mỗi đơn vị: seg (các segment nguồn), ref (cách gọi tên nó), a/b (khoảng ký tự trong
 * nguyên bản toàn phim), raw (nguyên văn), text (sau sửa), speaker, edits, note.
 *
 * Thao tác nào không áp được thì LOẠI RIÊNG thao tác đó, không làm hỏng cả mẻ: bất biến
 * "nội dung không đổi ngoài các replace đã khai báo" đúng với bất kỳ tập con nào của ops,
 * nên bỏ bớt luôn an toàn, còn bắt model gửi lại cả mẻ thì tốn thêm một lượt mà vẫn hay
 * hỏng đúng chỗ cũ (đo được: qwen-flash lặp lại 小肖->小钻风 ở cả hai lượt).
 * strict=true dùng cho test: có op hỏng là ném luôn.
 */
export function applyOps(segments, ops, { strict = false } = {}) {
  if (!Array.isArray(ops)) throw new OpError("ops 必须是数组。");
  const bad = [];

  const guard = (o, fn) => {
    try {
      return fn();
    } catch (e) {
      if (!(e instanceof OpError) || strict) throw e;
      bad.push({ op: o, why: e.message });
      return null;
    }
  };

  const nseg = segments.length;
  const off = [];
  let p = 0;
  for (const s of segments) {
    off.push(p);
    p += s.text.length;
  }

  // ---- 1. split: quyết định ranh giới đơn vị, làm trên NGUYÊN BẢN nên mốc thời gian chính xác
  const cut = new Map();
  const doSplit = (o) => {
    const [i] = refOf(o, nseg);
    const parts = (o.parts || []).filter((x) => String(x).trim());
    if (parts.length < 2) throw new OpError(`split u=${i} 至少要给 2 个 parts。`);
    if (bare(parts.join("")) !== bare(segments[i].text)) {
      throw new OpError(
        `split u=${i} 的 parts 拼起来和原文不符。原文：${segments[i].text}。parts 只能把原文切开、补标点，不能改字、删字、加字。`,
      );
    }
    if (cut.has(i)) throw new OpError(`segment ${i} 被 split 了两次，只能一次（一次给全部 parts）。`);
    // giữ luôn phần chữ model viết ra: nó đã được kiểm chứng là chỉ khác nguyên bản ở dấu câu
    cut.set(
      i,
      splitSpans(segments[i].text, parts, off[i]).map((span, k) => [span, parts[k]]),
    );
  };
  for (const o of ops) if (o.op === "split") guard(o, () => doSplit(o));

  let units = [];
  const own = new Map(); // "i|k" -> chỉ số đơn vị
  const src = segments.map((s) => s.text).join("");
  segments.forEach((s, i) => {
    const spans = cut.get(i) || [[[off[i], off[i] + s.text.length], null]];
    spans.forEach(([[a, b], txt], k) => {
      own.set(`${i}|${k}`, units.length);
      if (spans.length === 1) own.set(`${i}|null`, units.length);
      units.push({
        seg: [i],
        ref: spans.length === 1 ? i : `${i}.${k}`,
        a,
        b,
        raw: src.slice(a, b),
        text: txt || src.slice(a, b),
        speaker: s.speaker ?? null,
        edits: [],
        note: "",
        split: spans.length > 1,
      });
    });
  });

  /**
   * Tham chiếu nguyên segment sau khi nó bị split: hiểu theo nghĩa của từng op,
   * thay vì bắt model phải đánh số lại (đo được: đó là nguồn retry chính).
   */
  const unitsOf = (o, pick = "all") => {
    const [i, k] = refOf(o, nseg);
    if (k !== null) {
      if (!own.has(`${i}|${k}`)) throw new OpError(`单元 "${i}.${k}" 不存在。`);
      return [own.get(`${i}|${k}`)];
    }
    const js = [];
    const seen = new Set();
    const keys = [...own.keys()]
      .map((s) => {
        const [si, sk] = s.split("|");
        return { si: parseInt(si, 10), sk: sk === "null" ? null : parseInt(sk, 10), key: s };
      })
      .sort((x, y) => x.si - y.si || (x.sk ?? 0) - (y.sk ?? 0));
    for (const { si, sk, key } of keys) {
      const j = own.get(key);
      if (si === i && sk !== null && !seen.has(j)) {
        seen.add(j);
        js.push(j);
      }
    }
    if (!js.length) throw new OpError(`单元号 ${i} 不存在。`);
    if (pick === "all") return js;
    return [pick === "last" ? js[js.length - 1] : js[0]];
  };
  const unitOf = (o) => unitsOf(o, "first")[0];

  // ---- 2. merge: chỉ gộp được các đơn vị liền kề, mỗi đơn vị chỉ bị gộp một lần
  const dead = new Set();
  const group = new Map();
  const doMerge = (o) => {
    const us = o.u !== undefined ? o.u : o.i;
    if (!Array.isArray(us) || us.length < 2) {
      throw new OpError("merge 的 u 必须是至少 2 个单元的数组，例如 [0,1]。");
    }
    const idx = us.map((x) => unitOf({ op: "merge", u: x }));
    const contiguous = idx.every((v, n) => v === idx[0] + n);
    if (!contiguous) throw new OpError(`merge ${JSON.stringify(us)} 的单元不相邻，只能合并连续的句子。`);
    if (idx.some((j) => dead.has(j) || group.has(j))) {
      throw new OpError(`merge ${JSON.stringify(us)} 里有单元已经被合并过了。`);
    }
    group.set(idx[0], idx);
    idx.slice(1).forEach((j) => dead.add(j));
  };
  for (const o of ops) if (o.op === "merge") guard(o, () => doMerge(o));

  const merged = [];
  const remap = new Map();
  units.forEach((u, j) => {
    if (dead.has(j)) return;
    if (group.has(j)) {
      const ids = group.get(j);
      const head = { ...u };
      head.seg = [...new Set(ids.flatMap((q) => units[q].seg))].sort((x, y) => x - y);
      head.b = units[ids[ids.length - 1]].b;
      head.raw = src.slice(head.a, head.b);
      head.text = ids
        .map((q, n) => (n < ids.length - 1 ? rstrip(units[q].text, "。，") : units[q].text))
        .join("");
      ids.forEach((q) => remap.set(q, merged.length));
      merged.push(head);
    } else {
      remap.set(j, merged.length);
      merged.push({ ...u });
    }
  });
  units = merged;
  for (const key of own.keys()) own.set(key, remap.get(own.get(key)));

  // ---- 3. replace: chỉ đổi được cụm CÓ THẬT trong đơn vị đó
  const doReplace = (o) => {
    const a = String(o.from ?? "");
    const b = String(o.to ?? "");
    if (!a) throw new OpError("replace 缺少 from。");
    const hits = unitsOf(o).filter((j) => units[j].text.includes(a));
    if (!hits.length) {
      const j0 = unitsOf(o)[0];
      throw new OpError(
        `replace u=${o.u ?? o.i} 找不到 "${a}"。该条原文是：${units[j0].raw}`,
      );
    }
    const [kind, sm] = kindOf(a, b);
    // Kiểm bất biến TRƯỚC khi áp: không khớp thì loại riêng op này. Để tới verify() cuối
    // mới lộ thì nó ném "lỗi nội bộ" và sập cả tập thay vì bỏ một thao tác.
    for (const j of hits) {
      const u = units[j];
      const next = u.text.split(a).join(b);
      if (!consistent(u.raw, [...u.edits, { from: a, to: b }], next)) {
        throw new OpError(`replace u=${o.u ?? o.i} "${a}"->"${b}" 对不上原文，已退回。from/to 只写真正听错的那几个字，别连标点和整句一起抄。`);
      }
    }
    for (const j of hits) {
      units[j].text = units[j].text.split(a).join(b);
      units[j].edits.push({
        from: a,
        to: b,
        kind,
        sim: Math.round(sm * 100) / 100,
        why: o.why || "",
        conf: o.conf ?? 1,
      });
    }
  };
  for (const o of ops) if (o.op === "replace") guard(o, () => doReplace(o));

  // ---- 4/5/6: dấu câu, người nói, ghi chú
  const doRest = (o) => {
    if (o.op === "punct") {
      const to = String(o.to ?? "");
      if (!PUNCT.includes(to) || !to) throw new OpError(`punct 的 to=${JSON.stringify(to)} 不行，只能是 ${PUNCT} 之一。`);
      const j = unitsOf(o, "last")[0];
      units[j].text = rstrip(units[j].text, PUNCT + " ") + to;
    } else if (o.op === "speaker") {
      const to = String(o.to ?? "").trim();
      if (!to) throw new OpError("speaker 缺少 to。");
      for (const j of unitsOf(o)) units[j].speaker = to;
    } else if (o.op === "note") {
      for (const j of unitsOf(o)) units[j].note = String(o.text ?? "");
    } else if (!["split", "merge", "replace"].includes(o.op)) {
      throw new OpError(
        `不认识的 op：${JSON.stringify(o.op)}。只能用 split/merge/replace/punct/speaker/note。`,
      );
    }
  };
  for (const o of ops) guard(o, () => doRest(o));

  verify(units);
  return { units, bad };
}

/**
 * Bất biến do CODE giữ: nội dung mỗi đơn vị = nguyên văn + đúng các replace đã khai báo.
 * Không có chỗ nào cho model tự ý thêm/bớt chữ, nên mất câu và lặp câu là không thể.
 */
export function verify(units) {
  for (const u of units) {
    if (!consistent(u.raw, u.edits, u.text)) {
      throw new OpError(`单元 ${JSON.stringify(u.seg)} 内容对不上（内部错误）。`);
    }
  }
  return true;
}

/**
 * So trên CHỮ TRẦN cả hai phía — nguyên văn lẫn from/to của từng replace.
 *
 * `raw` giữ dấu câu gốc, còn `text` của mảnh split mang dấu câu model viết lại. Trước đây
 * phát lại replace trên `raw` CÓ dấu: một replace dính dấu câu («…老杂兽。») khớp `text` (。)
 * nhưng không khớp `raw` (，) nên bị coi là đổi nội dung, và cả tập sập vì "lỗi nội bộ"
 * (gặp thật: 杂役合道 tập 2, bản Python có cùng lỗi). Bất biến cần giữ là không mất/thêm
 * CHỮ; dấu câu vốn đã được split/punct đổi hợp lệ.
 */
function consistent(raw, edits, text) {
  let want = bare(raw);
  for (const e of edits) want = want.split(bare(e.from)).join(bare(e.to));
  return want === bare(text);
}
