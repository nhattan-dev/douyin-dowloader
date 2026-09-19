import { alignChars, normalize } from "./align.js";
import { config } from "./config.js";
import { loadGlossary } from "./glossary.js";
import { createLogger } from "./logger.js";
import { transcribeWith } from "./stt-engines.js";

const log = createLogger("STT/compare");

/**
 * So các engine STT trên cùng một file audio.
 *
 * Bản cũ in hai bức tường chữ Hán cạnh nhau rồi để người tự nhìn. Với ~460 ký tự
 * tiếng Trung mỗi bản thì đó không phải so sánh, đó là đoán.
 *
 * Căn cứ CHÍNH là phần diff: chỉ hiện ra ĐÚNG những chỗ hai engine nghe khác nhau,
 * kèm ngữ cảnh. Video mẫu ra 35 điểm — đọc ngần đó thay vì hai transcript đầy đủ.
 *
 * Điểm theo glossary chỉ là phụ và ĐÃ ĐO LÀ YẾU: glossary 151 mục chỉ phủ 3/12 từ
 * phân định trên video mẫu, nên nó ra 14 vs 13 sát nút trong khi diff cho thấy hơn
 * kém rõ ràng. Giữ lại vì nó là con số tuyệt đối duy nhất có được mà không phải ngồi
 * nghe lại 227 giây audio — nhưng đừng chốt model bằng riêng nó.
 *
 * Thứ bảng này KHÔNG trả lời: timestamp và nhãn người nói. Timestamp thì cột cuối có
 * ghi có/không (whisper-1 và qwen có, số còn lại không), nhưng bảng không so ĐỘ CHÍNH
 * XÁC của nó — đo được qwen trễ hơn whisper ~0.35s trung vị trên video mẫu, mà bảng
 * này không thấy. Còn nhãn người nói thì không engine nào ở đây có: nó đến từ bước
 * diarize riêng. Đó là câu hỏi riêng — xem README.
 */
// Chữ Hán chiếm hai ô trên terminal còn dấu cách chiếm một, nên đệm bằng dấu cách
// thường thì dòng dưới lệch hẳn khỏi dòng trên. Thay từng chữ bằng khoảng trắng
// full-width (U+3000) để hai dòng thẳng hàng.
const WIDE = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹯＀-｠￠-￦]/;
const blankLike = (text) => [...text].map((ch) => (WIDE.test(ch) ? "　" : " ")).join("");

/** Thuật ngữ (mặt chữ đúng) mà engine này nghe ra được. */
function glossaryHits(text, terms) {
  return new Set(terms.filter((zh) => text.includes(zh)));
}

/**
 * Các điểm hai transcript BẤT ĐỒNG, kèm ngữ cảnh hai bên.
 *
 * Đây mới là thước đo chính, không phải glossary. Đo thật trên video mẫu:
 * glossary 151 mục chỉ phủ 3/12 từ phân định thắng thua (`灵石`, `禁制`, `洞府` có,
 * còn `下品宝剑`, `三阶`, `极北`, `四阶`, `御寒袍`, `玄黄钟`… đều không) — nên bảng
 * điểm theo glossary ra 14 vs 13, sát nút, trong khi đọc text thì hơn kém rõ ràng.
 *
 * Diff thì không phụ thuộc vào việc ai đó nhớ bổ sung glossary: nó chỉ ra ĐÚNG những
 * chỗ hai engine nghe khác nhau. Chỗ nào giống nhau thì không cần nhìn.
 */
function diffSpans(a, b, { context = 5 } = {}) {
  const ca = normalize(a).chars;
  const cb = normalize(b).chars;
  const { mapping } = alignChars(ca, cb);

  const pairs = [];
  for (let i = 0; i < mapping.length; i += 1) {
    if (mapping[i] >= 0) pairs.push([i, mapping[i]]);
  }

  const spans = [];
  // Coi như có một cặp khớp ảo ở trước đầu và sau cuối, để bắt cả phần lệch ở hai rìa.
  const bounded = [[-1, -1], ...pairs, [ca.length, cb.length]];
  for (let k = 1; k < bounded.length; k += 1) {
    const [ia, ib] = bounded[k - 1];
    const [ja, jb] = bounded[k];
    const left = ca.slice(ia + 1, ja).join("");
    const right = cb.slice(ib + 1, jb).join("");
    if (!left && !right) continue;
    spans.push({
      before: ca.slice(Math.max(0, ia + 1 - context), ia + 1).join(""),
      a: left,
      b: right,
      after: ca.slice(ja, ja + context).join(""),
    });
  }
  return spans;
}

/**
 * Tỉ lệ ký tự trùng khớp giữa hai transcript, bỏ dấu câu và khoảng trắng.
 *
 * Dùng lại đúng thuật toán căn của pipeline (Needleman-Wunsch) nên con số này đọc
 * cùng thang với `alignScore` trong transcript.json. Hai engine giống nhau KHÔNG
 * chứng minh cả hai đúng — nhưng một engine lệch hẳn khỏi phần còn lại thì đáng ngờ.
 */
function agreement(a, b) {
  const na = normalize(a).chars;
  const nb = normalize(b).chars;
  if (na.length === 0 || nb.length === 0) return 0;
  const { matches } = alignChars(na, nb);
  return matches / Math.max(na.length, nb.length);
}

export async function compareStt(userId, videoId, specs, { audioPath, openaiTranscribe }) {
  const entries = await loadGlossary();
  const terms = entries.map(([zh]) => zh);

  console.log(`\nFile: ${audioPath}`);
  console.log(`Đáp án: ${terms.length} thuật ngữ trong ${config.glossaryFile}\n`);

  const results = [];
  for (const spec of specs) {
    process.stdout.write(`chạy ${spec} ... `);
    try {
      const r = await transcribeWith(spec, audioPath, openaiTranscribe);
      results.push({ spec, ...r, hits: glossaryHits(r.text, terms) });
      console.log(`${(r.ms / 1000).toFixed(1)}s, ${r.text.length} ký tự`);
    } catch (err) {
      results.push({ spec, error: err.message });
      console.log(`LỖI: ${err.message}`);
    }
  }

  const ok = results.filter((r) => !r.error && r.text);
  if (ok.length === 0) {
    console.log("\nKhông engine nào chạy được — không có gì để so.");
    return results;
  }

  // ── Bảng điểm ──
  const best = Math.max(...ok.map((r) => r.hits.size));
  console.log(`\n${"═".repeat(72)}\nBẢNG ĐIỂM\n${"═".repeat(72)}`);
  console.log(
    `${"engine/model".padEnd(34)}${"thuật ngữ".padStart(10)}${"ký tự".padStart(8)}` +
      `${"giây".padStart(8)}${"  timestamp"}`,
  );
  for (const r of ok.sort((a, b) => b.hits.size - a.hits.size)) {
    const mark = r.hits.size === best ? " ←" : "";
    console.log(
      `${`${r.engine}/${r.model}`.padEnd(34)}${String(r.hits.size).padStart(10)}` +
        `${String(r.text.length).padStart(8)}${(r.ms / 1000).toFixed(1).padStart(8)}` +
        `${(r.hasTimestamps ? "  có" : "  KHÔNG").padEnd(11)}${mark}`,
    );
  }

  // ── Thuật ngữ phân định thắng thua ──
  // Chỉ liệt kê những thuật ngữ mà các engine KHÔNG đồng ý với nhau. Thuật ngữ nào
  // engine nào cũng nghe ra thì không giúp chọn, in ra chỉ tổ dài.
  const union = new Set(ok.flatMap((r) => [...r.hits]));
  const split = [...union].filter((t) => ok.some((r) => !r.hits.has(t)));
  if (split.length > 0) {
    console.log(`\n${"─".repeat(72)}\nTHUẬT NGỮ PHÂN ĐỊNH (${split.length}) — engine nào nghe ra, engine nào không\n${"─".repeat(72)}`);
    for (const t of split.sort()) {
      const got = ok.filter((r) => r.hits.has(t)).map((r) => r.model);
      const miss = ok.filter((r) => !r.hits.has(t)).map((r) => r.model);
      console.log(`  ${t.padEnd(12)} ✓ ${got.join(", ")}`);
      console.log(`  ${" ".repeat(12)} ✗ ${miss.join(", ")}`);
    }
    console.log(
      "\nEngine ✗ đã nghe thành chữ đồng âm khác. Tìm cụm đó trong transcript bên dưới\n" +
        "để thấy nó nghe thành gì — đấy là bằng chứng cụ thể nhất để chốt.",
    );
  } else {
    console.log("\nMọi engine nghe ra cùng một bộ thuật ngữ — thước đo này không phân định được.");
  }

  // ── Bất đồng từng cặp — phần quan trọng nhất ──
  if (ok.length > 1) {
    console.log(`\n${"═".repeat(72)}\nCÁC ĐIỂM NGHE KHÁC NHAU\n${"═".repeat(72)}`);
    for (let i = 0; i < ok.length; i += 1) {
      for (let j = i + 1; j < ok.length; j += 1) {
        const [x, y] = [ok[i], ok[j]];
        const spans = diffSpans(x.text, y.text);
        const score = agreement(x.text, y.text);
        console.log(
          `\n${x.model} ↔ ${y.model} — trùng ${(score * 100).toFixed(1)}%, ` +
            `${spans.length} điểm khác\n${"─".repeat(72)}`,
        );
        for (const s of spans.slice(0, config.sttCompareMaxDiffs)) {
          console.log(`  …${s.before}⟨${s.a || "∅"}⟩${s.after}…`);
          console.log(`  ${blankLike(s.before)} ⟨${s.b || "∅"}⟩   ← ${y.model}\n`);
        }
        if (spans.length > config.sttCompareMaxDiffs) {
          console.log(`  … còn ${spans.length - config.sttCompareMaxDiffs} điểm nữa ` +
            `(nới STT_COMPARE_MAX_DIFFS để xem hết)`);
        }
      }
    }
    console.log(
      "Dòng trên là engine trái, dòng dưới là engine phải. Bạn chỉ cần đọc ngần này\n" +
        "thay vì hai bản transcript đầy đủ — chỗ nào giống nhau thì không hiện ra.\n" +
        "Giống nhau KHÔNG chứng minh cả hai đúng, chỉ có nghe lại audio mới chốt được.",
    );
  }

  // ── Transcript đầy đủ ──
  for (const r of results) {
    console.log(`\n${"─".repeat(72)}\n${r.spec}\n${"─".repeat(72)}`);
    console.log(r.error ? `LỖI: ${r.error}` : r.text || "(rỗng)");
  }

  console.log(
    `\nChốt bằng STT_MODEL trong .env.` +
      `\nNhớ: bảng này chỉ so CHỮ NGHE ĐƯỢC. Cột timestamp chỉ nói CÓ hay KHÔNG, không nói` +
      `\nchính xác tới đâu; nhãn người nói thì đến từ bước diarize riêng (xem README).`,
  );

  log.debug(`${ok.length}/${results.length} engine chạy được`);
  return results;
}
