/**
 * Câu dịch sửa tay — DÍNH, cùng luật với nhãn người soát: chạy lại zhvi không được đè mất.
 *
 * Lưu ở series/<slug>/ep<N>.vi-edits.json, khoá theo số câu KÈM câu gốc tiếng Trung. Pass A chạy
 * lại có thể tách/gộp câu làm số câu trôi; câu gốc không khớp thì KHÔNG áp mà báo "lệch" cho người
 * sửa lại — còn hơn áp nhầm sang câu khác (đúng cái bẫy id trôi đã gặp ở kênh hình).
 *
 * Áp vào hai bản translation.json: out/<series>/epNN (UI đọc) và thư mục video (dub-video đọc).
 * Recipe `translate` gọi applyEdits sau mỗi lượt zhvi.
 */
import fs from "node:fs/promises";
import path from "node:path";

import { epDir } from "../zhvi/series.js";
import { editsPath, episodeCore, readJson } from "./scan.js";

async function writeJson(file, obj) {
  await fs.writeFile(file + ".tmp", JSON.stringify(obj, null, 1), "utf8");
  await fs.rename(file + ".tmp", file);
}

const idxOf = (s, i) => String(s.index ?? s.id ?? i);

async function targets(slug, ep) {
  const hit = await episodeCore(slug, ep);
  if (!hit) throw Object.assign(new Error("không có tập này"), { code: 404 });
  const { core, e } = hit;
  return {
    core, e,
    editsFile: editsPath(core.dir, e.ep),
    outFile: path.join(core.outRoot, epDir(e.ep), "translation.json"),
    dataFile: path.join(e.videoDir, "translation.json"),
  };
}

export async function applyEdits(slug, ep) {
  const t = await targets(slug, ep);
  const edits = (await readJson(t.editsFile)) || {};
  let stale = [];
  let editsChanged = false;
  for (const file of [t.outFile, t.dataFile]) {
    const tr = await readJson(file);
    if (!tr?.segments) continue;
    const byIdx = new Map(tr.segments.map((s, i) => [idxOf(s, i), s]));
    const miss = [];
    let changed = false;
    for (const [idx, ed] of Object.entries(edits)) {
      const seg = byIdx.get(idx);
      if (!seg || seg.zh !== ed.zh) {
        miss.push(idx);
        continue;
      }
      // zhvi vừa dịch lại câu này: giữ bản máy mới làm mốc "về bản máy"
      if (file === t.outFile && !seg.editedByHand && seg.vi !== ed.vi && seg.vi !== ed.machine) {
        ed.machine = seg.vi;
        editsChanged = true;
      }
      if (seg.vi !== ed.vi || !seg.editedByHand) {
        seg.vi = ed.vi;
        seg.editedByHand = true;
        changed = true;
      }
    }
    if (changed) {
      await writeJson(file, tr);
      if (file === t.dataFile) {
        await fs.writeFile(path.join(t.e.videoDir, "translation.txt"), tr.segments.map((s) => s.vi).filter(Boolean).join(" "), "utf8");
      }
    }
    if (file === t.outFile) stale = miss;
  }
  if (editsChanged) await writeJson(t.editsFile, edits);
  return { applied: Object.keys(edits).length - stale.length, stale };
}

/** vi = null: về bản máy. drop: bỏ hẳn bản sửa (kể cả bản đã lệch, không còn câu tương ứng). */
export async function saveEdit(slug, ep, index, vi, { drop = false } = {}) {
  const t = await targets(slug, ep);
  const edits = (await readJson(t.editsFile)) || {};
  if (drop) {
    delete edits[index];
    await writeJson(t.editsFile, edits);
    return { index, dropped: true };
  }
  const tr = await readJson(t.outFile);
  const seg = tr?.segments?.find((s, i) => idxOf(s, i) === index);
  if (!seg) throw Object.assign(new Error(`không có câu ${index} trong bản dịch`), { code: 404 });
  const prev = edits[index];
  const machine = prev && prev.zh === seg.zh ? prev.machine : seg.vi;
  const text = vi === null || vi === undefined ? null : String(vi).replace(/\s+/g, " ").trim();

  if (text === null || text === machine) {
    delete edits[index];
    await writeJson(t.editsFile, edits);
    // trả bản máy về cả hai file — applyEdits không đụng câu không còn bản sửa
    for (const file of [t.outFile, t.dataFile]) {
      const x = await readJson(file);
      const s = x?.segments?.find((y, i) => idxOf(y, i) === index && y.zh === seg.zh);
      if (!s) continue;
      s.vi = machine;
      delete s.editedByHand;
      await writeJson(file, x);
    }
    return { index, vi: machine, edited: false };
  }
  edits[index] = { zh: seg.zh, vi: text, machine, at: new Date().toISOString() };
  await writeJson(t.editsFile, edits);
  await applyEdits(slug, ep);
  return { index, vi: text, edited: true };
}
