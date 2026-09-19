/**
 * Bible cấp series: trạng thái dùng chung giữa các tập, có version, chỉ lớn thêm.
 *
 * Mọi thứ máy suy ra đều mang approved=false cho tới khi người duyệt.
 * Dịch một tập = đọc bible ĐÃ ĐÓNG BĂNG; phát hiện mới rơi vào pending, không tự trộn.
 */
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { stable } from "./ckpt.js";

export const SCHEMA = 1;

export function slug(s) {
  const noMark = String(s)
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase();
  return noMark.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "series";
}

/** Hash nội dung có ý nghĩa — đổi cast/terms/address là đổi version, sửa ghi chú thì không. */
export function version(b) {
  const core = {
    cast: b.cast.map((c) => Object.fromEntries(Object.entries(c).filter(([k]) => k !== "note" && k !== "approved"))),
    terms: b.terms,
    address: b.address,
  };
  return createHash("sha256").update(stable(core)).digest("hex").slice(0, 12);
}

export async function load(p) {
  const b = JSON.parse(await fs.readFile(p, "utf8"));
  b.pending ||= { terms: {}, cast: [], address: [] };
  return b;
}

export async function save(b, p) {
  b.schema = SCHEMA;
  b.version = version(b);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify(b, null, 1), "utf8");
  return b.version;
}

export function charByAlias(b, name) {
  for (const c of b.cast) {
    if (name === c.zh || (c.alias || []).includes(name)) return c;
  }
  return null;
}

/**
 * VLM/người soát trả tên tự do; khớp về đúng nhân vật trong bible.
 * Chấp nhận alias, tên Việt, tên Việt gọi tắt, và cả tên bị model thêm chữ ("yêu Ngưu Ma Vương").
 */
export function bibleHit(b, name) {
  if (!name || ["ngoai_khung", "khong_chac", "?parse"].includes(name)) return null;
  const direct = charByAlias(b, name);
  if (direct) return direct;
  const low = String(name).trim().toLowerCase();
  for (const c of b.cast) {
    const cand = [c.vi, c.viShort, ...(c.alias || [])];
    if (cand.some((x) => x && x.trim().toLowerCase() === low)) return c;
  }
  for (const c of b.cast) {
    if (name.includes(c.zh) || (c.vi && low.includes(c.vi.toLowerCase()))) return c;
  }
  return null;
}

/** Trả {new, same, conflict}. Xung đột = đã chốt khác đi -> từ chối, ghi log. */
export function proposeTerms(b, mapping, source) {
  const out = { new: {}, same: {}, conflict: {} };
  for (const [zh, vi] of Object.entries(mapping)) {
    const cur = b.terms[zh];
    if (cur === undefined) {
      if (!(zh in b.pending.terms)) {
        b.pending.terms[zh] = { vi, source };
        out.new[zh] = vi;
      } else {
        out.same[zh] = vi;
      }
    } else if (cur.vi.toLowerCase() !== String(vi).toLowerCase()) {
      out.conflict[zh] = [cur.vi, vi];
    } else {
      out.same[zh] = vi;
    }
  }
  return out;
}

/** Đúng những thứ pass B2 thật sự gửi cho model — dùng làm chữ ký checkpoint. */
export const castSig = (b) => b.cast.map((c) => [c.id, c.zh, c.vi || "", c.note || "", ...(c.alias || [])]);

/**
 * Bible LỚN THÊM theo từng tập — đường về của cổng soát.
 *
 * Mọi mục vào đây đều do người chốt ở cổng của một tập cụ thể, nên `approved` ngay; máy
 * không tự trộn gì cả (đề xuất của máy vẫn nằm ở `out/<tập>/proposals.json`).
 *
 * Hai thứ CỐ Ý không làm ở đây:
 * - **Đè lên quyết định cũ.** Thuật ngữ đã chốt khác đi thì từ chối, không thay lặng lẽ ở
 *   tập thứ 7; muốn sửa thì sửa ở bible-review.
 * - **Gộp hai nhân vật ĐÃ duyệt.** Gộp trong nháp thì rẻ, gộp sau khi duyệt là migration:
 *   phải trỏ lại address, alias và mọi ep<N>.speakers.json đang giữ id chết.
 */
export function extend(b, { cast = [], terms = {} } = {}, { by = "fleex", ep = null } = {}) {
  const src = ep ? `cổng soát tập ${ep}` : "cổng soát";
  const added = { cast: [], terms: [] };
  const skipped = [];
  let maxId = Math.max(0, ...b.cast.map((c) => Number(String(c.id).replace(/\D+/g, "")) || 0));

  for (const c of cast) {
    const vi = String(c.vi || "").trim();
    if (!vi) continue; // hàng trống: trang luôn xuất mọi ô, kể cả ô chưa gõ gì
    // Người duyệt không gõ được chữ Hán -> bỏ trống thì khoá lấy tên Việt. Nó không bao giờ
    // khớp chữ trong thoại, tức kênh "gọi tên" của B3 im lặng: không đúng thêm được gì,
    // nhưng cũng KHÔNG gán bừa. Cùng luật với `applyReview` của series.
    const zh = String(c.zh || "").trim() || vi;
    const hit = charByAlias(b, zh)
      || b.cast.find((x) => [x.vi, x.viShort].some((n) => n && n.trim().toLowerCase() === vi.toLowerCase()));
    if (hit) {
      skipped.push(`nhân vật «${vi}» (${zh}) — đã có ${hit.id} ${hit.zh}`);
      continue;
    }
    maxId += 1;
    const row = {
      id: `C${maxId}`, zh, vi,
      viShort: String(c.viShort || "").trim(),
      gender: ["male", "female"].includes(c.gender) ? c.gender : "?",
      role: ["main", "episodic", "mentioned"].includes(c.role) ? c.role : "episodic",
      alias: [], note: String(c.note || "").trim(), look: String(c.look || "").trim(),
      source: src, approved: true, reviewedBy: by,
    };
    b.cast.push(row);
    added.cast.push(row);
  }

  for (const [zh, raw] of Object.entries(terms)) {
    const vi = String(raw || "").trim();
    if (!vi) continue;
    const cur = b.terms[zh];
    if (cur && String(cur.vi).trim().toLowerCase() !== vi.toLowerCase()) {
      skipped.push(`thuật ngữ ${zh} — đã chốt «${cur.vi}», bỏ qua đề xuất «${vi}»`);
      continue;
    }
    if (cur) continue;
    b.terms[zh] = { vi, approved: true, source: src, reviewedBy: by };
    added.terms.push(`${zh} = ${vi}`);
  }
  return { added, skipped };
}
