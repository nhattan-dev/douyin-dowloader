/**
 * Pass B — gán người nói. Sáu công đoạn con:
 *   B1 vision     khẩu hình đặt tên cụm          (VLM, đắt — xem vision.js)
 *   B2 align      model đọc kịch bản, có trích dẫn (LLM)
 *   B3 vocative   regex: ai BỊ GỌI tên           (code, miễn phí)
 *   B4 arbitrate  trọng tài ba nguồn -> 4 mức    (code, miễn phí)
 *   B5 human      nhãn người soát thắng tất cả   (code, miễn phí)
 *   B6 sheet      dựng hồ sơ dịch từ bible       (code, miễn phí)
 *
 * B3–B6 miễn phí nên KHÔNG bao giờ checkpoint: dựng lại mỗi lần chạy, sửa nhãn xong
 * chạy lại là thấy ngay. Chỉ B1/B2 tốn tiền mới có chữ ký.
 */
import { bibleHit } from "../bible.js";
import { jparse } from "../llm.js";
import { ALIGN_SYS, CAST_SYS } from "../prompts.js";

const uniq = (xs) => [...new Set(xs)];
export const relevantGlossary = (gloss, text) =>
  Object.fromEntries(Object.entries(gloss || {}).filter(([k]) => text.includes(k)));

// ---------- B2: khớp tập vào bible series ----------

/**
 * Không suy lại dàn nhân vật — chỉ khớp cụm giọng của TẬP này vào bible đã chốt.
 * Trả về JSON thô của model; phần kết luận là việc của verifyAlign (code), không phải model.
 */
export async function alignCast(llm, utts, bib, { model, epTitle = null }) {
  llm.tag = "B-align";
  const script = utts.map((u) => `${u.id} [${u.start}] ${u.speaker}: ${u.zh}`).join("\n");
  const cast = bib.cast
    .map((c) => `  ${c.id} = ${c.zh} (${c.vi || ""}) — ${c.note || ""}${c.alias?.length ? "; còn gọi: " + c.alias.join(", ") : ""}`)
    .join("\n");
  const terms = Object.values(bib.terms).map((t) => t.vi).sort().join(", ");
  const msgs = [
    { role: "system", content: ALIGN_SYS },
    {
      role: "user",
      content:
        (epTitle ? `TÊN TẬP (tác giả tự đặt, thường chính là nhân vật chính của tập): ${epTitle}\n\n` : "")
        + "HỒ SƠ SERIES — nhân vật:\n" + cast
        + "\n\nThuật ngữ đã có (đừng đề xuất lại): " + terms.slice(0, 3000)
        + "\n\nKỊCH BẢN TẬP NÀY:\n" + script,
    },
  ];
  const r = await llm.chat(model, msgs, { jsonMode: true, maxTokens: 4000, temperature: 0.2 });
  return jparse(r.text);
}

// ---------- B3: bằng chứng xưng hô, code tự rút ra ----------

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Tên đứng đầu câu trước dấu phẩy (hoặc cuối câu sau dấu phẩy) là GỌI người khác.
 *
 * Đây là chỗ model hay nhầm nhất và cũng là chỗ code chắc chắn nhất: ở «大王，计划出了意外。»
 * nó khai là tự xưng 大王, kiểm bằng chuỗi thì đúng, kiểm bằng cú pháp thì sai — người nói
 * đang thưa với đại vương, nên chính họ không phải đại vương.
 */
export function isVocative(text, name) {
  const n = esc(name);
  return new RegExp(`^${n}[，,、]`).test(text) || new RegExp(`[，,、]${n}[？！。]?$`).test(text);
}

/** Bằng chứng code tự rút ra được, không cần hỏi model: ai bị gọi tên ở dòng nào. */
/**
 * Tên người được GỌI trong thoại («大王，…» / «…，师父») mà dàn nhân vật chưa có.
 *
 * Để làm gì: người duyệt không đọc và không gõ được chữ Hán, nên muốn thêm một nhân vật máy bỏ
 * sót thì phải có sẵn danh sách tên để CHỌN. Đây là nguồn lấy được mà không tốn thêm lượt LLM
 * nào, và lọc theo vị trí gọi tên nên phần lớn là tên người thật chứ không phải thuật ngữ.
 */
export function vocativeNames(eps, known = [], { max = 12, minCount = 2 } = {}) {
  const dup = (nm) => known.some((k) => k && (k.includes(nm) || nm.includes(k)));
  const RE = [/^([一-鿿]{2,4})[，,、]/, /[，,、]([一-鿿]{2,4})[？！。?!]?$/];
  const hits = new Map();
  for (const d of eps) {
    for (const u of d.utts) {
      for (const re of RE) {
        const nm = u.zh.match(re)?.[1];
        if (!nm || dup(nm)) continue;
        const e = hits.get(nm) || { zh: nm, count: 0, ep: d.ep, line: null };
        e.count += 1;
        if (!e.line || u.end - u.start > e.line.end - e.line.start) {
          e.line = u;
          e.ep = d.ep;
        }
        hits.set(nm, e);
      }
    }
  }
  return [...hits.values()].filter((x) => x.count >= minCount)
    .sort((a, b) => b.count - a.count).slice(0, max);
}

export function vocativeEvidence(utts, bib) {
  const out = [];
  for (const c of bib.cast) {
    for (const nm of uniq([c.zh, ...(c.alias || [])])) {
      if (!nm || nm.length < 2) continue;
      for (const u of utts) {
        if (isVocative(u.zh, nm)) out.push({ line: u.id, name: nm, cast: c.id, by: u.speaker });
      }
    }
  }
  return out;
}

// ---------- B4: trọng tài ----------

/**
 * Trọng tài ba nguồn bằng chứng cho từng cụm giọng. Code quyết, không model nào quyết.
 *
 * Ba nguồn độc lập nhau về cơ chế nên sai của chúng ít trùng nhau:
 *   vocative  regex, không tốn gì — ai BỊ GỌI tên thì KHÔNG phải người nói câu đó
 *   text      alignCast đọc kịch bản, có trích dẫn được code kiểm lại
 *   hình      khẩu hình, không biết gì về nội dung thoại
 *
 * Bốn mức, để người chỉ phải nhìn chỗ máy tự nhận là không chắc:
 *   confirmed  hai nguồn trở lên cùng chỉ một nhân vật, không bị vocative bác
 *   single     chỉ một nguồn có ý kiến
 *   conflict   hai nguồn cãi nhau, hoặc vocative bác chính cái tên được chọn
 *   split      kênh hình thấy cụm này có từ hai người -> phải soi từng câu
 * Không chạy kênh hình thì giữ nguyên nghĩa cũ: có trích dẫn kiểm được = confirmed.
 */
export function arbitrate(textMap, verified, utts, bib, vision, vocatives) {
  const byId = Object.fromEntries(bib.cast.map((c) => [c.id, c]));
  const vis = vision?.clusters || {};
  // ai tự tay gọi tên nhân vật nào thì chính họ không phải nhân vật đó
  const veto = new Map();
  for (const v of vocatives) {
    if (!veto.has(v.by)) veto.set(v.by, new Set());
    veto.get(v.by).add(v.cast);
  }

  const out = {};
  for (const spk of uniq(utts.map((u) => u.speaker))) {
    const t = textMap[spk] ?? null;
    const tv = verified.has(spk);
    const vc = vis[spk] || {};
    const h = vc.cid ?? null;
    const hs = Boolean(vc.sure);
    const vt = veto.get(spk) || new Set();

    let cid;
    let lvl;
    let why;
    if (t && h && t === h) {
      [cid, lvl, why] = [t, "confirmed", "text + hình cùng chỉ một người"];
    } else if (t && h) {
      // trích dẫn đã được code mở ra kiểm thì mạnh hơn khẩu hình; ngược lại tin mắt
      cid = tv ? t : h;
      lvl = "conflict";
      why = `text=${t} nhưng hình=${h} -> theo ${tv ? "text (có trích dẫn)" : "hình"}`;
    } else if (t) {
      // Trích dẫn tự xưng đã được code mở đúng dòng ra kiểm thì tự nó đủ chắc; kênh hình
      // im lặng là chuyện thường (thoại ngoài khung, cảnh chèn) chứ không phải phản đối.
      cid = t;
      lvl = tv ? "confirmed" : "single";
      why = tv ? "text có trích dẫn kiểm được" : "chỉ có kênh text, không trích dẫn được";
    } else if (h) {
      [cid, lvl, why] = [h, "single", "chỉ có kênh hình"];
    } else {
      [cid, lvl, why] = [null, "none", "không nguồn nào gọi được tên"];
    }

    if (cid && vt.has(cid)) {
      lvl = "conflict";
      const n = vocatives.filter((v) => v.by === spk && v.cast === cid).length;
      why += `; nhưng chính cụm này gọi tên ${byId[cid].zh} ở ${n} dòng`;
    }
    if (vc.split) {
      lvl = "split";
      why = `kênh hình thấy nhiều người trong cùng cụm: ${JSON.stringify(vc.votes)}`;
    }

    out[spk] = {
      cid, level: lvl, why,
      text: t, textVerified: tv, vision: h, visionSure: hs,
      veto: [...vt].sort(),
      size: utts.filter((u) => u.speaker === spk).length,
      votes: vc.votes ?? null,
      probed: vc.probed || [],
    };
  }
  return out;
}

/** Câu nào người phải tự nhìn. Mở rộng dần từ cụm xuống câu, không gộp một cục. */
export function suspectLines(utts, clusters, vision, vocatives, asr = null) {
  const susp = {};
  const mark = (i, why) => {
    (susp[String(i)] ||= []).push(why); // khoá là chuỗi để còn sống sót qua JSON
  };

  for (const u of utts) {
    const c = clusters[u.speaker] || {};
    if (["conflict", "split", "none", "single"].includes(c.level)) mark(u.id, "cụm " + c.level);
  }
  // câu đã hỏi kênh hình mà nó gọi tên khác tên của cụm -> nghi đúng câu đó, không nghi cả cụm
  const by = new Map(utts.map((u) => [u.id, u]));
  for (const [k, r] of Object.entries(vision?.lines || {})) {
    const i = Number(k);
    const u = by.get(i);
    if (!u || ["ngoai_khung", "khong_chac", "?parse"].includes(r.pred)) continue;
    const cid = clusters[u.speaker]?.cid;
    if (cid && r.cid && r.cid !== cid) mark(i, "hình gọi tên khác");
  }
  for (const v of vocatives) {
    if (clusters[v.by]?.cid === v.cast) mark(v.line, "dòng này gọi tên chính nhân vật được gán");
  }
  // cờ của lượt gộp series: nó đọc cả bộ nên thấy được câu lệch vai mà một tập không lộ
  for (const c of Object.values(asr?.clusters || {})) {
    for (const i of Object.keys(c.lines)) if (by.has(Number(i))) mark(i, "máy gộp series: câu của người khác trong cụm");
  }
  for (const i of Object.keys(asr?.lines || {})) if (by.has(Number(i))) mark(i, "máy gộp series: một câu chứa lời nhiều người");
  return susp;
}

/** Nhãn đặc biệt của người soát mà nghĩa là "KHÔNG phải một người xác định". */
export const NOBODY = new Set(["nhiều người", "không rõ"]);

/**
 * Cờ ASR của lượt gộp series (`asr-flags.json`) -> dạng pass B dùng được cho tập này.
 *
 * Cờ ghi lúc `series init`, còn tập thì có thể đã chạy lại pass A: câu nào chữ Hán không còn
 * khớp nguyên văn thì bỏ, không đoán — id trôi mà vẫn áp là gán nhầm lặng lẽ (bẫy B1).
 * Nhân vật ghi bằng tên (zh + vi), không bằng id: trang duyệt bible được quyền đánh số lại.
 */
export function asrFlagsFor(raw, utts, bib) {
  if (!raw || !bib) return null;
  const by = new Map(utts.map((u) => [u.id, u]));
  const same = (i, zh) => by.get(Number(i))?.zh === zh;
  const who = (w) => (w ? bibleHit(bib, w.zh) || bibleHit(bib, w.vi) : null)?.id ?? null;
  const out = { clusters: {}, lines: {}, dropped: 0 };
  for (const [spk, c] of Object.entries(raw.clusters || {})) {
    const lines = {};
    for (const [i, l] of Object.entries(c.lines || {})) {
      const cid = who(l.who);
      if (same(i, l.zh) && by.get(Number(i)).speaker === spk && cid) lines[i] = cid;
      else out.dropped += 1;
    }
    if (Object.keys(lines).length) out.clusters[spk] = { lines, why: String(c.why || "") };
  }
  for (const [i, l] of Object.entries(raw.lines || {})) {
    if (!same(i, l.zh)) {
      out.dropped += 1;
      continue;
    }
    out.lines[i] = { who: (l.who || []).map(who).filter(Boolean), why: String(l.why || "") };
  }
  return Object.keys(out.clusters).length || Object.keys(out.lines).length ? out : null;
}

/**
 * B4 — cờ lượt gộp series lên cụm: cụm bị khai là lẫn người thì hạ về `split` (trừ khi người
 * soát đã chốt), để cổng dừng và trang soát mở sẵn phần chia cụm với gợi ý từng câu.
 */
export function applyAsrFlags(align, utts, asr) {
  if (!asr) return align;
  align.asr = asr;
  for (const [spk, f] of Object.entries(asr.clusters)) {
    const c = align.clusters[spk];
    if (!c) continue;
    // KHÔNG hạ cả cụm xuống "split": cờ chỉ nói vài câu lệch vai, hạ cả cụm là mọi câu thành
    // câu nghi + mất mẫu giọng (ai-qing tập 1: 8/12 cụm bị cờ). Chỉ đúng các câu được liệt kê.
    c.asr = f;
    c.why = [c.why, `máy gộp series: ${Object.keys(f.lines).length} câu của người khác${f.why ? " — " + f.why : ""}`]
      .filter(Boolean).join("; ");
  }
  align.suspects = suspectLines(utts, align.clusters, align.vision, align.vocatives || [], asr);
  return align;
}

/**
 * Kiểm từng trích dẫn trên chính kịch bản, rồi CODE mới kết luận.
 *
 * Model tự kết luận thì hay tự cãi chính mình giữa chừng: đo được ở tập 1, nó luận ra đúng
 * «S2 là Ngọc Diện Hồ Ly (C2)» rồi viết tiếp một đoạn dài và chốt ngược lại thành C4.
 * Ở đây model chỉ được nêu bằng chứng có số dòng; trích không đúng thì bằng chứng bị loại.
 */
export function verifyAlign(align, utts, bib, vision = null) {
  const byId = Object.fromEntries(bib.cast.map((c) => [c.id, c]));
  const names = Object.fromEntries(bib.cast.map((c) => [c.id, new Set([c.zh, ...(c.alias || [])])]));
  const line = new Map(utts.map((u) => [u.id, u]));
  const smap = {};
  const unmapped = [];
  const bad = [];

  const rows = align.speakers
    || Object.entries(align.speakerMap || {}).map(([k, v]) => ({ speaker: k, cast: v, conf: 1, evidence: [] }));

  for (const row of rows) {
    const spk = row.speaker;
    const cid = row.cast;
    if (!spk || !(cid in byId)) continue;
    const good = [];
    for (const e of row.evidence || []) {
      const u = line.get(e.line);
      const nm = e.name || "";
      const ty = e.type;
      if (!u || !nm || !u.zh.includes(nm)) {
        bad.push(`${spk}: dòng ${e.line} không chứa ${JSON.stringify(nm)}`);
        continue;
      }
      if (!names[cid].has(nm)) {
        bad.push(`${spk}: ${JSON.stringify(nm)} không phải tên của ${cid}`);
        continue;
      }
      if (ty === "selfName" && u.speaker !== spk) {
        bad.push(`${spk}: dòng ${u.id} do ${u.speaker} nói, không phải tự xưng`);
        continue;
      }
      if (ty === "selfName" && isVocative(u.zh, nm)) {
        bad.push(`${spk}: dòng ${u.id} là GỌI ${JSON.stringify(nm)} chứ không phải tự xưng`);
        continue;
      }
      if (ty === "addressed" && u.speaker === spk) {
        bad.push(`${spk}: dòng ${u.id} chính ${spk} nói, nên không phải bị gọi tên`);
        continue;
      }
      good.push(e);
    }
    row.evidence = good;
    row.verified = good.length > 0;
  }

  const vis = vision?.clusters || {};
  // cụm giọng có bằng chứng kiểm được thì chốt trước, phần còn lại mới xếp vào chỗ trống
  const ordered = [...rows].sort((a, b) => {
    const av = a.verified ? 0 : 1;
    const bv = b.verified ? 0 : 1;
    return av - bv || Number(b.conf || 0) - Number(a.conf || 0);
  });
  for (const row of ordered) {
    const spk = row.speaker;
    const cid = row.cast;
    if (!(cid in byId) || spk in smap) continue;
    // Hai cụm cùng một nhân vật là chuyện THƯỜNG: vỡ vụn cụm là chế độ hỏng chính của
    // diarize (một người bị tách 2-3 cụm) và nó vô hại miễn là mảnh nào cũng có tên.
    // Chỉ chặn khi không nguồn nào bảo đảm cho cụm này.
    if (Object.values(smap).includes(cid) && !row.verified && vis[spk]?.cid !== cid) {
      unmapped.push({
        speaker: spk, zh: byId[cid].zh,
        why: "trùng nhân vật đã chốt bằng bằng chứng, không đủ căn cứ riêng",
      });
      continue;
    }
    smap[spk] = cid;
  }

  const textMap = { ...smap };
  const verified = new Set(rows.filter((r) => r.verified).map((r) => r.speaker));

  align.vocatives = vocativeEvidence(utts, bib);
  if (vision) {
    // kênh hình gọi được tên cho cụm mà kênh text bỏ sót
    for (const [spk, c] of Object.entries(vis)) {
      if (c.cid in byId && !(spk in smap)) smap[spk] = c.cid;
    }
    for (const r of Object.values(vision.lines || {})) {
      const hit = bibleHit(bib, r.pred);
      r.cid = hit ? hit.id : null;
    }
  }

  align.clusters = arbitrate(textMap, verified, utts, bib, vision, align.vocatives);
  align.speakerMap = Object.fromEntries(
    Object.entries(align.clusters).filter(([, v]) => v.cid).map(([k, v]) => [k, v.cid]),
  );
  align.suspects = suspectLines(utts, align.clusters, vision, align.vocatives);
  align.vision = vision;
  align.unmapped = [
    ...unmapped.filter((u) => !(u.speaker in align.speakerMap)),
    ...(align.unmapped || []),
  ];
  align.rejectedEvidence = bad;
  return align;
}

// ---------- B5: cổng người ----------

/**
 * Nhãn người soát thắng mọi kênh máy — và SỬA utts tại chỗ.
 *
 * Quy tắc số 1 của cổng người: chạy lại pipeline phải đè lên pass B chứ không hỏi lại.
 * Đã mất nhãn soát tay một lần vì `npm run stt` ghi đè, đừng lặp lại ở đây.
 *
 * Nhãn cấp CỤM chỉ đổi tên cụm. Nhãn cấp CÂU thì phải chuyển câu đó sang cụm của nhân vật
 * được chọn — vì mọi thứ phía sau (xưng hô, voice, dub) khoá theo cụm chứ không theo câu.
 */
export function applySpeakers(utts, align, bib, labels) {
  const clLbl = labels.clusters || {};
  const lnLbl = labels.lines || {};
  const cc = (align.clusters ||= {});
  const smap = (align.speakerMap ||= {});
  const unknown = [];
  let moved = 0;

  for (const [spk, name] of Object.entries(clLbl)) {
    const hit = bibleHit(bib, name);
    if (!hit) {
      unknown.push({ where: "cụm " + spk, label: name });
      // KHÔNG gỡ tên: speaker null thì dub bỏ câu, mà nền demucs đã tách hết tiếng người -> câu
      // câm hẳn. Giữ giọng chủ cụm cho tới khi có đường tách câu; chỉ cấm làm mẫu giọng.
      if (NOBODY.has(name)) cc[spk] = { ...(cc[spk] || {}), mixed: name };
      continue;
    }
    smap[spk] = hit.id;
    cc[spk] = { ...(cc[spk] || {}), cid: hit.id, level: "human", why: "người soát chốt: " + hit.zh };
  }

  const keyByCid = new Map();
  for (const [spk, cid] of Object.entries(smap)) if (!keyByCid.has(cid)) keyByCid.set(cid, spk);

  const by = new Map(utts.map((u) => [u.id, u]));
  const guessed = new Set((labels.guessed || []).map(String));
  for (const [k, name] of Object.entries(lnLbl)) {
    const u = by.get(Number(k));
    if (!u) continue;
    u.speakerSource = guessed.has(String(k)) ? "fleex-accepted" : "fleex";
    const hit = bibleHit(bib, name);
    if (!hit) {
      // "ngoài khung" / "nhiều người" / "không rõ"
      unknown.push({ where: "câu " + k, label: name });
      // "ngoài khung" chỉ nói là không thấy mặt. Hai nhãn kia: vẫn giữ trong cụm (rút ra thì
      // speaker null -> dub câm câu này), chỉ cấm làm mẫu giọng.
      if (NOBODY.has(name)) u.mixed = name;
      continue;
    }
    if (smap[u.speaker] === hit.id) continue;
    let tgt = keyByCid.get(hit.id);
    if (tgt === undefined) {
      // nhân vật chưa có cụm nào trong tập -> dựng cụm ảo
      tgt = "H" + hit.id;
      smap[tgt] = hit.id;
      keyByCid.set(hit.id, tgt);
      cc[tgt] = {
        cid: hit.id, level: "human", why: "cụm do người soát tách ra",
        text: null, vision: null, veto: [], size: 0,
      };
    }
    u.speaker = tgt;
    moved += 1;
  }

  for (const spk of uniq([...Object.keys(cc), ...utts.map((u) => u.speaker)])) {
    cc[spk] ||= {};
    cc[spk].level ??= "none";
    cc[spk].size = utts.filter((u) => u.speaker === spk).length;
  }
  align.speakerMap = Object.fromEntries(Object.entries(cc).filter(([, v]) => v.cid).map(([k, v]) => [k, v.cid]));
  const answered = new Set(Object.keys(lnLbl).map(String));
  align.suspects = Object.fromEntries(
    Object.entries(suspectLines(utts, cc, align.vision, align.vocatives || [], align.asr))
      .filter(([i]) => !answered.has(i)),
  );
  align.human = { clusters: clLbl, lines: lnLbl, moved, unknown };
  return align;
}

// ---------- cổng người soát (giữa B và C) ----------

/**
 * Máy còn chỗ nào chưa chắc thì dừng cho người nhìn, TRƯỚC khi trả tiền dịch.
 * Gán nhầm người nói mà phát hiện sau pass C là dịch lại từ đầu, còn xưng hô sai
 * thì lan ra cả tập.
 *
 * Đã có nhãn người soát cho tập này thì cổng mở: người đã nhìn rồi. Không có luật
 * này thì cổng chặn mãi — soát xong vẫn còn câu nghi là chuyện bình thường
 * (đo trên tập 2: chốt 1 cụm + 1 câu, số câu nghi 8 -> 6 chứ không về 0).
 *
 * Không có bible thì LUÔN cần soát. Đường không-bible bỏ qua B1/B3/B4 nên `align` rỗng —
 * trước đây hàm này đọc align rỗng thành "máy chắc hết" và cổng mở lặng lẽ, trong khi
 * đó chính là đường ÍT chắc nhất: người nói do một lượt LLM đoán, không kênh hình, và
 * không có trang soát. Chỗ chữa đúng là dựng bible (`series init`), không phải soát tay.
 */
/**
 * Thứ tập này phát hiện ra mà bible CHƯA có: cụm giọng không gán được ai, và thuật ngữ mới.
 *
 * "Đã trả lời" tính theo TỪNG MỤC chứ không theo tập: có `ep<N>.speakers.json` nghĩa là người
 * đã nhìn tập này, nhưng một nhân vật mới xuất hiện ở lần chạy sau thì vẫn phải hỏi. Ngược lại,
 * mục nào người đã quyết rồi (kể cả quyết là BỎ) thì không hỏi lại — nếu không cổng chặn mãi.
 */
export function growthPending(align, labels = null, bible = null) {
  const doneC = new Set(Object.keys(labels?.clusters || {}));
  const doneT = new Set([...Object.keys(labels?.terms || {}), ...(labels?.termsDropped || [])]);
  // Cụm KHÔNG còn câu nào thì không có gì để đặt tên: LLM đã gán từng câu cho người khác hết
  // (ca thật: ai-qing ep01 cụm S3 "lẫn nhiều người" -> 0 câu). Trang soát vẽ nó với 0 câu, không
  // có câu mẫu để nghe, nên người soát không có gì để bấm -> cổng chặn mãi.
  const clusters = Object.entries(align?.clusters || {})
    .filter(([spk, c]) => !c.cid && !doneC.has(spk) && (c.size ?? 0) > 0)
    .map(([spk]) => spk);
  const terms = Object.keys(align?.newTerms || {})
    .filter((zh) => !(bible?.terms && zh in bible.terms) && !doneT.has(zh));
  const bits = [
    ...(clusters.length ? [`${clusters.length} cụm chưa có tên (${clusters.join(" ")})`] : []),
    ...(terms.length ? [`${terms.length} thuật ngữ mới`] : []),
  ];
  return { need: bits.length > 0, clusters, terms, why: bits.join(", ") };
}

export function reviewNeeded(align, labels = null, { hasBible = true, bible = null } = {}) {
  if (!hasBible) {
    return {
      need: true, suspects: 0, weak: [], noBible: true,
      why: "series chưa có bible — người nói do máy đoán, không kênh hình, không trang soát",
    };
  }
  const suspects = Object.keys(align?.suspects || {}).length;
  const weak = Object.entries(align?.clusters || {})
    .filter(([, c]) => !["confirmed", "human"].includes(c.level))
    .map(([k, c]) => `${k}:${c.level}`);
  const bits = [
    ...(weak.length ? [`cụm chưa chắc ${weak.join(" ")}`] : []),
    ...(suspects ? [`${suspects} câu cần soi`] : []),
  ];
  const grow = growthPending(align, labels, bible);
  if (grow.need) bits.push(grow.why);
  // Đã soát tập này rồi thì chỉ mở cổng lại vì thứ bible còn THIẾU, không vì đuôi câu nghi:
  // soát xong vẫn còn câu nghi là chuyện bình thường (đo được: 8 -> 6, không về 0).
  if (labels) {
    return grow.need
      ? { need: true, suspects, weak, grow, why: `${grow.why} — tập đã soát, mở lại để bổ sung bible` }
      : { need: false, suspects, weak, grow, why: `đã có nhãn người soát (${labels.at || "?"})` };
  }
  if (!bits.length) return { need: false, suspects, weak, grow, why: "máy chắc hết" };
  return { need: true, suspects, weak, grow, why: bits.join(", ") };
}

// ---------- B6: hồ sơ dịch ----------

/** Dựng 'sheet' theo đúng hợp đồng cũ, nhưng nguồn là bible -> mọi tập nhất quán. */
export function sheetFromBible(bib, align, { ep = null, utts = null } = {}) {
  const byId = Object.fromEntries(bib.cast.map((c) => [c.id, c]));
  const smap = Object.fromEntries(Object.entries(align.speakerMap || {}).filter(([, v]) => v in byId));

  // cụm giọng nào khớp mà KHÔNG có trích dẫn kiểm được thì phải nói rõ là đoán,
  // đừng để nó trôi xuống bản dịch như một cái tên chắc chắn
  const cc = align.clusters || {};
  let guess;
  if (Object.keys(cc).length) {
    guess = new Set(Object.entries(cc).filter(([, v]) => !["confirmed", "human"].includes(v.level)).map(([k]) => k));
  } else {
    const ok = new Set((align.speakers || []).filter((r) => r.verified).map((r) => r.speaker));
    guess = new Set(Object.keys(smap).filter((k) => align.speakers && !ok.has(k)));
  }

  // Một nhân vật CÓ THỂ ứng với nhiều cụm giọng (diarize hay vỡ vụn), nên tra ngược
  // phải ra danh sách — nếu chỉ giữ một cụm thì bảng xưng hô bỏ sót đúng các mảnh kia.
  const chars = [];
  const keyOf = new Map();
  for (const [spk, cid] of Object.entries(smap)) {
    const c = byId[cid];
    if (!keyOf.has(cid)) keyOf.set(cid, []);
    keyOf.get(cid).push(spk);
    chars.push({
      key: spk, zh: c.zh, vi: c.viShort || c.vi || c.zh,
      gender: c.gender, role: c.note || "", voice: "",
      cid, guess: guess.has(spk), level: cc[spk]?.level ?? null,
    });
  }

  const present = utts ? new Set(utts.map((u) => u.speaker)) : null;
  for (const u of align.unmapped || []) {
    const spk = u.speaker;
    if (present && !present.has(spk)) continue; // model bịa ra cụm giọng không có trong tập
    const hit = bib.cast.find((c) => c.zh === u.zh || (c.alias || []).includes(u.zh)) || null;
    if (hit && spk && !(spk in smap)) {
      // đoán ra tên đã có sẵn trong bible -> khớp luôn
      smap[spk] = hit.id;
      if (!keyOf.has(hit.id)) keyOf.set(hit.id, []);
      keyOf.get(hit.id).push(spk);
      chars.push({
        key: spk, zh: hit.zh, vi: hit.viShort || hit.vi || hit.zh,
        gender: hit.gender, role: hit.note || "", voice: "", cid: hit.id,
      });
      continue;
    }
    if (spk && !(spk in smap)) {
      chars.push({
        key: u.speaker, zh: u.zh || "?", vi: "", gender: "?",
        role: "CHƯA KHỚP: " + (u.why || ""), voice: "",
      });
    }
  }

  const address = [];
  for (const a of bib.address) {
    if (ep && a.fromEp && /^\d+(\.\d+)?$/.test(String(a.fromEp)) && Number(a.fromEp) > Number(ep)) continue;
    for (const f of keyOf.get(a.from) || []) {
      for (const t of keyOf.get(a.to) || []) {
        address.push({ from: f, to: t, self: a.self, other: a.other, since: 0.0, why: a.why || "" });
      }
    }
  }

  const entities = Object.entries(bib.terms)
    .filter(([, v]) => v.approved)
    .map(([zh, v]) => ({ zh, vi: v.vi, type: "term", policy: "hanviet", case: "proper" }));

  return {
    premise: align.premise || "",
    characters: chars,
    address,
    entities,
    bibleVersion: bib.version,
  };
}

// ---------- B không có bible: tự suy hồ sơ (đường cũ) ----------

/** Cụm phim dùng đi dùng lại -> đúng những chỗ người đọc sẽ nhận ra nếu dịch trôi. */
export function repeatedTerms(zhAll, { minN = 2, maxN = 5, minCount = 2, top = 60 } = {}) {
  const c = new Map();
  const chars = [...zhAll];
  const isHan = (ch) => ch >= "\u4e00" && ch <= "\u9fff";
  for (let n = minN; n <= maxN; n++) {
    for (let i = 0; i + n <= chars.length; i++) {
      const g = chars.slice(i, i + n);
      if (g.every(isHan)) {
        const s = g.join("");
        c.set(s, (c.get(s) || 0) + 1);
      }
    }
  }
  const STOP = new Set("的了是你我他她不在也都会就来去个这那有和吧啊呢么很好人们上下要能没被把对给还");
  const keep = {};
  for (const [g, n] of [...c.entries()].sort((a, b) => b[1] - a[1])) {
    if (n < minCount) continue;
    if (STOP.has(g[0]) || STOP.has(g[g.length - 1])) continue; // cắt giữa cụm
    if (Object.keys(keep).some((h) => g !== h && h.includes(g) && c.get(h) >= n)) continue; // bỏ chuỗi con
    keep[g] = n;
    if (Object.keys(keep).length >= top) break;
  }
  return keep;
}

export async function castSheet(llm, utts, gloss, { model, pinned = null }) {
  llm.tag = "B-cast";
  const script = utts.map((u) => `${u.id} [${u.start}] ${u.speaker}: ${u.zh}`).join("\n");
  const zhAll = utts.map((u) => u.zh).join("");
  const cand = repeatedTerms(zhAll);
  const g = { ...relevantGlossary(gloss, zhAll), ...relevantGlossary(pinned || {}, zhAll) }; // pinned thắng glossary

  const msgs = [
    { role: "system", content: CAST_SYS },
    {
      role: "user",
      content:
        "GLOSSARY (bắt buộc dùng):\n" + Object.entries(g).map(([k, v]) => `${k} = ${v}`).join("\n")
        + "\n\nCỤM LẶP LẠI trong phim (phải ra phán quyết cho mọi cụm là tên riêng hoặc thuật ngữ "
        + "tiên hiệp; cụm nào chỉ là từ thường thì bỏ qua):\n"
        + Object.entries(cand).map(([k, v]) => `${k}(${v})`).join(", ")
        + "\n\nKỊCH BẢN:\n" + script,
    },
  ];
  const r = await llm.chat(model, msgs, { jsonMode: true, maxTokens: 6000, temperature: 0.2 });
  const sheet = jparse(r.text);

  const ruled = new Set([...(sheet.entities || []).map((e) => e.zh), ...(sheet.skipped || [])]);
  const missing = Object.keys(cand).filter((t) => !ruled.has(t) && ![...ruled].some((e) => e.includes(t)));
  if (missing.length) {
    msgs.push(
      { role: "assistant", content: r.text },
      {
        role: "user",
        content: `Chưa ra phán quyết cho các cụm sau: ${missing.join(", ")}\n`
          + 'Trả JSON {"entities":[...], "skipped":[...]} chỉ gồm các cụm này.',
      },
    );
    const r2 = await llm.chat(model, msgs, { jsonMode: true, maxTokens: 3000, temperature: 0.2 });
    const add = jparse(r2.text);
    sheet.entities = [...(sheet.entities || []), ...(add.entities || [])];
    sheet.skipped = [...(sheet.skipped || []), ...(add.skipped || [])];
  }
  return sheet;
}
