import fs from "node:fs/promises";
import path from "node:path";

import { mergeSpeakerTurns } from "./align.js";
import { randomDelay } from "./browser.js";
import { config, paths } from "./config.js";
import { leftoverTokens, loadGlossary, matchedTerms, protect, restore } from "./glossary.js";
import { createLogger } from "./logger.js";
import { markVideo, saveState, STATUS, videosByStatus } from "./state.js";
import { resolveProvider } from "./translators/index.js";

const log = createLogger("TRANSLATE");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ── Giao thức đánh số ──────────────────────────────────────────────────────
//
// Bài toán: dịch rời từng segment thì mất ngữ cảnh và lạc quẻ, nhưng dịch cả cụm
// thì không biết đường chia lại theo mốc thời gian.
//
// Cách giải: đánh số từng dòng rồi gửi CẢ CỤM trong một request. Bản dịch vẫn có
// đủ ngữ cảnh của cả đoạn, mà số thứ tự cho phép chia lại chính xác. Đã kiểm chứng
// Google giữ nguyên đánh số với 39 dòng.

const buildPayload = (lines) => lines.map((line, i) => `${i + 1}. ${line}`).join("\n");

// Bảng thuật ngữ gửi kèm prompt. Có placeholder thì khoá theo chỉ số ⟦n⟧ (model
// không thấy chữ Hán gốc nữa); không có thì khoá thẳng theo mặt chữ Hán.
const formatDict = (pairs, withPlaceholders) =>
  pairs
    .map(([zh, vi], i) => (withPlaceholders ? `⟦${i}⟧ = ${zh} (${vi})` : `${zh} = ${vi}`))
    .join("; ");

// Chấp nhận nhiều kiểu dấu sau số: model/dịch máy hay đổi "1." thành "1、" hoặc "1)".
const NUMBERED_LINE = /^\s*(\d+)\s*[.、:：)）]\s*(.*)$/;
// Chỉ bóc phần đánh số ở đầu, dùng cho đáy đệ quy khi không tách được theo dòng.
const NUMBER_PREFIX = /^\s*\d+\s*[.、:：)）]\s*/;

/**
 * Tách bản dịch đã đánh số về lại từng dòng.
 *
 * Trả `null` nếu không khôi phục đủ — bên gọi sẽ chia nhỏ rồi thử lại, thà chậm
 * còn hơn ghi ra bản dịch lệch segment mà không ai biết.
 */
function parsePayload(text, expectedCount) {
  const found = new Map();
  let current = null;

  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;

    const m = line.match(NUMBERED_LINE);
    if (m) {
      current = Number.parseInt(m[1], 10);
      found.set(current, m[2].trim());
    } else if (current !== null) {
      // Dòng không có số = phần tràn của dòng trước bị xuống hàng, nối lại.
      found.set(current, `${found.get(current)} ${line}`.trim());
    }
  }

  const out = [];
  for (let i = 1; i <= expectedCount; i += 1) {
    const value = found.get(i);
    if (value === undefined || value === "") return null;
    out.push(value);
  }
  return out;
}

/** Chia danh sách dòng thành các cụm mà payload không vượt maxChars. */
function chunkLines(lines, maxChars) {
  const chunks = [];
  let current = [];
  let size = 0;

  for (const line of lines) {
    const cost = line.length + 6; // + số thứ tự, dấu chấm, xuống dòng
    if (current.length > 0 && size + cost > maxChars) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push(line);
    size += cost;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

// Số dòng lân cận gửi kèm làm bối cảnh khi phải chia nhỏ. Cụm càng nhỏ càng thiếu
// ngữ cảnh, và LLM mất mạch truyện thì quay ra PHIÊN ÂM Hán-Việt thay vì dịch: đo
// được 此物若是运作得当 → "Tử vật nhược thị vận tác đắc đương". Vài dòng trước/sau
// (không dịch) là đủ để nó biết đang đứng ở đoạn nào.
const CONTEXT_LINES = 6;

// Chữ Hán lọt vào bản tiếng Việt — dùng cả ở phần cảnh báo lẫn khi so provider.
// Hai bản là bắt buộc: regex có /g nhớ `lastIndex` giữa các lần gọi, nên dùng chung
// một đối tượng cho cả `.test()` lẫn `.match()` sẽ bỏ sót dòng (["ab玉","金x"] →
// dòng 2 trả về false vì bắt đầu dò từ vị trí 3).
const HAS_HAN = /[\p{Script=Han}]/u;
const HAN_CHARS = /[\p{Script=Han}]/gu;

/**
 * Dịch một cụm dòng, đảm bảo trả về ĐÚNG số dòng đã gửi.
 *
 * `job` mang theo cả speaker lẫn dòng lân cận CỦA CHÍNH cụm này. Trước đây hàm chỉ
 * nhận `lines`, còn speaker hint dựng sẵn ở ngoài theo cụm cha — chia đôi xong thì
 * cụm con đánh số lại từ 1 mà hint vẫn mô tả số dòng của cụm cha, gán người nói lệch.
 *
 * Hỏng thì chia đôi rồi thử lại (cụm nhỏ ít bị dịch máy gộp dòng hơn); xuống tới
 * một dòng mà vẫn hỏng thì lấy nguyên output. Mỗi lần phải hạ cấp đều ghi cảnh báo
 * vào output — bản dịch vẫn dùng được nhưng biết chỗ nào kém tin cậy.
 */
async function translateChunk(job, provider, opts, warnings, depth = 0) {
  const { lines, speakers, before, after } = job;
  const { entries, protectTerms } = opts;

  // Câu mồi đi CÙNG payload thật, không phải một request riêng: provider nào có
  // nhiều mức chất lượng (google-web) thì suất model tốt rất ít, hỏi thăm dò riêng
  // là tự đốt mất suất đó. Bỏ khi chỉ còn 1 dòng: lúc đó câu mồi dài hơn cả nội dung.
  const canary = lines.length > 1 ? provider.qualityCanary : null;
  const sent = canary ? [canary.text, ...lines] : lines;

  log.debug(`dịch cụm ${lines.length} dòng (depth=${depth}, canary=${!!canary})`);
  const t0 = Date.now();

  const payload = buildPayload(sent);
  // Hai cơ chế đưa glossary tới model, cùng một tập thuật ngữ (xem scan() trong
  // glossary.js) — khác nhau đúng ở chỗ text có bị đụng vào hay không.
  const { text: guarded, used, pairs } = protectTerms
    ? protect(payload, entries)
    : { text: payload, used: [], pairs: matchedTerms(payload, entries) };
  const raw = await provider.translateText(guarded, {
    ...opts,
    expectLines: sent.length,
    // Câu mồi chiếm dòng 1 nên mọi dòng thật lùi xuống một bậc — hint phải đánh số
    // theo payload thật, không theo chỉ số trong `lines`.
    speakerHint: buildSpeakerHint(speakers, canary ? 1 : 0),
    surrounding: before.length || after.length ? { before, after } : null,
    // Bảng thuật ngữ của RIÊNG cụm này (không phải nguyên bảng 263 mục — xem
    // buildSystemPrompt trong translators/openai.js):
    //   có placeholder: "⟦0⟧ = 金丹 (Kim Đan); ..." — không có nó thì model phải đoán
    //     mù ⟦n⟧ là chữ gì, dễ sai khi placeholder đứng cạnh chữ rời do lỗi ASR.
    //   không placeholder: "金丹 = Kim Đan; ..." — chữ Hán còn nguyên trong payload,
    //     bảng chỉ chốt mặt chữ tiếng Việt phải dùng.
    glossaryDict: pairs.length ? formatDict(pairs, protectTerms) : null,
    // Prompt cần biết trong text CÓ ⟦n⟧ hay không, chứ không phải "có glossary hay
    // không" — hai thứ này từng là một biến, và đó chính là chỗ hỏng.
    hasPlaceholders: protectTerms && pairs.length > 0,
  });
  // `used` rỗng (chế độ không bọc) thì restore() chỉ còn dọn khoảng trắng — giữ
  // nguyên đường đi cho cả hai chế độ, đừng rẽ nhánh thêm ở đây.
  const all = parsePayload(restore(raw, used), sent.length);

  let parsed = all;
  if (all && canary) {
    const [probe, ...rest] = all;
    if (probe.toLowerCase().includes(canary.bad.toLowerCase())) opts.onDegraded?.();
    parsed = rest;
  }

  if (parsed) {
    log.debug(`cụm ${lines.length} dòng xong (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
    return parsed;
  }

  if (lines.length === 1) {
    // Đáy đệ quy. Vẫn gửi kèm đánh số như mọi cụm khác: bỏ số đi thì model không
    // còn coi đây là cùng một việc và hay quay ra phiên âm. Output không tách được
    // thì đành lấy trần, chỉ bóc số nếu model có ghi.
    warnings.push(`dòng "${lines[0].slice(0, 16)}…" không tách được theo số — lấy nguyên output`);
    return [restore(raw, used).trim().replace(NUMBER_PREFIX, "")];
  }

  warnings.push(`cụm ${lines.length} dòng không tách được theo số — đã chia nhỏ thử lại`);
  log.warn(`không tách được ${lines.length} dòng theo số thứ tự, chia đôi (mức ${depth + 1})`);

  const mid = Math.ceil(lines.length / 2);
  const left = await translateChunk(
    {
      lines: lines.slice(0, mid),
      speakers: speakers.slice(0, mid),
      before,
      after: [...lines.slice(mid), ...after].slice(0, CONTEXT_LINES),
    },
    provider,
    opts,
    warnings,
    depth + 1,
  );
  await randomDelay();
  const right = await translateChunk(
    {
      lines: lines.slice(mid),
      speakers: speakers.slice(mid),
      before: [...before, ...lines.slice(0, mid)].slice(-CONTEXT_LINES),
      after,
    },
    provider,
    opts,
    warnings,
    depth + 1,
  );
  return [...left, ...right];
}

/** Dịch toàn bộ segment của một video. */
export async function translateSegments(
  texts,
  provider,
  {
    from,
    to,
    context,
    speakers = [],
    glossary = config.glossaryEnabled,
    protectTerms = config.glossaryProtect,
  },
) {
  // HAI công tắc độc lập, vì có ba thứ khác nhau cần đo tách bạch:
  //
  //   glossary=true,  protectTerms=true   — bọc ⟦n⟧, prompt dạy luật placeholder.
  //   glossary=true,  protectTerms=false  — text nguyên vẹn, thuật ngữ vào prompt
  //                                         dưới dạng bảng "Hán tự = bản dịch".
  //   glossary=false                      — model không biết gì về glossary.
  //
  // Tắt glossary = danh sách rỗng, không rẽ nhánh: protect()/matchedTerms() không
  // tìm thấy gì (used/pairs rỗng) và restore() không có gì để khôi phục, nên cả cơ
  // chế tự vô hiệu mà mọi chỗ gọi phía sau giữ nguyên.
  //
  // Cần tắt riêng protect() vì nó là nghi phạm khi bản dịch hỏng: dòng ngắn mà
  // placeholder chiếm gần hết thì model có vẻ bỏ dịch phần còn lại (đo trên case
  // 乾坤袋: có placeholder ~40% sót chữ Hán, không có 0/5). Nhưng bản đo đó dùng
  // `--no-glossary` cũ nên đổi 2 biến một lúc (mất luôn bản dịch ghim), và trên
  // 三打白骨精 thì cả hai bản đều 0 chữ Hán sót, 8/9 thuật ngữ vẫn ra đúng mặt chữ
  // khi TẮT. Nên đây là công tắc để đo tiếp, không phải kết luận.
  const entries = glossary ? await loadGlossary() : [];
  const warnings = [];
  let degraded = false;
  const opts = {
    from,
    to,
    context,
    entries,
    protectTerms: protectTerms && glossary,
    onDegraded: () => (degraded = true),
  };

  // Segment rỗng KHÔNG BAO GIỜ tách lại được: parsePayload đòi mọi dòng phải có nội
  // dung, nên một segment rỗng của whisper (đã gặp thật: start == end == 66.04) làm
  // hỏng cả cụm và kéo theo chuỗi chia đôi xuống tận 1 dòng — 13 lời gọi API cho một
  // payload 630 ký tự, các cụm ở đáy dịch ra phiên âm Hán-Việt, và dòng rỗng nhận về
  // câu từ chối của model ("Xin vui lòng cung cấp văn bản..."). Bỏ hẳn ra khỏi
  // payload, ghép lại chuỗi rỗng ở cuối.
  const kept = texts.map((t, i) => [t.trim(), i]).filter(([t]) => t !== "");
  const skipped = texts.length - kept.length;
  if (skipped > 0) {
    warnings.push(`${skipped} segment rỗng — không gửi đi dịch, bản dịch để trống`);
    log.debug(`bỏ ${skipped} segment rỗng ra khỏi payload`);
  }

  const lines = kept.map(([t]) => t);
  const lineSpeakers = kept.map(([, i]) => speakers[i] ?? null);

  // Trần theo provider, không phải một số dùng chung: provider Google bị chặn bởi ô
  // nhập/URL của Google, provider LLM thì không — ép chúng theo cùng một trần là bắt
  // DeepSeek chịu giới hạn của translate.google.com.
  const maxChars = provider.maxChars ?? config.translateMaxChars;
  const chunks = chunkLines(lines, maxChars);
  log.debug(`${lines.length} segment → ${chunks.length} cụm (trần ${maxChars} ký tự)`);

  const done = [];
  let offset = 0;
  for (const [i, chunk] of chunks.entries()) {
    if (i > 0) await randomDelay();
    done.push(
      ...(await translateChunk(
        {
          lines: chunk,
          speakers: lineSpeakers.slice(offset, offset + chunk.length),
          before: lines.slice(Math.max(0, offset - CONTEXT_LINES), offset),
          after: lines.slice(offset + chunk.length, offset + chunk.length + CONTEXT_LINES),
        },
        provider,
        opts,
        warnings,
      )),
    );
    offset += chunk.length;
  }

  // Trả về đúng độ dài `texts` để bên gọi ghép thẳng theo chỉ số segment.
  const out = new Array(texts.length).fill("");
  kept.forEach(([, original], i) => {
    out[original] = done[i];
  });

  // Chữ Hán còn sót trong bản tiếng Việt = model gặp từ nó không nhận ra và bỏ
  // nguyên. Đo được trên bản `openai`: 2/36 đơn vị dính, cả hai đều là 玉寒袍 — chính
  // là chỗ STT nghe sai 御寒袍, model không tra ra từ nên để yên. TTS tiếng Việt đọc
  // chữ Hán thì ra rác, nên phải báo chứ không ghi lặng lẽ. Đây cũng là thước đo
  // khách quan khi so provider bằng `translate-compare`.
  const han = out.filter((line) => HAS_HAN.test(line));
  if (han.length > 0) {
    warnings.push(`${han.length} dòng còn chữ Hán chưa dịch (${[...new Set(han.join("").match(HAN_CHARS) ?? [])].join("")})`);
  }

  const leftover = out.flatMap((line) => leftoverTokens(line));
  if (leftover.length > 0) {
    warnings.push(`còn ${leftover.length} placeholder chưa khôi phục — glossary có thể sai`);
  }
  if (degraded) warnings.push("Google trả model NMT đời cũ — bản dịch kém, nên chạy lại sau");

  return { translations: out, warnings, degraded };
}

// ── Orchestration ──────────────────────────────────────────────────────────

async function readTranscript(userId, videoId) {
  const file = path.join(paths.videoDir(userId, videoId), "transcript.json");
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") {
      throw new Error("chưa có transcript.json (chạy `npm run stt` với STT_TIMESTAMPS bật)");
    }
    throw err;
  }
}

/**
 * Video này đã dịch chưa, và bản dịch có còn khớp transcript không? Hỏi đĩa, không
 * hỏi state.
 *
 * Đối chiếu nội dung chứ không chỉ xem file có tồn tại: `stt --force` đặt status về
 * TRANSCRIBED nên `translate` nhặt lại video đó, rồi thấy translation.json nằm sẵn
 * là bỏ qua — transcript mới đi cùng bản dịch cũ, `zh`/`start`/`end` lệch hẳn mà
 * không có cảnh báo nào. Speaker cũng tính: biết ai nói thì xưng hô dịch ra khác.
 *
 * @returns {{done: boolean, stale: string|null}}
 */
async function translationStatus(userId, videoId) {
  const dir = paths.videoDir(userId, videoId);
  let saved;
  try {
    const raw = await fs.readFile(path.join(dir, "translation.json"), "utf8");
    if (!raw.trim()) return { done: false, stale: null };
    saved = JSON.parse(raw);
  } catch {
    return { done: false, stale: null };
  }

  let segments;
  try {
    segments = JSON.parse(await fs.readFile(path.join(dir, "transcript.json"), "utf8")).segments ?? [];
  } catch {
    // Không đối chiếu được thì tin bản đã có — thà bỏ qua còn hơn dịch lại mất tiền.
    return { done: true, stale: null };
  }

  // Đối chiếu theo ĐƠN VỊ DỊCH chứ không theo segment thô — đổi
  // TRANSLATE_MERGE_MAX_GAP_SEC cũng là một lý do chính đáng để dịch lại.
  const units = translationUnits(segments);
  const old = saved.segments ?? [];
  if (old.length !== units.length) {
    return { done: true, stale: `transcript gộp ra ${units.length} đơn vị, bản dịch có ${old.length}` };
  }
  const drift = units.findIndex(
    (u, i) => old[i].zh !== u.text.trim() || (old[i].speaker ?? null) !== (u.speaker ?? null),
  );
  return { done: true, stale: drift >= 0 ? `đơn vị ${drift} đã đổi sau khi transcribe lại` : null };
}

/**
 * Mô tả người nói theo khoảng dòng, để nhét vào system prompt.
 *
 * Nhận danh sách speaker CỦA RIÊNG CỤM đang dịch, không phải của cả video: payload
 * dài quá `TRANSLATE_MAX_CHARS` sẽ bị chia cụm và mỗi cụm đánh số lại từ 1, nên
 * hint dựng theo số dòng toàn cục sẽ trỏ nhầm dòng.
 *
 * Nhét nhãn vào từng dòng payload thì phải bóc ra khỏi output — thêm một chỗ hỏng
 * cho giao thức đánh số vốn đã phải có nhánh chia đôi khi tách lỗi.
 *
 * `offset` để dịch số dòng khi payload có thêm dòng chèn ở đầu (câu mồi phát hiện
 * Google tụt model). Không có nó thì mọi nhãn lệch đúng một dòng.
 *
 * Nhãn do LLM suy ra được ghi rõ là suy đoán thay vì trộn lẫn với nhãn nhận dạng
 * giọng. Diarize bỏ trống ~23% segment và phần đó do mạch hội thoại suy ra — trình
 * bày nó y như nhãn chắc chắn là mời model bám vào một quan hệ nhân vật có thể sai.
 */
function buildSpeakerHint(speakers, offset = 0) {
  if (!speakers?.some((s) => s?.speaker)) return null;

  const label = ({ speaker, source } = {}) => {
    if (!speaker) return "không xác định";
    if (source === "inferred") return `không xác định — khả năng là ${speaker}`;
    return speaker;
  };

  const ranges = [];
  for (const [i, raw] of speakers.entries()) {
    const who = label(raw);
    const line = i + 1 + offset;
    const last = ranges.at(-1);
    if (last && last.who === who) last.to = line;
    else ranges.push({ who, from: line, to: line });
  }

  return ranges
    .map((r) => (r.from === r.to ? `Dòng ${r.from}: ${r.who}` : `Dòng ${r.from}-${r.to}: ${r.who}`))
    .join(". ");
}

/**
 * Đơn vị đem đi dịch: gộp các segment liền mạch cùng người nói.
 *
 * whisper cắt theo chunk của nó chứ không theo câu, nên hay chặt đôi giữa từ:
 * `最近极北之地不太平,据说有上动物出事,作` + `日有四个金丹往北去了,…` — 昨日 bị xẻ
 * làm hai, ra bản dịch "…gặp chuyện, làm" / "Ngày hôm đó…". Thêm bao nhiêu ngữ cảnh
 * cũng không cứu được: nửa chữ nằm ở dòng khác thì dòng này buộc phải dịch sai.
 *
 * Ngưỡng mặc định rất chặt (0.2s) và đó là chủ ý: chỉ gộp đúng những chỗ whisper tự
 * cắt (đo trên video mẫu: khoảng cách đúng 0.00s), KHÔNG nuốt khoảng lặng thật. Nhờ
 * vậy mốc thời gian của đơn vị gộp vẫn liền một mạch — TTS không phải kéo giọng lấp
 * vào chỗ im lặng, tiếng dub không lệch. Nới ngưỡng lên là đánh đổi đúng chỗ đó.
 *
 * Khác `turns` trong transcript.json: `turns` gộp rộng (1.5s) để người đọc soát cho
 * dễ, còn đây là dữ liệu thật đem đi dịch và đưa sang LangDub.
 */
function translationUnits(segments) {
  return mergeSpeakerTurns(segments, { maxGapSec: config.translateMergeMaxGapSec });
}

const warnedProviders = new Set();
function warnOnceNoSpeakers(providerName) {
  if (warnedProviders.has(providerName)) return;
  warnedProviders.add(providerName);
  log.warn(
    `provider "${providerName}" không nhận chỉ dẫn nên BỎ QUA nhãn người nói — ` +
      "xưng hô sẽ ra chung chung. Dùng openai / openai-2pass để tận dụng bước diarize.",
  );
}

export async function translateVideo(userId, videoId, provider, context, { glossary, protectTerms } = {}) {
  const transcript = await readTranscript(userId, videoId);
  const segments = transcript.segments ?? [];
  if (segments.length === 0) throw new Error("transcript.json không có segment nào");

  const units = translationUnits(segments);
  if (units.length < segments.length) {
    log.debug(`${segments.length} segment → ${units.length} đơn vị dịch`);
  }

  const texts = units.map((u) => u.text.trim());
  // Bản đồ người nói: biết ai nói mới chọn đúng xưng hô. Không có nó thì
  // 前辈可去… ra "Bạn có thể thử vận may…" thay vì "tiền bối có thể…".
  const speakers = units.map((u) => ({ speaker: u.speaker ?? null, source: u.speakerSource ?? null }));

  // Dịch máy không nhận chỉ dẫn nên nhãn người nói rơi hết — nói thẳng ra thay vì
  // để cả bước diarize (phần đắt nhất của STT) im lặng thành vô ích.
  if (speakers.some(Boolean) && !provider.supportsSpeakers) {
    warnOnceNoSpeakers(provider.name);
  }

  log.debug(`video ${videoId}: ${texts.length} đơn vị dịch, provider=${provider.name}`);
  const startedAt = Date.now();

  const opts = {
    from: config.translateFrom,
    to: config.translateTo,
    context,
    speakers,
    glossary,
    protectTerms,
  };

  // Suất model tốt của Google hồi lại theo thời gian, nên gặp bản kém thì chờ rồi
  // dịch lại — thà chậm còn hơn ghi ra 122 bản dịch rác rồi phải rà lại bằng tay.
  let result = await translateSegments(texts, provider, opts);
  for (let attempt = 1; result.degraded && attempt < config.translateCooldownTries; attempt += 1) {
    log.warn(
      `model đời cũ — chờ ${config.translateCooldownMs / 1000}s rồi dịch lại ` +
        `(lần ${attempt}/${config.translateCooldownTries - 1})`,
    );
    await sleep(config.translateCooldownMs);
    result = await translateSegments(texts, provider, opts);
  }
  const { translations, warnings, degraded } = result;
  if (degraded) log.warn("vẫn là model đời cũ sau khi chờ — ghi lại kèm cờ degradedModel");

  const dir = paths.videoDir(userId, videoId);
  const out = {
    videoId,
    provider: provider.name,
    from: config.translateFrom,
    to: config.translateTo,
    translatedAt: new Date().toISOString(),
    // Bản dịch vẫn dùng tạm được, nhưng đánh dấu để còn biết đường chạy lại --force
    // khi Google hết bóp.
    degradedModel: degraded,
    // Glossary bật/tắt đổi hẳn mặt chữ của thuật ngữ, nên phải ghi vào file: không
    // có nó thì hai bản A/B nằm cạnh nhau mà không phân biệt được bản nào là bản nào.
    // Ghi cả CƠ CHẾ chứ không chỉ bật/tắt — ba chế độ, hai bản "có glossary" vẫn
    // khác nhau ở chỗ text có bị bọc ⟦n⟧ hay không.
    glossary: opts.glossary ?? config.glossaryEnabled,
    glossaryProtect: (opts.glossary ?? config.glossaryEnabled) && (opts.protectTerms ?? config.glossaryProtect),
    alignmentWarnings: warnings,
    // Không phải segment thô của whisper: các segment liền mạch cùng người nói đã
    // được gộp lại (xem translationUnits). Mốc thời gian vẫn là mốc thật của whisper.
    unit: "merged-segment",
    mergeMaxGapSec: config.translateMergeMaxGapSec,
    sourceSegments: segments.length,
    speakers: [...new Set(units.map((u) => u.speaker).filter(Boolean))],
    segments: units.map((u, i) => ({
      index: i,
      start: u.start,
      end: u.end,
      // Người nói đi kèm để LangDub gán giọng riêng cho từng nhân vật
      // (multi_voice / langdub_segment_voice_set). `speakerSource: "inferred"` là
      // nhãn do LLM suy từ mạch thoại, chưa ai soát — xem `npm run review-speakers`.
      speaker: u.speaker ?? null,
      speakerSource: u.speakerSource ?? null,
      // Chỉ số segment gốc trong transcript.json, để lần ngược về word-level timestamp.
      segmentIndexes: u.segmentIndexes,
      zh: u.text.trim(),
      vi: translations[i],
    })),
  };

  await fs.writeFile(path.join(dir, "translation.json"), JSON.stringify(out, null, 2), "utf8");
  await fs.writeFile(path.join(dir, "translation.txt"), translations.join(" "), "utf8");

  log.debug(`video ${videoId}: xong trong ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
  return out;
}

export async function translateAll(
  userId,
  state,
  {
    videoId = null,
    limit = null,
    force = false,
    context = null,
    providerName = null,
    glossary = config.glossaryEnabled,
    protectTerms = config.glossaryProtect,
  } = {},
) {
  const provider = await resolveProvider(providerName ?? config.translateProvider);

  let targets = videosByStatus(
    state,
    force ? [STATUS.TRANSCRIBED, STATUS.TRANSLATED] : STATUS.TRANSCRIBED,
  );

  if (videoId) {
    if (!targets.includes(videoId)) {
      const known = state.videos[videoId];
      throw new Error(
        !known
          ? `video ${videoId} không có trong state của user này`
          : known.status === STATUS.TRANSLATED
            ? `video ${videoId} đã dịch rồi — thêm --force nếu muốn dịch lại`
            : `video ${videoId} đang ở trạng thái "${known.status}", chưa có transcript để dịch`,
      );
    }
    targets = [videoId];
  } else {
    targets.sort((a, b) => (a < b ? 1 : -1));
    if (limit) targets = targets.slice(0, limit);
  }

  // Chốt chặn dựa vào đĩa: state có thể bị xoá/sửa, translation.json khớp transcript
  // mới là bằng chứng chắc chắn đã dịch rồi.
  if (!force) {
    const kept = [];
    let done = 0;
    let stale = 0;
    for (const id of targets) {
      const status = await translationStatus(userId, id);
      if (status.done && !status.stale) {
        markVideo(state, id, { status: STATUS.TRANSLATED });
        done += 1;
        continue;
      }
      if (status.stale) {
        stale += 1;
        log.warn(`${id}: bản dịch cũ không còn khớp transcript (${status.stale}) — dịch lại`);
      }
      kept.push(id);
    }
    if (done > 0) {
      await saveState(state);
      log.info(`bỏ qua ${done} video đã dịch (dùng --force để dịch lại)`);
    }
    if (stale > 0) log.info(`${stale} video có bản dịch cũ đã lỗi thời — sẽ dịch lại`);
    targets = kept;
  }

  if (targets.length === 0) {
    log.info("không có video nào cần dịch");
    return { ok: 0, failed: 0 };
  }

  log.info(
    `${targets.length} video cần dịch (provider=${provider.name}, ` +
      `${config.translateFrom}→${config.translateTo})`,
  );

  let ok = 0;
  let failed = 0;

  // Chạy tuần tự: provider dùng browser mà mở nhiều tab lên translate.google.com
  // cùng lúc là mời captcha. Provider HTTP thì randomDelay giữa các video là đủ.
  for (const [i, id] of targets.entries()) {
    const prefix = `[${i + 1}/${targets.length}] ${id}`;
    try {
      const result = await translateVideo(userId, id, provider, context, { glossary, protectTerms });
      markVideo(state, id, {
        status: STATUS.TRANSLATED,
        translateProvider: provider.name,
        degradedModel: result.degradedModel,
        translateError: null,
      });
      await saveState(state);
      ok += 1;
      const warn = result.alignmentWarnings.length
        ? ` — ${result.alignmentWarnings.length} cảnh báo căn segment`
        : "";
      const deg = result.degradedModel ? " ⚠ model đời cũ, nên dịch lại sau" : "";
      log.info(`${prefix}: OK, ${result.segments.length} segment${warn}${deg}`);
    } catch (err) {
      failed += 1;
      // Giữ nguyên status như bước STT: đổi sang failed là tự khoá đường retry.
      markVideo(state, id, { translateError: err.message });
      await saveState(state);
      log.error(`${prefix}: ${err.message}`);
    }
    await randomDelay();
  }

  log.info(`xong: ${ok} OK, ${failed} lỗi` + (failed ? " — chạy lại lệnh để thử lại" : ""));
  return { ok, failed };
}

/** Lệnh `translate-compare`: in bản dịch của nhiều provider cạnh nhau. */
export async function compareProviders(userId, videoId, names, context) {
  const transcript = await readTranscript(userId, videoId);
  const units = translationUnits(transcript.segments ?? []);
  const texts = units.map((u) => u.text.trim());
  const speakers = units.map((u) => ({ speaker: u.speaker ?? null, source: u.speakerSource ?? null }));
  const preview = Math.min(texts.length, config.translateComparePreview);

  console.log(`\nVideo ${videoId} — ${texts.length} đơn vị dịch, in ${preview} đơn vị đầu\n`);
  console.log("── GỐC ──");
  texts.slice(0, preview).forEach((t, i) => console.log(`  ${i + 1}. ${t}`));

  for (const providerName of names) {
    console.log(`\n── ${providerName} ──`);
    try {
      const provider = await resolveProvider(providerName);
      const startedAt = Date.now();
      const { translations, warnings } = await translateSegments(texts.slice(0, preview), provider, {
        from: config.translateFrom,
        to: config.translateTo,
        context,
        // Có speaker mới so được đúng thứ sẽ chạy thật; thiếu nó thì provider dùng
        // được nhãn người nói bị đem ra so ở thế yếu hơn thực tế.
        speakers: speakers.slice(0, preview),
      });
      translations.forEach((t, i) => console.log(`  ${i + 1}. ${t}`));
      console.log(`  (${((Date.now() - startedAt) / 1000).toFixed(1)}s${warnings.length ? `, ${warnings.length} cảnh báo` : ""})`);
    } catch (err) {
      console.log(`  LỖI: ${err.message}`);
    }
  }
  console.log(`\nChốt provider bằng TRANSLATE_PROVIDER trong .env.`);
}
