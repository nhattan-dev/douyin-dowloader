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
