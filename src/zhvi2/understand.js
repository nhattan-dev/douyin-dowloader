/**
 * Task 1 — "hiểu tập": MỘT lượt todo LLM thay cho pass A (A2/A3), B2, B2b và việc tách câu ASR
 * gộp người của v1.
 *
 * Đầu vào: kịch bản (câu + cụm giọng + mốc từng từ), bible, phiếu kênh hình.
 * Đầu ra: sửa lỗi nghe nhầm, tách câu gộp người (kèm mốc cắt), tên từng cụm giọng, câu lệch cụm,
 * câu còn nghi, nhân vật/thuật ngữ mới, và bản dịch thô cho trang soát (fleex không đọc được
 * tiếng Trung).
 *
 * Vẫn giữ hợp đồng "thao tác trên nguồn", KHÔNG cho viết lại kịch bản: đó là neo cấu trúc chứ
 * không phải chỗ bù cho model yếu — viết lại thì mất câu/lặp câu không bắt được (đo ở v1:
 * một câu 22 chữ biến mất mà `zh_raw` vẫn khớp 100%).
 *
 * Code chỉ KIỂM (sửa có tìm thấy chữ gốc không, mảnh tách ghép lại có đúng nguyên văn không, mốc
 * có nằm trong câu và tăng dần không, tên có trong bible không) — sai thì hỏi lại kèm lỗi. Không
 * nội suy mốc, không ngưỡng, không tự chọn thay (feedback của fleex 2026-09-19).
 */
import { bibleHit } from "../zhvi/bible.js";

/** Nhãn người soát/LLM dùng khi không phải một người xác định. */
export const UNKNOWN = "không rõ";

/** Cụm giọng lấy từ `qwenSpeakerId`, KHÔNG từ `speaker` (zhvi ghi đè trường đó — bẫy v1). */
export function rawLines(transcript) {
  const segs = transcript.segments || [];
  const hasQ = segs.some((s) => s.qwenSpeakerId !== undefined && s.qwenSpeakerId !== null);
  const words = transcript.words || [];
  // Câu rỗng bỏ hẳn (whisper từng trả 1/94) — giữ lại thì task phải "dịch" một dòng không có gì.
  // `id` vẫn là số segment gốc: writeBack gán ngược người nói theo đúng số đó.
  return segs.map((s, i) => ({
    id: i,
    speaker: hasQ && s.qwenSpeakerId !== null && s.qwenSpeakerId !== undefined ? `S${s.qwenSpeakerId}` : s.speaker,
    start: s.start,
    end: s.end,
    zh: String(s.text || "").trim(),
    words: words.filter((w) => w.start >= s.start - 0.005 && w.start < s.end),
  })).filter((l) => l.zh);
}

const t2 = (x) => Number(x).toFixed(2);

/** Context gửi kèm task: dữ liệu, không phải mệnh lệnh. */
export function context(lines, bible, { ep = null, epTitle = null, vision = null } = {}) {
  const vis = {};
  if (vision) {
    for (const [spk, c] of Object.entries(vision.clusters || {})) {
      if (c.probed?.length) vis[spk] = { votes: c.votes, probedLines: c.probed };
    }
  }
  return {
    series: bible.series?.titleVi || bible.series?.titleZh || bible.series?.id || "",
    episode: { ep, title: epTitle },
    cast: bible.cast.map((c) => ({
      zh: c.zh, vi: c.vi, gender: c.gender, alias: c.alias || [], note: c.note || "",
    })),
    terms: Object.fromEntries(Object.entries(bible.terms || {}).filter(([, t]) => t.approved).map(([zh, t]) => [zh, t.vi])),
    vision: vision ? {
      clusters: vis,
      lines: Object.fromEntries(Object.entries(vision.lines || {}).map(([i, r]) => [i, { saw: r.pred, why: r.why }])),
    } : null,
    // "#12 S1 45.20-48.90 | 你走吧我不走 | 你走吧@45.20 我@46.80 不走@47.10"
    script: lines.map((l) => `#${l.id} ${l.speaker} ${t2(l.start)}-${t2(l.end)} | ${l.zh} | `
      + l.words.map((w) => `${w.word}@${t2(w.start)}`).join(" ")),
  };
}

export function schema(lines) {
  const clusters = [...new Set(lines.map((l) => l.speaker))];
  const str = { type: "string" };
  const line = { type: "integer" };
  const obj = (props, req = Object.keys(props)) => ({ type: "object", additionalProperties: false, required: req, properties: props });
  return {
    type: "object",
    additionalProperties: false,
    required: ["premise", "fixes", "splits", "clusters", "lines", "doubts", "newCast", "newTerms", "vi"],
    properties: {
      premise: str,
      fixes: { type: "array", items: obj({ line, from: { type: "string", minLength: 1 }, to: str, why: str }) },
      splits: {
        type: "array",
        items: obj({
          line,
          parts: {
            type: "array", minItems: 2,
            items: obj({ text: { type: "string", minLength: 1 }, start: { type: "number" }, who: str, vi: str }),
          },
        }),
      },
      clusters: {
        type: "object", additionalProperties: false, required: clusters,
        properties: Object.fromEntries(clusters.map((k) => [k, obj({ who: { type: ["string", "null"] }, sure: { type: "boolean" }, why: str })])),
      },
      lines: { type: "array", items: obj({ line, who: str, why: str }) },
      doubts: { type: "array", items: obj({ line, why: str }) },
      newCast: { type: "array", items: obj({ zh: str, vi: str, gender: { enum: ["male", "female", "?"] }, why: str }) },
      newTerms: { type: "array", items: obj({ zh: str, vi: str, why: str }) },
      vi: {
        type: "object", additionalProperties: false,
        required: lines.map((l) => String(l.id)),
        properties: Object.fromEntries(lines.map((l) => [String(l.id), str])),
      },
    },
  };
}

/** Tên người nói hợp lệ: nhân vật bible, nhân vật mới chính task khai, hoặc "không rõ". */
function whoOk(who, bible, fresh) {
  return who === UNKNOWN || Boolean(bibleHit(bible, who)) || fresh.has(who);
}

/** Văn bản câu sau khi áp các `fixes` theo đúng thứ tự khai. Trả [text, lỗi[]]. */
function fixedText(line, fixes) {
  let t = line.zh;
  const errs = [];
  for (const f of fixes) {
    const n = t.split(f.from).length - 1;
    if (n !== 1) {
      errs.push(`fixes: câu #${line.id} ${n ? `có ${n} chỗ` : "không có"} chữ ${JSON.stringify(f.from)}`
        + `${n ? " — thêm chữ xung quanh để chỉ đúng một chỗ" : ""} (câu hiện là ${JSON.stringify(t)})`);
      continue;
    }
    if (f.from === f.to) {
      errs.push(`fixes: câu #${line.id} sửa ${JSON.stringify(f.from)} thành chính nó`);
      continue;
    }
    t = t.replace(f.from, f.to);
  }
  return [t, errs];
}

const strip = (s) => String(s || "").replace(/\s+/g, "");

/** Lỗi của một lệnh tách câu: ghép lại phải đúng nguyên văn (đã áp fixes), mốc trong câu và tăng dần. */
function splitErrors(s, l, text, bible, fresh) {
  const errs = [];
  const joined = strip(s.parts.map((p) => p.text).join(""));
  if (joined !== strip(text)) {
    errs.push(`splits: câu #${s.line} ghép các mảnh ra ${JSON.stringify(joined)}, phải đúng nguyên văn `
      + `${JSON.stringify(strip(text))} (đã áp fixes)`);
  }
  let prev = -Infinity;
  for (const [k, p] of s.parts.entries()) {
    if (!(p.start >= l.start - 0.005 && p.start < l.end)) {
      errs.push(`splits: câu #${s.line} mảnh ${k + 1} bắt đầu ${p.start}, ngoài câu ${t2(l.start)}-${t2(l.end)}`);
    }
    if (p.start <= prev) errs.push(`splits: câu #${s.line} mảnh ${k + 1} bắt đầu ${p.start} không sau mảnh trước`);
    prev = p.start;
    if (!whoOk(p.who, bible, fresh)) errs.push(`splits: câu #${s.line} mảnh ${k + 1} người nói ${JSON.stringify(p.who)} không có trong cast/newCast`);
    if (!strip(p.vi)) errs.push(`splits: câu #${s.line} mảnh ${k + 1} thiếu vi`);
  }
  return errs;
}

/**
 * Kiểm một nhát cắt của người soát — chỉ HÌNH DẠNG (ghép đúng nguyên văn, mốc tăng dần trong câu,
 * tên có thật). Không phán nội dung: người cắt là bản cuối. Hỏng thì bỏ nhát cắt, giữ câu nguyên.
 */
function cutErrors(c, u, bible, fresh) {
  const errs = [];
  const at = `cắt tay @${u.sk} (#${u.segmentIndexes[0]})`;
  if (!Array.isArray(c.parts) || c.parts.length < 2) return [`${at}: cần ít nhất 2 mảnh`];
  if (strip(c.parts.map((p) => p.text).join("")) !== strip(u.zh)) {
    errs.push(`${at}: ghép các mảnh không ra đúng câu ${JSON.stringify(u.zh)} — câu đã đổi sau lần soát, cắt lại`);
  }
  let prev = u.start;
  for (const [k, p] of c.parts.entries()) {
    if (!strip(p.text)) errs.push(`${at}: mảnh ${k + 1} rỗng`);
    if (k && !(p.start > prev && p.start < u.end)) errs.push(`${at}: mảnh ${k + 1} bắt đầu ${p.start}, phải sau ${t2(prev)} và trước ${t2(u.end)}`);
    if (k) prev = p.start;
    if (!whoOk(p.who, bible, fresh)) errs.push(`${at}: mảnh ${k + 1} người nói ${JSON.stringify(p.who)} không có trong cast`);
  }
  return errs;
}

/** Kiểm câu trả lời của task 1. Trả mảng lỗi, mỗi lỗi nói đủ để model tự sửa. */
export function check(out, lines, bible) {
  const errs = [];
  const by = new Map(lines.map((l) => [l.id, l]));
  const fresh = new Set((out.newCast || []).map((c) => c.zh).filter(Boolean));
  const has = (i, where) => {
    if (by.has(i)) return true;
    errs.push(`${where}: không có câu #${i}`);
    return false;
  };

  const fixesOf = new Map();
  for (const f of out.fixes || []) {
    if (!has(f.line, "fixes")) continue;
    if (!fixesOf.has(f.line)) fixesOf.set(f.line, []);
    fixesOf.get(f.line).push(f);
  }
  const text = new Map(lines.map((l) => {
    const [t, e] = fixedText(l, fixesOf.get(l.id) || []);
    errs.push(...e);
    return [l.id, t];
  }));

  const splitIds = new Set();
  for (const s of out.splits || []) {
    if (!has(s.line, "splits")) continue;
    if (splitIds.has(s.line)) errs.push(`splits: câu #${s.line} bị tách hai lần`);
    splitIds.add(s.line);
    errs.push(...splitErrors(s, by.get(s.line), text.get(s.line), bible, fresh));
  }

  const present = new Set(lines.map((l) => l.speaker));
  for (const k of present) if (!out.clusters?.[k]) errs.push(`clusters: thiếu cụm ${k}`);
  for (const [k, c] of Object.entries(out.clusters || {})) {
    if (!present.has(k)) errs.push(`clusters: tập này không có cụm ${k}`);
    else if (c.who !== null && !whoOk(c.who, bible, fresh)) errs.push(`clusters: ${k} gán ${JSON.stringify(c.who)} — không có trong cast/newCast (không chắc thì để null)`);
  }
  for (const r of out.lines || []) {
    if (!has(r.line, "lines")) continue;
    if (splitIds.has(r.line)) errs.push(`lines: câu #${r.line} đã tách ở splits — ghi người nói trong từng mảnh`);
    if (!whoOk(r.who, bible, fresh)) errs.push(`lines: câu #${r.line} người nói ${JSON.stringify(r.who)} không có trong cast/newCast`);
  }
  for (const d of out.doubts || []) has(d.line, "doubts");
  // Cụm chưa chắc là một người: model phải xét TỪNG câu, không được để câu thừa hưởng tên cụm.
  // (ai-qing tập 1: S10 13 câu hai cô gái, cả cụm một tên, phần chia cụm phải chọn tay từng câu.)
  const said = new Set([...(out.lines || []).map((r) => r.line), ...splitIds]);
  for (const [k, c] of Object.entries(out.clusters || {})) {
    if (c.sure !== false || !present.has(k)) continue;
    const miss = lines.filter((l) => l.speaker === k && !said.has(l.id)).map((l) => "#" + l.id);
    if (miss.length) errs.push(`lines: cụm ${k} để sure=false nên mỗi câu của cụm phải có một mục trong lines (kể cả câu đúng là của ${c.who ?? "chủ cụm"}); thiếu ${miss.join(" ")}`);
  }

  const all = [...text.values()].join("");
  for (const t of out.newTerms || []) {
    if (!all.includes(t.zh)) errs.push(`newTerms: ${JSON.stringify(t.zh)} không xuất hiện trong kịch bản tập này`);
    if (bible.terms?.[t.zh]) errs.push(`newTerms: ${JSON.stringify(t.zh)} đã có trong bible`);
  }
  for (const c of out.newCast || []) {
    if (bibleHit(bible, c.zh)) errs.push(`newCast: ${JSON.stringify(c.zh)} đã có trong bible (${bibleHit(bible, c.zh).vi})`);
  }
  for (const l of lines) {
    if (!splitIds.has(l.id) && !strip(out.vi?.[String(l.id)])) errs.push(`vi: câu #${l.id} thiếu bản dịch thô`);
  }
  return errs;
}

/**
 * Áp câu trả lời (đã kiểm) lên nguồn -> `utts` + `align` đúng hình dạng v1, để trang soát,
 * cổng soát, `applySpeakers`, `sheetFromBible` và export của v1 dùng lại nguyên.
 *
 * Mục nào vẫn hỏng sau khi hết lượt hỏi lại thì BỎ đúng mục đó (câu giữ nguyên ASR / cụm để
 * trống tên) và ghi vào `rejected` — không tự sửa hộ.
 */
export function apply(out, lines, bible, { cuts = {} } = {}) {
  const rejected = [];
  const fresh = new Set((out.newCast || []).map((c) => c.zh).filter(Boolean));
  const by = new Map(lines.map((l) => [l.id, l]));
  const cidOf = (who) => (who && who !== UNKNOWN ? bibleHit(bible, who)?.id ?? null : null);

  // fixes: bỏ riêng từng sửa không áp được
  const fixesOf = new Map();
  for (const f of out.fixes || []) {
    const l = by.get(f.line);
    if (!l) continue;
    const cur = fixesOf.get(f.line) || [];
    const [, e] = fixedText(l, [...cur, f]);
    if (e.length > (fixedText(l, cur)[1].length)) {
      rejected.push(...e.slice(-1));
      continue;
    }
    fixesOf.set(f.line, [...cur, f]);
  }
  const textOf = (l) => fixedText(l, fixesOf.get(l.id) || [])[0];

  const splits = new Map();
  for (const s of out.splits || []) {
    const l = by.get(s.line);
    if (!l || splits.has(s.line)) continue;
    const e = splitErrors(s, l, textOf(l), bible, fresh);
    if (e.length) rejected.push(...e);
    else splits.set(s.line, s);
  }
  const lineWho = new Map();
  for (const r of out.lines || []) {
    if (!by.has(r.line) || splits.has(r.line)) continue;
    if (!whoOk(r.who, bible, fresh)) {
      rejected.push(`lines: câu #${r.line} người nói ${JSON.stringify(r.who)} không có trong cast/newCast`);
      continue;
    }
    lineWho.set(r.line, r);
  }

  // --- cụm giọng -> nhân vật
  const clusters = {};
  const unmapped = [];
  for (const spk of new Set(lines.map((l) => l.speaker))) {
    const c = out.clusters?.[spk] || { who: null, sure: false, why: "task không trả cụm này" };
    const cid = cidOf(c.who);
    const lv = !cid ? "none" : c.sure ? "confirmed" : "single";
    if (!cid && c.who && c.who !== UNKNOWN) {
      if (fresh.has(c.who)) unmapped.push({ speaker: spk, zh: c.who, why: "nhân vật mới: " + (c.why || "") });
      else rejected.push(`clusters: ${spk} gán ${JSON.stringify(c.who)} không có trong cast/newCast`);
    }
    clusters[spk] = {
      cid, level: lv, why: c.why || "",
      text: cid, textVerified: Boolean(c.sure && cid), vision: null, visionSure: false,
      veto: [], size: 0, votes: null, probed: [],
      who: c.who ?? null,
    };
  }

  // --- dựng câu: tách mảnh, rồi đưa câu/mảnh lệch cụm sang cụm của đúng nhân vật
  const keyOf = new Map();
  for (const [spk, c] of Object.entries(clusters)) if (c.cid && !keyOf.has(c.cid)) keyOf.set(c.cid, spk);
  const home = (cid, from) => {
    if (!cid || clusters[from]?.cid === cid) return from;
    if (!keyOf.has(cid)) {
      // nhân vật chưa có cụm nào trong tập -> cụm ảo, giống cụm "H" của người soát ở v1
      const k = "T" + cid;
      keyOf.set(cid, k);
      clusters[k] = {
        cid, level: "single", why: "cụm do todo LLM tách ra từ câu lệch cụm",
        text: cid, textVerified: false, vision: null, visionSure: false, veto: [], size: 0, votes: null, probed: [],
      };
    }
    return keyOf.get(cid);
  };

  const utts = [];
  const moved = {};
  // Trang soát tách ba nguồn cho từng câu: giọng (cụm ASR gốc, `asrSpeaker`), LLM (`llm`), hình.
  // `speaker` thì đã dời sang cụm của người LLM chọn — hiện nó thay cho giọng là giấu mất chỗ lệch.
  const llm = {};
  const push0 = (u, extra = {}) => utts.push({ id: utts.length, asrSpeaker: by.get(u.segmentIndexes[0])?.speaker, ...u, ...extra });
  // `sk` = khoá ổn định của câu trên trang soát: số câu ASR gốc (+ ".k" mảnh LLM tách, + "/k" mảnh
  // người cắt). `id` đánh lại mỗi lần cắt nên nhãn người soát phải khoá bằng `sk`, không bằng `id`.
  // Người cắt thì bản của người là cuối (LLM chỉ đề xuất): code chỉ kiểm hình dạng, không hỏi lại LLM.
  const push = (u, extra = {}) => {
    const c = cuts[u.sk];
    const e = c ? cutErrors(c, u, bible, fresh) : [];
    if (c && e.length) rejected.push(...e);
    if (!c || e.length) return push0(u, extra);
    const { mixed: _m, ...base } = u; // cờ "nhiều người" của câu mẹ không truyền xuống mảnh
    c.parts.forEach((p, k) => {
      const end = k + 1 < c.parts.length ? c.parts[k + 1].start : u.end;
      const spk = home(cidOf(p.who), u.asrSpeaker ?? u.speaker);
      const n0 = utts.length;
      // đệ quy: một mảnh người đã cắt vẫn cắt tiếp được (khoá "20/1/0")
      push({
        ...base, sk: `${u.sk}/${k}`, speaker: spk, start: k ? p.start : u.start, end, zh: p.text,
        speakerSource: "fleex-cut", edits: k ? [] : u.edits,
        ...(p.who === UNKNOWN ? { mixed: UNKNOWN } : {}),
      }, { roughVi: "" });
      if (utts.length - n0 === 1) llm[utts.length - 1] = { who: p.who, why: "người soát cắt", by: "người" };
    });
    return null;
  };
  for (const l of lines) {
    const fixed = textOf(l);
    const edits = (fixesOf.get(l.id) || []).map((f) => ({ from: f.from, to: f.to, why: f.why, conf: 1 }));
    const s = splits.get(l.id);
    if (s) {
      s.parts.forEach((p, k) => {
        const end = k + 1 < s.parts.length ? Math.round(s.parts[k + 1].start * 1000) / 1000 : l.end;
        const cid = cidOf(p.who);
        const spk = home(cid, l.speaker);
        const n0 = utts.length;
        push({
          sk: `${l.id}.${k}`, asrSpeaker: l.speaker,
          speaker: spk, start: Math.round(p.start * 1000) / 1000, end,
          zh_raw: l.zh, zh: p.text, segmentIndexes: [l.id],
          speakerSource: "todo-split", edits: k ? [] : edits, conf: 1, note: "", review: [], aligned: true,
          ...(p.who === UNKNOWN ? { mixed: UNKNOWN } : {}),
        }, { roughVi: p.vi });
        if (utts.length - n0 !== 1) return; // người đã cắt tiếp mảnh này
        moved[utts.length - 1] = { kind: "split", who: p.who, zh: p.text };
        llm[utts.length - 1] = { who: p.who, why: "tách từ câu gộp người", by: "tách" };
      });
      continue;
    }
    const r0 = lineWho.get(l.id);
    // mục `lines` trùng đúng tên cụm = model xác nhận câu đó (cụm chưa chắc phải liệt kê hết), không phải đổi người
    const r = r0 && r0.who !== clusters[l.speaker]?.who ? r0 : null;
    const cid = r ? cidOf(r.who) : null;
    const spk = r ? home(cid, l.speaker) : l.speaker;
    const n0 = utts.length;
    push({
      sk: String(l.id), asrSpeaker: l.speaker,
      speaker: spk, start: l.start, end: l.end,
      zh_raw: l.zh, zh: fixed, segmentIndexes: [l.id],
      speakerSource: r ? "todo-moved" : "qwen", edits, conf: 1, note: "", review: [], aligned: true,
      ...(r?.who === UNKNOWN ? { mixed: UNKNOWN } : {}),
    }, { roughVi: out.vi?.[String(l.id)] || "" });
    if (utts.length - n0 !== 1) continue; // người đã cắt câu này
    llm[utts.length - 1] = r0 ? { who: r0.who, why: r0.why || "", by: "câu" }
      : { who: clusters[l.speaker]?.who ?? null, why: "", by: "cụm" };
    if (r) moved[utts.length - 1] = { kind: "line", who: r.who, why: r.why };
  }
  for (const [k, c] of Object.entries(clusters)) c.size = utts.filter((u) => u.speaker === k).length;

  // --- câu cần người soi: model tự khai nghi + mọi câu máy đã đổi người nói + cụm chưa chắc
  const suspects = {};
  const mark = (i, why) => (suspects[String(i)] ||= []).push(why);
  const newId = new Map();
  utts.forEach((u) => {
    for (const i of u.segmentIndexes) if (!newId.has(i)) newId.set(i, []);
    newId.get(u.segmentIndexes[0]).push(u.id);
  });
  for (const d of out.doubts || []) for (const i of newId.get(d.line) || []) mark(i, "todo nghi: " + d.why);
  for (const [i, m] of Object.entries(moved)) mark(i, m.kind === "split" ? "todo tách câu gộp người" : "todo đổi người nói: " + (m.why || ""));
  for (const u of utts) {
    const lv = clusters[u.speaker]?.level;
    if (lv !== "confirmed") mark(u.id, "cụm " + lv);
  }

  const newTerms = Object.fromEntries((out.newTerms || []).map((t) => [t.zh, { vi: t.vi, why: t.why }]));
  const roughVi = Object.fromEntries(utts.map((u) => [u.id, u.roughVi]));
  for (const u of utts) delete u.roughVi;

  return {
    utts,
    roughVi,
    align: {
      premise: out.premise || "",
      clusters,
      speakerMap: Object.fromEntries(Object.entries(clusters).filter(([, c]) => c.cid).map(([k, c]) => [k, c.cid])),
      suspects,
      llm,
      unmapped,
      newTerms,
      newCast: out.newCast || [],
      vocatives: [],
      vision: null,
    },
    rejected,
  };
}

/** Gắn phiếu kênh hình vào align để trang soát v1 hiện được ảnh + phiếu. */
export function attachVision(align, vision, bible, rawToUtt) {
  if (!vision) return align;
  const lines = {};
  for (const [i, r] of Object.entries(vision.lines || {})) {
    const j = rawToUtt.get(Number(i));
    if (j === undefined) continue;
    lines[j] = { ...r, cid: bibleHit(bible, r.pred)?.id ?? null };
  }
  align.vision = { ...vision, lines };
  // Hình chỉ ra một người khác với người LLM gán -> đưa cho người soi. Chỉ chuyển tiếp chỗ hai
  // nguồn cãi nhau, không phân xử: phiếu lẻ của hình đúng ~70%, LLM cũng có lúc sai cả cụm.
  const NA = ["ngoai_khung", "khong_chac", "?parse"];
  for (const [j, r] of Object.entries(lines)) {
    const who = align.llm?.[j]?.who;
    if (!who || NA.includes(r.pred) || r.pred === who) continue;
    (align.suspects[j] ||= []).push(`hình thấy ${r.pred}, LLM gán ${who}`);
  }
  for (const [spk, c] of Object.entries(vision.clusters || {})) {
    const cl = align.clusters[spk];
    if (!cl) continue;
    cl.vision = c.cid;
    cl.visionSure = Boolean(c.sure);
    cl.votes = c.votes;
    cl.probed = (c.probed || []).map((i) => rawToUtt.get(i)).filter((x) => x !== undefined);
  }
  return align;
}
