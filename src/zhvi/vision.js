/**
 * Kênh hình của pass B: đặt tên cụm giọng bằng khẩu hình (qwen-vl-max).
 *
 * Không hỏi từng câu. Cụm diarize đã thuần 92–95%, thứ còn thiếu chỉ là ĐẶT TÊN cho cụm —
 * nên mỗi cụm chỉ lấy vài câu MỎ NEO rồi bỏ phiếu. Đo trên 2 tập: đặt tên cụm đúng 9/9 và
 * 2/3, trong khi hỏi VLM từng câu chỉ 68–70% mà đắt gấp 3.
 *
 * Hai thứ đã đo, đừng chỉnh lại theo cảm tính:
 * - Số khung có tác dụng thật: 1 khung 23/50 → 4 khung 31/50 → 8 khung 34/50 câu đúng.
 * - Hỏi "một phán quyết cho cả 8 khung" làm cảnh chèn (tranh thuỷ mặc, cận vật) pha loãng
 *   khung tốt → VLM từ chối oan. Prompt phải là "chỉ cần MỘT khung thấy miệng động".
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { bibleHit } from "./bible.js";
import { jparse } from "./llm.js";
import { VISION_SYS } from "./prompts.js";

const pexec = promisify(execFile);

export const NA = ["ngoai_khung", "khong_chac", "?parse"];
const CAP = 7; // trần mỏ neo cho một cụm; quá đó thì phiếu thứ 8 gần như không đổi kết quả

/** Một khung JPEG tại giây t, trả về data URI. */
export async function grab(video, t, width) {
  const { stdout } = await pexec(
    "ffmpeg",
    ["-v", "error", "-ss", t.toFixed(3), "-i", video, "-frames:v", "1",
     "-vf", `scale=${width}:-2`, "-f", "image2pipe", "-vcodec", "mjpeg", "-"],
    { encoding: "buffer", maxBuffer: 64 * 1024 * 1024 },
  );
  return "data:image/jpeg;base64," + stdout.toString("base64");
}

/**
 * Mô tả dàn nhân vật cho VLM nhìn mà nhận mặt.
 *
 * Trường `look` là mô tả ngoại hình do người soát viết; không có thì tạm dùng `note`
 * (vai trò trong truyện) — yếu hơn nhiều, VLM sẽ hay trả "khong_chac".
 */
export function castText(bib) {
  return bib.cast
    .map((c) => {
      const d = c.look || c.note || "";
      return `- ${c.zh} (${c.vi || ""})${d ? ": " + d : ""}`;
    })
    .join("\n");
}

/** Hỏi VLM một câu thoại. Trả {pred, why, t}; pred có thể là ngoai_khung/khong_chac. */
export async function ask(llm, video, u, castTxt, { frames = 8, width = 768, model = "deepseek-flash" } = {}) {
  const a = u.start;
  const b = u.end;
  // trải đều trong câu, tránh sát hai mép (hay dính khung chuyển cảnh)
  const ts = Array.from({ length: frames }, (_, i) => a + ((b - a) * (i + 0.5)) / frames);
  const content = [{
    type: "text",
    text: `NHÂN VẬT CÓ THỂ CÓ:\n${castTxt}\n\n`
      + `Câu thoại (tiếng Trung): 「${u.zh}」\n`
      + `Dưới đây là ${frames} khung liên tiếp trong đúng câu này, cách nhau ${((b - a) / frames).toFixed(2)}s:`,
  }];
  for (const t of ts) content.push({ type: "image_url", image_url: { url: await grab(video, t, width) } });

  try {
    const r = await llm.chat(model, [
      { role: "system", content: VISION_SYS },
      { role: "user", content },
    ], { temperature: 0.0, maxTokens: 300 });
    const ans = jparse(r.text);
    return { pred: String(ans.speaker || "?parse"), why: String(ans.ly_do || ""), t: a };
  } catch (ex) {
    return { pred: "?parse", why: String(ex?.message || ex).slice(0, 160), t: a };
  }
}

/**
 * Chọn n câu mỏ neo cho một cụm: dài nhất trong mỗi khoảng thời gian của cụm.
 *
 * Chỉ lấy câu dài nhất thì mỏ neo hay dồn vào một cảnh, không phát hiện được cụm lẫn
 * hai người; chỉ trải đều thì dính câu 0,4s không đủ khung. Nên làm cả hai.
 */
function anchors(lines, n) {
  const xs = [...lines].sort((a, b) => a.start - b.start);
  if (xs.length <= n) return xs;
  const k = Math.ceil(xs.length / n);
  const out = [];
  for (let i = 0; i < xs.length; i += k) {
    const bin = xs.slice(i, i + k);
    out.push(bin.reduce((best, u) => (u.end - u.start > best.end - best.start ? u : best)));
  }
  return out.slice(0, n);
}

/** Đặt tên cho từng cụm giọng. Trả cả phiếu bầu để pass B tự phán, đừng chốt hộ nó. */
export async function nameClusters(llm, utts, video, bib, {
  frames = 8, width = 768, anchorsPerCluster = 3, budget = 30, model = "deepseek-flash", log = null,
} = {}) {
  llm.tag = "B-vision";
  const castTxt = castText(bib);
  const byCluster = new Map();
  for (const u of utts) {
    if (!byCluster.has(u.speaker)) byCluster.set(u.speaker, []);
    byCluster.get(u.speaker).push(u);
  }

  // Mỗi cụm được `anchorsPerCluster` mỏ neo trước đã, rồi phần ngân sách còn thừa rót thêm
  // cho cụm to nhất — một phiếu bầu 5/5 chắc hơn 3/3 nhiều, mà cụm to sai thì hỏng nhiều câu nhất.
  const order = [...byCluster.keys()].sort((a, b) => byCluster.get(b).length - byCluster.get(a).length);
  const plan = new Map();
  let left = budget;
  order.forEach((c, i) => {
    const n = Math.min(anchorsPerCluster, byCluster.get(c).length, Math.max(1, left - (order.length - i - 1)));
    plan.set(c, n);
    left -= n;
  });
  while (left > 0) {
    let grew = false;
    for (const c of order) {
      if (left > 0 && plan.get(c) < Math.min(byCluster.get(c).length, CAP)) {
        plan.set(c, plan.get(c) + 1);
        left -= 1;
        grew = true;
      }
    }
    if (!grew) break;
  }

  const lines = {};
  for (const c of order) {
    for (const u of anchors(byCluster.get(c), plan.get(c))) {
      const r = await ask(llm, video, u, castTxt, { frames, width, model });
      lines[u.id] = r;
      log?.info?.(`    ${c} #${u.id} -> ${r.pred}  ${r.why.slice(0, 60)}`);
    }
  }
  return { model, frames, lines, clusters: tally(lines, utts, bib) };
}

/** Đếm phiếu ra tên cụm. Tách khỏi phần hỏi để đổi luật không phải gọi lại VLM. */
export function tally(lines, utts, bib) {
  const size = new Map();
  for (const u of utts) size.set(u.speaker, (size.get(u.speaker) || 0) + 1);
  const of = new Map(utts.map((u) => [u.id, u.speaker]));

  const votes = new Map();
  const probed = new Map();
  for (const [i, r] of Object.entries(lines)) {
    const c = of.get(Number(i));
    if (c === undefined) continue;
    if (!probed.has(c)) probed.set(c, []);
    probed.get(c).push(Number(i));
    if (!NA.includes(r.pred)) {
      if (!votes.has(c)) votes.set(c, {});
      const v = votes.get(c);
      v[r.pred] = (v[r.pred] || 0) + 1;
    }
  }

  const out = {};
  for (const c of size.keys()) {
    const v = votes.get(c) || {};
    const rank = Object.entries(v).sort((a, b) => b[1] - a[1]);
    const top = rank.length ? rank[0][1] : 0;
    const runner = rank.length > 1 ? rank[1][1] : 0;
    const best = Object.entries(v).filter(([, n]) => n === top).map(([k]) => k);
    const hit = best.length === 1 ? bibleHit(bib, best[0]) : null;
    // "Cụm chứa hai người" là kết luận NẶNG — nó đẩy cả cụm sang cho người soi, nên chỉ
    // được dùng ở đúng chỗ đã đo là hỏng thật: cụm 2-3 câu chứa đúng 2 người. Ở cụm to
    // thì phiếu lệch KHÔNG phải dấu hiệu cụm lẫn: VLM hay trả lời "ai đang trong khung"
    // ở cảnh phản ứng (đo được: cụm 小钻风 28 câu bị gọi 白骨夫人 2 lần vì máy quay đang
    // chiếu mặt cô ta lúc anh ta nói). Câu lệch đó đã bị bắt riêng ở suspectLines.
    out[c] = {
      votes: v,
      probed: (probed.get(c) || []).sort((a, b) => a - b),
      size: size.get(c),
      name: hit ? hit.zh : best.length === 1 ? best[0] : null,
      cid: hit ? hit.id : null,
      split: rank.length > 1 && size.get(c) <= 3,
      sure: top >= 2 && best.length === 1 && top > runner,
    };
  }
  return out;
}

/**
 * Dùng lại phán quyết cũ, nhưng chỉ khi id câu còn trỏ đúng chỗ cũ.
 *
 * Pass A gộp/tách câu nên id trôi giữa các lần chạy; lấy nhầm phán quyết của câu khác
 * thì sai lặng lẽ, không có lỗi nào nổ ra. Nên đối chiếu mốc thời gian trước khi tin.
 * Phiếu thì đếm lại chứ không đọc từ cache — đổi luật đếm khỏi phải gọi VLM lần nữa.
 */
export function revalidate(cached, utts, bib, log = null) {
  if (!cached) return null;
  const at = new Map(utts.map((u) => [u.id, u.start]));
  for (const [i, r] of Object.entries(cached.lines || {})) {
    const t0 = at.get(Number(i));
    if (r.t === undefined || r.t === null || t0 === undefined || Math.abs(t0 - r.t) > 0.01) {
      log?.warn?.(`kênh hình: câu ${i} đã đổi mốc thời gian -> bỏ cache, hỏi lại`);
      return null;
    }
  }
  return { ...cached, clusters: tally(cached.lines || {}, utts, bib) };
}
