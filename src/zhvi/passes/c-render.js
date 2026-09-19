/**
 * Pass C — dịch zh → vi ở cấp tài liệu, neo theo id, ép glossary + hồ sơ nhân vật.
 *   C1 plan       cắt lô theo NGÂN SÁCH TOKEN ĐẦU RA  (code, miễn phí)
 *   C2 translate  dịch                                (LLM — lượt đắt nhất cả pipeline)
 */
import { jparse } from "../llm.js";
import { TRANS_SYS } from "../prompts.js";

export const CJK = /[\u3400-\u9fff\uf900-\ufaff]/;
export const CJK_G = /[\u3400-\u9fff\uf900-\ufaff]/g;

export const syl = (s) => String(s || "").split(/[^0-9A-Za-zÀ-ỹ]+/).filter(Boolean).length;

const relevantGlossary = (gloss, text) =>
  Object.fromEntries(Object.entries(gloss || {}).filter(([k]) => text.includes(k)));

const countOf = (hay, needle) => (needle ? hay.split(needle).length - 1 : 0);

export function chunk(items, n) {
  const out = [];
  for (let i = 0; i < items.length; i += n) out.push(items.slice(i, i + n));
  return out;
}

/** Hồ sơ phim ở dạng văn bản + bảng thuật ngữ bị khoá. Pass C và pass D dùng chung. */
export function sheetText(sheet, gloss, zhAll, pinned = null) {
  const g = { ...relevantGlossary(gloss, zhAll), ...relevantGlossary(pinned || {}, zhAll) };
  // chỉ khoá thứ THẬT SỰ trôi được: tên riêng, cụm lặp lại, glossary
  const ent = {};
  for (const e of sheet.entities || []) {
    if (["place", "character", "org", "item", "skill"].includes(e.type) || countOf(zhAll, e.zh) >= 2) {
      let v = e.vi;
      if (e.policy === "nghia" && e.type === "term") v = v.slice(0, 1).toLowerCase() + v.slice(1); // danh từ chung không viết hoa
      ent[e.zh] = v;
    }
  }
  Object.assign(ent, g); // glossary thắng thứ model tự nghĩ ra

  const lines = ["BỐI CẢNH: " + (sheet.premise || ""), "", "NHÂN VẬT:"];
  for (const c of sheet.characters || []) {
    lines.push(`  ${c.key} = ${c.vi} (${c.zh}) — ${c.gender}, ${c.role}; giọng: ${c.voice || ""}`);
  }
  lines.push("", "XƯNG HÔ (bắt buộc):");
  for (const a of sheet.address || []) {
    const since = a.since || 0;
    lines.push(
      `  ${a.from} -> ${a.to}: tự xưng "${a.self}", gọi đối phương "${a.other}"`
      + (since ? ` (từ giây ${since})` : ""),
    );
  }
  lines.push("", "THUẬT NGỮ (bắt buộc):");
  for (const k of Object.keys(ent).sort()) lines.push(`  ${k} = ${ent[k]}`);
  return [lines.join("\n"), ent];
}

/**
 * C1 — Cắt theo NGÂN SÁCH TOKEN ĐẦU RA, không theo con số ma.
 * Đo được: bản dịch tốn ~1.27 token/chữ Hán; để 1.6 cho an toàn.
 * Phim ngắn (~1k chữ) lọt gọn một lượt gọi; phim dài mới phải cắt.
 */
export function planChunks(utts, { outBudget = 3000, tokPerChar = 1.6, floor = 12 } = {}) {
  const est = utts.reduce((n, u) => n + u.zh.length, 0) * tokPerChar;
  if (est <= outBudget) return utts.length;
  return Math.max(floor, Math.ceil(utts.length / Math.ceil(est / outBudget)));
}

/** C2 — dịch. */
export async function render(llm, utts, sheet, gloss, {
  cps = 0, size = 0, overlap = 3, model, pinned = null, outBudget = 3000,
} = {}) {
  llm.tag = "C-render";
  const zhAll = utts.map((u) => u.zh).join("");
  const [sheetTxt, ent] = sheetText(sheet, gloss, zhAll, pinned);
  size = size || planChunks(utts, { outBudget });

  const vi = {};
  const done = [];
  for (const grp of chunk(utts, size)) {
    // Block bối cảnh CHỈ xuất hiện khi thật sự có câu đã dịch. Đo được: viết
    // "ĐÃ DỊCH TRƯỚC ĐÓ … đừng dịch lại" rồi để "(đầu phim)" làm qwen3-max tưởng
    // 12 câu đầu danh sách đã dịch xong và bỏ qua đúng id 0-11 (2/2 lần).
    const ctx = done.length
      ? done.slice(-overlap).map((u) => `${u.speaker}: ${vi[u.id]}`).join("\n")
      : null;

    const items = grp.map((u) => {
      const it = { id: u.id, sp: u.speaker, zh: u.zh };
      if (cps && u.start !== null && u.start !== undefined) {
        it.max = Math.max(3, Math.round((u.end - u.start) * cps));
      }
      return it;
    });

    let head = sheetTxt;
    if (ctx) {
      head += "\n\nBỐI CẢNH — các câu liền trước đã dịch xong, chỉ để nối giọng, "
        + "KHÔNG nằm trong danh sách dưới:\n" + ctx
        + "\n\nMọi id trong danh sách DỊCH dưới đây đều CHƯA dịch, phải trả đủ.";
    }
    const msgs = [
      { role: "system", content: TRANS_SYS },
      { role: "user", content: head + "\n\nDỊCH:\n" + JSON.stringify(items) },
    ];

    const got = {};
    for (let attempt = 0; attempt < 3; attempt++) {
      const r = await llm.chat(model, msgs, { jsonMode: true, maxTokens: 6000, temperature: 0.2 });
      for (const [k, v] of Object.entries(jparse(r.text))) if (String(v).trim()) got[k] = v;
      const miss = grp.filter((u) => !String(got[String(u.id)] || "").trim()).map((u) => u.id);
      if (!miss.length) break;
      msgs.push(
        { role: "assistant", content: r.text },
        {
          role: "user",
          content: `Thiếu các id: ${JSON.stringify(miss)}. Dịch nốt và trả JSON chứa ĐÚNG các id còn thiếu.`,
        },
      );
    }
    for (const u of grp) {
      vi[u.id] = String(got[String(u.id)] ?? "").trim();
      done.push(u);
    }
  }
  return { vi, ent };
}
