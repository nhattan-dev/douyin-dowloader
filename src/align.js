import { createLogger } from "./logger.js";

const log = createLogger("ALIGN");

/**
 * Căn nhãn người nói vào khung của whisper-1.
 *
 * Khung là `segments[]` của whisper-1 — nguồn STT tổng thể, duy nhất phủ 100% thoại
 * và có mốc thời gian đo được, text không đổi bằng nguồn nào khác. Diarize chỉ đắp
 * nhãn speaker theo chồng lấn thời gian (`assignSpeakers`), không đụng tới text.
 *
 * Đo được: diarize bỏ hẳn 42 giây cuối (18% video) nên KHÔNG dùng nó làm khung.
 *
 * `alignText`/`alignChars`/`normalize` bên dưới là thuật toán Needleman-Wunsch để
 * căn TEXT giữa hai bản transcript — hiện KHÔNG dùng trong pipeline chính (từng
 * dùng để đắp text của diarize vào whisper, đã bỏ cùng lúc bỏ vai trò text của
 * diarize). `alignChars`/`normalize` vẫn được `src/stt-compare.js` dùng cho lệnh
 * `compare` (so văn bản giữa các STT engine), nên giữ lại chứ không phải dead code.
 */

// ── Chuẩn hoá ──────────────────────────────────────────────────────────────

// Dấu câu và khoảng trắng khác nhau giữa các model (gpt-4o-transcribe có dấu câu
// đầy đủ, diarize gần như không có), nên phải bỏ hết trước khi so ký tự.
const SKIP = /[\s\p{P}\p{S}]/u;

/** Trả về mảng ký tự đã lọc + chỉ số của từng ký tự trong chuỗi gốc. */
export function normalize(text) {
  const chars = [];
  const indices = [];
  for (let i = 0; i < text.length; i += 1) {
    if (SKIP.test(text[i])) continue;
    chars.push(text[i]);
    indices.push(i);
  }
  return { chars, indices };
}

// ── Needleman-Wunsch ───────────────────────────────────────────────────────

const MATCH = 2;
const MISMATCH = -1;
const GAP = -2;

// Hướng truy vết, lưu trong Uint8Array cho gọn bộ nhớ.
const DIAG = 1;
const UP = 2;
const LEFT = 3;

/**
 * Căn toàn cục hai mảng ký tự.
 *
 * Trả về `mapping`: với mỗi vị trí của `a`, chỉ số ký tự tương ứng trong `b`,
 * hoặc -1 nếu không khớp được với ký tự nào.
 *
 * Quy mô thực tế ~460×460 nên bảng đầy đủ vẫn rẻ; không cần thuật toán xấp xỉ.
 */
export function alignChars(a, b) {
  const n = a.length;
  const m = b.length;
  const width = m + 1;

  const score = new Int32Array((n + 1) * width);
  const trace = new Uint8Array((n + 1) * width);

  for (let j = 1; j <= m; j += 1) {
    score[j] = j * GAP;
    trace[j] = LEFT;
  }
  for (let i = 1; i <= n; i += 1) {
    score[i * width] = i * GAP;
    trace[i * width] = UP;
  }

  for (let i = 1; i <= n; i += 1) {
    const row = i * width;
    const prev = row - width;
    const ai = a[i - 1];
    for (let j = 1; j <= m; j += 1) {
      const diag = score[prev + j - 1] + (ai === b[j - 1] ? MATCH : MISMATCH);
      const up = score[prev + j] + GAP;
      const left = score[row + j - 1] + GAP;

      let best = diag;
      let dir = DIAG;
      if (up > best) {
        best = up;
        dir = UP;
      }
      if (left > best) {
        best = left;
        dir = LEFT;
      }
      score[row + j] = best;
      trace[row + j] = dir;
    }
  }

  const mapping = new Int32Array(n).fill(-1);
  let matches = 0;
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    const dir = trace[i * width + j];
    if (dir === DIAG) {
      if (a[i - 1] === b[j - 1]) {
        mapping[i - 1] = j - 1;
        matches += 1;
      }
      i -= 1;
      j -= 1;
    } else if (dir === UP) {
      i -= 1;
    } else {
      j -= 1;
    }
  }

  return { mapping, matches };
}

// ── 1. Text chuẩn → segment của whisper ────────────────────────────────────

/**
 * Thay text từng segment bằng phần tương ứng của bản nhận dạng tốt hơn.
 *
 * Cắt theo mốc giữa hai segment liền kề chứ không theo phạm vi khớp của riêng
 * từng segment — nhờ vậy chữ nào của bản chuẩn cũng thuộc về đúng một segment,
 * kể cả chữ mà whisper nghe sót hoàn toàn nên không căn được vào đâu.
 *
 * `minScore`: segment khớp quá thấp thì GIỮ NGUYÊN text của whisper. Dán nhầm chữ
 * của câu khác vào còn tệ hơn là để nguyên bản kém.
 */
export function alignText(segments, refText, { minScore = 0.6 } = {}) {
  if (!refText?.trim() || segments.length === 0) {
    return segments.map((s) => ({ text: s.text, alignScore: null, textSource: "whisper" }));
  }

  // Nối text whisper lại, nhớ mỗi ký tự thuộc segment nào.
  const segChars = [];
  const segOwner = [];
  const segLen = [];
  for (const [idx, seg] of segments.entries()) {
    const chars = normalize(seg.text).chars;
    segLen.push(chars.length);
    for (const ch of chars) {
      segChars.push(ch);
      segOwner.push(idx);
    }
  }

  const ref = normalize(refText);
  const { mapping, matches } = alignChars(segChars, ref.chars);
  log.debug(
    `căn ${segChars.length} ký tự whisper với ${ref.chars.length} ký tự bản chuẩn, khớp ${matches}`,
  );

  const firstRefOf = new Array(segments.length).fill(-1);
  const lastRefOf = new Array(segments.length).fill(-1);
  const matchCount = new Array(segments.length).fill(0);
  for (let k = 0; k < segChars.length; k += 1) {
    if (mapping[k] < 0) continue;
    const owner = segOwner[k];
    if (firstRefOf[owner] < 0) firstRefOf[owner] = mapping[k];
    lastRefOf[owner] = mapping[k];
    matchCount[owner] += 1;
  }

  // Mốc cắt giữa segment i và i+1, tính trên chỉ số ký tự đã chuẩn hoá.
  //
  // Cắt tại ký tự khớp ĐẦU TIÊN của segment sau, không phải sau ký tự khớp cuối
  // của segment trước: khi chữ cuối của segment trước bị nghe sai (whisper 四节 vs
  // bản chuẩn 四阶) thì ký tự không khớp đó nằm lơ lửng, và cắt theo mốc cuối sẽ
  // đẩy nó sang segment sau — sinh ra rác kiểu "阶,不好,是阵法!".
  const cuts = [0];
  let carry = 0;
  for (let i = 0; i < segments.length - 1; i += 1) {
    if (firstRefOf[i + 1] >= 0) carry = firstRefOf[i + 1];
    else if (lastRefOf[i] >= 0) carry = lastRefOf[i] + 1;
    cuts.push(carry);
  }
  cuts.push(ref.chars.length);

  return segments.map((seg, i) => {
    const from = cuts[i];
    const to = Math.max(cuts[i + 1], from);
    const alignScore = segLen[i] === 0 ? 0 : matchCount[i] / segLen[i];

    if (from >= to || alignScore < minScore) {
      return { text: seg.text.trim(), alignScore, textSource: "whisper" };
    }
    // Cắt trên chuỗi GỐC để giữ lại dấu câu của bản chuẩn.
    const start = ref.indices[from];
    const end = to >= ref.indices.length ? refText.length : ref.indices[to];
    return { text: refText.slice(start, end).trim(), alignScore, textSource: "gpt-4o-transcribe" };
  });
}

// ── 2. Speaker → segment của whisper ───────────────────────────────────────

/**
 * Gán nhãn speaker theo chồng lấn thời gian.
 *
 * Không chồng lấn với segment diarize nào thì để `null` — KHÔNG kế thừa từ segment
 * liền trước, vì ở cảnh nhiều người cùng hô thì đoán như vậy gần như chắc sai.
 * Phần `null` để bước suy bằng LLM xử lý, và được đánh dấu để review.
 */
export function assignSpeakers(segments, diarizeSegments, { nearestWithinSec = 3 } = {}) {
  if (!diarizeSegments?.length) {
    return segments.map(() => ({ speaker: null, speakerSource: null }));
  }

  return segments.map((seg) => {
    let best = null;
    let bestOverlap = 0;
    for (const d of diarizeSegments) {
      const overlap = Math.min(seg.end, d.end) - Math.max(seg.start, d.start);
      if (overlap > bestOverlap) {
        bestOverlap = overlap;
        best = d;
      }
    }
    if (best) return { speaker: best.speaker, speakerSource: "diarize" };

    // Không chồng lấn: nhận segment gần nhất, nhưng chỉ khi thật sự sát bên.
    let nearest = null;
    let nearestGap = Infinity;
    for (const d of diarizeSegments) {
      const gap = seg.start > d.end ? seg.start - d.end : d.start - seg.end;
      if (gap >= 0 && gap < nearestGap) {
        nearestGap = gap;
        nearest = d;
      }
    }
    if (nearest && nearestGap <= nearestWithinSec) {
      return { speaker: nearest.speaker, speakerSource: "diarize" };
    }
    return { speaker: null, speakerSource: null };
  });
}

// ── 3. Gộp lượt thoại ──────────────────────────────────────────────────────

const HAN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;

/**
 * Nối text hai segment. Tiếng Trung viết liền không khoảng trắng, nên chèn dấu cách
 * là tự tạo ra chữ sai: whisper cắt 昨日 thành `…出事,作` + `日有四个金丹…` (đúng ranh
 * giới chunk của nó), nối bằng dấu cách ra `作 日` — cả hai nửa đều vô nghĩa và bản
 * dịch nhận về "gặp chuyện, làm" / "Ngày hôm đó".
 *
 * Chỉ cần MỘT bên là chữ Hán là bỏ dấu cách: transcript dùng dấu câu ASCII (`,`, `?`)
 * nên xét cả hai bên cùng lúc sẽ bỏ sót chỗ nối ngay sau dấu phẩy. Văn bản không có
 * chữ Hán thì vẫn nối bằng dấu cách như thường.
 */
function joinText(a, b) {
  if (!a) return b;
  if (!b) return a;
  const glue = HAN.test(a.at(-1)) || HAN.test(b[0]) ? "" : " ";
  return `${a}${glue}${b}`;
}

/**
 * Gộp các segment liền nhau cùng người nói thành một lượt thoại.
 *
 * Ngưỡng khoảng lặng là bắt buộc: video mẫu có 8 khoảng trống > 5s (51% thời lượng
 * không có thoại), gộp bừa qua đó là dính hai cảnh khác nhau vào một lượt.
 *
 * Dùng cho 2 mục đích với 2 ngưỡng khác nhau — xem SPEAKER_MERGE_MAX_GAP_SEC (trường
 * `turns`, gộp rộng để đọc cho dễ) và TRANSLATE_MERGE_MAX_GAP_SEC (đơn vị đem đi
 * dịch, gộp chặt để không nuốt mất khoảng lặng thật).
 *
 * `speakerSource` của lượt lấy theo mức KÉM TIN CẬY NHẤT trong các segment thành
 * phần: gộp một nhãn chắc chắn với một nhãn suy đoán thì cả lượt vẫn là suy đoán.
 */
export function mergeSpeakerTurns(segments, { maxGapSec = 1.5 } = {}) {
  const turns = [];
  for (const [index, seg] of segments.entries()) {
    const last = turns.at(-1);
    const sameSpeaker = last && last.speaker === seg.speaker;
    const closeEnough = last && seg.start - last.end <= maxGapSec;
    if (sameSpeaker && closeEnough) {
      last.end = seg.end;
      last.text = joinText(last.text, seg.text).trim();
      last.segmentIndexes.push(index);
      if (seg.speakerSource === "inferred") last.speakerSource = "inferred";
      continue;
    }
    turns.push({
      speaker: seg.speaker,
      speakerSource: seg.speakerSource ?? null,
      start: seg.start,
      end: seg.end,
      text: seg.text,
      segmentIndexes: [index],
    });
  }
  return turns;
}
