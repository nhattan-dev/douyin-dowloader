/**
 * Pass E — xuất. Thuần code, không gọi model, nên không công đoạn nào ở đây checkpoint.
 *   E1 srt          phụ đề
 *   E2 translation  đúng schema douyind-downloader (dub-video.mjs đọc thẳng file này)
 *   E3 voices       khớp tên nhân vật với thư mục voice/ có sẵn
 */
import fs from "node:fs/promises";
import path from "node:path";

/** Tên nhân vật LLM đặt phải khớp thư mục voice/<tên> có sẵn, nếu không dub-video.mjs chết. */
export async function matchVoices(names, voiceDir) {
  let have;
  try {
    const ents = await fs.readdir(voiceDir, { withFileTypes: true });
    have = ents.filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return { alias: {}, missing: [] };
  }
  const alias = {};
  const missing = [];
  const commonPrefix = (a, b) => {
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i++;
    return i;
  };
  for (const n of new Set(names)) {
    const hit = have.filter((v) => v === n).length
      ? have.filter((v) => v === n)
      : have.filter((v) => n.includes(v) || v.includes(n)).length
        ? have.filter((v) => n.includes(v) || v.includes(n))
        : have.filter((v) => commonPrefix(v, n) >= 2);
    if (hit.length) alias[n] = hit.length > 1 ? [...hit].sort((a, b) => a.length - b.length)[0] : hit[0];
    else missing.push(n);
  }
  return { alias, missing };
}

/** translation.json đúng schema douyind-downloader. */
export function exportTranslation(utts, vi, sheet, meta, {
  criticScores = null, alias = null, suspects = null,
} = {}) {
  alias ||= {};
  const names = Object.fromEntries(
    (sheet.characters || []).map((c) => [c.key, alias[c.zh || c.key] ?? (c.zh || c.key)]),
  );
  criticScores ||= {};

  const primary = new Map();
  for (const u of utts) {
    const p = u.segmentIndexes?.length ? u.segmentIndexes[0] : u.id;
    if (!primary.has(p)) primary.set(p, []);
    primary.get(p).push(u);
  }
  const idxOf = new Map();
  for (const [p, group] of primary) {
    group.forEach((u, k) => idxOf.set(u.id, group.length > 1 ? `${p}.${k}` : String(p)));
  }

  const warn = [];
  const segs = [];
  for (const u of utts) {
    if (!u.aligned) warn.push(`câu ${idxOf.get(u.id)} không căn được về timestamp gốc`);
    const conf = Number(u.conf ?? 1) || 1;
    const score = criticScores[u.id]?.score ?? 5;
    const suspect = suspects?.[String(u.id)] || null;
    segs.push({
      index: idxOf.get(u.id),
      start: u.start, end: u.end,
      zh: u.zh, vi: vi[u.id] || "",
      speaker: names[u.speaker] ?? alias[u.speaker] ?? u.speaker,
      vote: Math.round(conf * 100) / 100,
      speakerSuspect: suspect,
      needsReview: Boolean(u.review?.length) || conf < 0.9 || score <= 3 || !u.aligned || Boolean(suspect),
      segmentIndexes: u.segmentIndexes,
      speakerSource: u.speakerSource,
    });
  }
  segs.sort((a, b) => (a.start === null) - (b.start === null) || a.start - b.start);

  return {
    ...meta,
    alignmentWarnings: warn,
    unit: "repaired-utterance",
    mergeMaxGapSec: null,
    speakers: [...new Set(segs.map((s) => s.speaker).filter(Boolean))],
    segments: segs,
  };
}

const srtTime = (t) => {
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${s.toFixed(3).padStart(6, "0")}`.replace(".", ",");
};

export function toSrt(utts, vi) {
  return utts
    .filter((u) => u.start !== null && u.start !== undefined)
    .map((u, n) => `${n + 1}\n${srtTime(u.start)} --> ${srtTime(u.end)}\n${vi[u.id] || ""}\n`)
    .join("\n");
}

/**
 * E3 — ghi ngược vào thư mục video của douyind. Mọi file cũ giữ ở *.orig.
 *
 * Gán người nói ngược vào transcript.json CHỈ cho segment mà cả đoạn một người nói
 * (cùng luật với temp/writeback.mjs): segment lẫn hai giọng thì mẫu voice bị bẩn.
 */
export async function writeBack(dataDir, outDir, tr, { log = null } = {}) {
  for (const f of ["translation.json", "translation.txt"]) {
    const dst = path.join(dataDir, f);
    try {
      await fs.access(dst);
      try {
        await fs.access(dst + ".orig");
      } catch {
        await fs.copyFile(dst, dst + ".orig");
      }
    } catch { /* chưa có bản cũ thì thôi */ }
    await fs.copyFile(path.join(outDir, f), dst);
  }

  const tp = path.join(dataDir, "transcript.json");
  try {
    await fs.access(tp);
  } catch {
    log?.info?.(`đã ghi vào ${dataDir} (bản cũ giữ ở *.orig)`);
    return null;
  }
  try {
    await fs.access(tp + ".orig");
  } catch {
    await fs.copyFile(tp, tp + ".orig");
  }

  const tj = JSON.parse(await fs.readFile(tp, "utf8"));
  const owners = new Map();
  for (const s of tr.segments) {
    for (const i of s.segmentIndexes || []) {
      if (!owners.has(i)) owners.set(i, new Set());
      owners.get(i).add(s.speaker);
    }
  }
  let clean = 0;
  (tj.segments || []).forEach((seg, i) => {
    const set = owners.get(i);
    const one = set && set.size === 1 ? [...set][0] : null;
    seg.speaker = one;
    seg.speakerSource = one ? "zhvi" : null;
    if (one) clean += 1;
  });
  tj.speakers = [...new Set(tj.segments.filter((s) => s.speaker).map((s) => s.speaker))];
  await fs.writeFile(tp, JSON.stringify(tj, null, 2), "utf8");
  log?.info?.(`transcript.json: ${clean}/${tj.segments.length} segment gán được người nói`);
  log?.info?.(`đã ghi vào ${dataDir} (bản cũ giữ ở *.orig)`);
  return clean;
}
