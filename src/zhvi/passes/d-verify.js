/**
 * Pass D — soát và dịch lại đúng chỗ hỏng.
 *   D1 check   luật code: sót chữ Hán, lệch thuật ngữ, quá dài  (code, miễn phí)
 *   D2 critic  model chấm điểm từng câu                         (LLM)
 *   D3 fix     dịch lại đúng những câu bị báo lỗi               (LLM — model riêng `fix`, được nghĩ)
 *   D4 decjk   cứu câu còn sót chữ Hán ở vòng cuối              (LLM)
 *
 * D2+D3 chạy lặp `rounds` vòng. Mỗi vòng là một checkpoint riêng: vòng 2 hỏng thì
 * không phải trả tiền lại cho vòng 1.
 */
import { jparse } from "../llm.js";
import { CRITIC_SYS, TRANS_SYS } from "../prompts.js";
import { CJK, CJK_G, chunk, sheetText, syl } from "./c-render.js";

/** D1 — luật thuần code, không gọi model. */
export function check(utts, vi, ent, { cps = 0 } = {}) {
  const bad = {};
  for (const u of utts) {
    const t = vi[u.id] || "";
    const errs = [];
    if (!t) errs.push("thiếu bản dịch");
    if (CJK.test(t)) errs.push("còn chữ Hán: " + (t.match(CJK_G) || []).join(""));
    for (const [zh, v] of Object.entries(ent)) {
      if (u.zh.includes(zh) && v && !t.toLowerCase().includes(v.toLowerCase())) {
        errs.push(`thuật ngữ ${zh} -> phải là '${v}'`);
      }
    }
    if (cps && u.start !== null && u.start !== undefined) {
      const budget = Math.max(3, Math.round((u.end - u.start) * cps));
      if (syl(t) > budget * 1.25) errs.push(`quá dài ${syl(t)}/${budget} âm tiết`);
    }
    if (errs.length) bad[u.id] = errs;
  }
  return bad;
}

/**
 * D2 — chấm điểm.
 * Luật cũ "critic phải khác nhà, không thì tự khen" đo trên qwen-max chấm qwen3-max (5.00/5 trong khi
 * soát tay ra 8 lỗi). Với deepseek-flash / qwen3.7-max thì không lặp lại: đo 2×2, critic nào cũng chấm
 * GẮT hơn với bản của nhà mình. Đổi cặp model thì đo lại, đừng tin luật nào mãi.
 */
export async function critic(llm, utts, vi, sheet, gloss, { model, size = 15, pinned = null }) {
  llm.tag = "D-critic";
  const zhAll = utts.map((u) => u.zh).join("");
  const [sheetTxt] = sheetText(sheet, gloss, zhAll, pinned);
  const res = {};
  for (const grp of chunk(utts, size)) {
    const items = grp.map((u) => ({ id: u.id, sp: u.speaker, zh: u.zh, vi: vi[u.id] || "" }));
    const msgs = [
      { role: "system", content: CRITIC_SYS },
      { role: "user", content: sheetTxt + "\n\nSOÁT:\n" + JSON.stringify(items) },
    ];
    const r = await llm.chat(model, msgs, { jsonMode: true, maxTokens: 6000, temperature: 0.1 });
    for (const [k, v] of Object.entries(jparse(r.text))) res[Number(k)] = v;
  }
  return res;
}

/** D3 — dịch lại đúng những câu bị báo lỗi, kèm chính lỗi đó. */
export async function repairLines(llm, utts, vi, sheet, gloss, ids, notes, {
  cps = 0, model, pinned = null,
}) {
  llm.tag = "D-fix";
  if (!ids.length) return vi;
  const zhAll = utts.map((u) => u.zh).join("");
  const [sheetTxt] = sheetText(sheet, gloss, zhAll, pinned);
  const by = new Map(utts.map((u) => [u.id, u]));

  const items = ids.map((i) => {
    const u = by.get(i);
    const it = { id: i, sp: u.speaker, zh: u.zh, ban_cu: vi[i] || "", loi: notes[i] || "" };
    if (cps && u.start !== null && u.start !== undefined) {
      it.max = Math.max(3, Math.round((u.end - u.start) * cps));
    }
    return it;
  });
  const msgs = [
    { role: "system", content: TRANS_SYS },
    {
      role: "user",
      content: sheetTxt
        + "\n\nCÁC CÂU SAU BỊ BÁO LỖI. Dịch lại cho đúng, sửa đúng lỗi được chỉ ra:\n"
        + JSON.stringify(items),
    },
  ];
  const r = await llm.chat(model, msgs, { jsonMode: true, maxTokens: 4000, temperature: 0.2 });
  for (const [k, v] of Object.entries(jparse(r.text))) vi[Number(k)] = String(v).trim();
  return vi;
}

/** D4 — câu còn sót chữ Hán: MT cấp từ vựng, model dịch viết lại cả câu. */
export async function decjk(llm, utts, vi, ent, { sheet = null, gloss = null, model, mtModel = "qwen-mt-plus" }) {
  llm.tag = "D-decjk";
  const by = new Map(utts.map((u) => [u.id, u]));
  const [sheetTxt] = sheet ? sheetText(sheet, gloss, utts.map((u) => u.zh).join("")) : [""];

  for (const [k, t] of Object.entries(vi)) {
    const i = Number(k);
    if (!CJK.test(t)) continue;
    const u = by.get(i);
    const opts = {
      source_lang: "Chinese",
      target_lang: "Vietnamese",
      terms: Object.entries(ent).filter(([zh]) => u.zh.includes(zh)).map(([zh, v]) => ({ source: zh, target: v })),
    };
    const ref = (await llm.chat(mtModel, [{ role: "user", content: u.zh }], {
      extra: { translation_options: opts }, temperature: 0.0, maxTokens: 800,
    })).text.trim();

    const msgs = [
      { role: "system", content: TRANS_SYS },
      {
        role: "user",
        content: sheetTxt
          + `\n\nCâu này bị sót chữ Hán. Viết lại cho sạch, giữ nguyên giọng và xưng hô.\n`
          + `Gốc: ${u.zh}\nBản lỗi: ${t}\nBản máy dịch tham khảo (đúng nghĩa, sai giọng): ${ref}\n`
          + `Trả JSON {"${i}":"<bản sạch>"}`,
      },
    ];
    let fixed = "";
    try {
      const r = await llm.chat(model, msgs, { jsonMode: true, maxTokens: 1500, temperature: 0.2 });
      fixed = String(jparse(r.text)[String(i)] ?? "").trim();
    } catch {
      fixed = "";
    }
    vi[i] = fixed && !CJK.test(fixed) ? fixed : !CJK.test(ref) ? ref : t;
  }
  return vi;
}
