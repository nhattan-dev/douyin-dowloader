/**
 * Task 2 — dịch cả tập trong MỘT lượt todo LLM, thay cho pass C + D của v1 (render, critic, fix,
 * decjk). Tự soát nằm trong chính task; code chỉ kiểm luật đo được (đủ id, sót chữ Hán, thuật ngữ
 * đã chốt, trần âm tiết) và trả lại đúng các lỗi đó.
 */
import { check as ruleCheck } from "../zhvi/passes/d-verify.js";

const relevant = (map, text) => Object.fromEntries(Object.entries(map || {}).filter(([k]) => text.includes(k)));

/** Tên hiển thị của từng cụm giọng theo `sheet` (dựng từ bible + nhãn đã chốt). */
function namesOf(sheet) {
  return new Map((sheet.characters || []).map((c) => [c.key, c]));
}

export function terms(sheet) {
  return Object.fromEntries((sheet.entities || []).map((e) => [e.zh, e.vi]));
}

export function context(utts, sheet, { glossary = {}, cps = 0 } = {}) {
  const who = namesOf(sheet);
  const zhAll = utts.map((u) => u.zh).join("");
  const seen = new Set();
  const chars = [];
  for (const c of sheet.characters || []) {
    const k = c.cid || c.zh;
    if (seen.has(k) || !c.vi) continue;
    seen.add(k);
    chars.push({ vi: c.vi, zh: c.zh, gender: c.gender, note: c.role || "" });
  }
  const addr = new Map();
  for (const a of sheet.address || []) {
    const f = who.get(a.from)?.vi;
    const t = who.get(a.to)?.vi;
    if (f && t) addr.set(`${f}>${t}`, { from: f, to: t, self: a.self, other: a.other, why: a.why || "" });
  }
  return {
    premise: sheet.premise || "",
    characters: chars,
    address: [...addr.values()],
    terms: relevant(terms(sheet), zhAll),
    glossary: relevant(glossary, zhAll),
    lines: utts.map((u) => ({
      id: u.id,
      who: who.get(u.speaker)?.vi || "?",
      zh: u.zh,
      ...(cps && u.start !== null && u.start !== undefined ? { max: budget(u, cps) } : {}),
    })),
  };
}

export const budget = (u, cps) => Math.max(3, Math.round((u.end - u.start) * cps));

export function schema(utts) {
  const ids = utts.map((u) => String(u.id));
  return {
    type: "object",
    additionalProperties: false,
    required: ["vi"],
    properties: {
      vi: {
        type: "object", additionalProperties: false, required: ids,
        properties: Object.fromEntries(ids.map((i) => [i, { type: "string", minLength: 1 }])),
      },
    },
  };
}

/** Luật code của v1 (D1), nói lại theo dạng model đọc được. */
export function check(out, utts, sheet, { cps = 0 } = {}) {
  const vi = Object.fromEntries(Object.entries(out?.vi || {}).map(([k, v]) => [Number(k), v]));
  const bad = ruleCheck(utts, vi, terms(sheet), { cps });
  return Object.entries(bad).map(([id, errs]) => `#${id}: ${errs.join("; ")}`);
}
