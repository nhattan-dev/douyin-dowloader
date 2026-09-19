// Chấm ĐỘ TỰ NHIÊN của audio bằng model nghe được (gpt-audio), thứ mà ASR và
// resemblyzer đều mù.
//
// Vì sao cần: hai thước đo cũ của pipeline đo nhầm trọng tâm — ASR chỉ trả lời
// "nghe ra chữ gì", resemblyzer chỉ trả lời "giống ai". Một bản đọc đều đều như
// máy, ngắt nghỉ vô nghĩa, rè tiếng vẫn có thể đạt 96% ASR và 0.86 similarity.
// Người nghe thì thấy "gượng" ngay. Model nghe được audio là cách duy nhất đo
// được cái đó mà không phải ngồi nghe tay từng câu.
//
// Chấm MÙ và ĐẢO THỨ TỰ: mỗi câu gửi 2-3 bản (trước VC / sau VC / giọng gốc tiếng
// Trung) dưới tên A/B/C xáo ngẫu nhiên, model không biết bản nào là bản nào. Không
// làm vậy thì model có xu hướng khen bản nghe sau, hoặc khen bản mà nó đoán là
// "bản đã xử lý".
//
// Giọng gốc tiếng Trung của chính nhân vật được đưa vào làm MỐC: nó là người thật
// diễn thật, nên điểm của nó là trần thực tế. Bản tổng hợp cách mốc bao xa mới là
// con số đáng đọc, chứ điểm tuyệt đối của một model chấm audio thì trôi theo mood.
//
// Dùng:
//   node --env-file-if-exists=.env scripts/voice-judge.mjs --dir <videoDir> --speaker 孙悟空
//   ... --lines 4        số câu đem chấm (mặc định 4, mỗi câu 1 lượt gọi)
//   ... --model <id>     mặc định gpt-audio-1.5
//   ... --no-anchor      bỏ mốc giọng gốc, chỉ so trước/sau VC
//   ... --vc-dir <path>  chấm một thư mục voice-convert khác (để so hai lần chạy)
import fs from "node:fs/promises";
import path from "node:path";

import { fetchLogged, OPENAI_V1 } from "../src/apiLog.js";
import { config } from "../src/config.js";
import { createLogger } from "../src/logger.js";

const log = createLogger("VOICE-JUDGE");

const DEFAULT_MODEL = "gpt-audio-1.5";

const RUBRIC = `Bạn đang nghe vài bản thu của cùng một câu thoại phim.

QUAN TRỌNG: chỉ chấm CÁCH NÓI, tuyệt đối KHÔNG chấm nội dung. Một số bản có thể là
tiếng Trung, hoặc đọc câu khác hẳn — kệ nó, vẫn chấm bình thường theo cách nói. Bản
nào nói sai chữ, sai câu, sai ngôn ngữ KHÔNG vì thế mà bị trừ điểm.
Chấm TỪNG bản theo 4 tiêu chí, thang 1-5 (5 là tốt nhất):

- tuNhien: nghe như người thật đang nói, hay như máy đọc từng chữ?
- nguDieu: lên xuống giọng, nhấn nhá, chỗ ngắt nghỉ có khớp với nghĩa của câu không?
- sach: có rè, méo, âm kim loại, ù, giật, đuôi từ bị nuốt không? (5 = sạch hoàn toàn)
- camXuc: có sắc thái của một nhân vật đang diễn, hay đều đều vô cảm?

Với mỗi bản, thêm "loi": MỘT câu ngắn nói đúng cái nghe sai nhất (nếu có).
Cuối cùng thêm "tot_nhat": nhãn của bản tự nhiên nhất, và "vi_sao": một câu.

Chỉ trả JSON, không giải thích thêm, dạng:
{"ban": {"A": {"tuNhien":n,"nguDieu":n,"sach":n,"camXuc":n,"loi":"..."}, "B": {...}}, "tot_nhat":"A", "vi_sao":"..."}`;

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith("--")) continue;
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    out[key] = next === undefined || next.startsWith("--") ? true : argv[++i];
  }
  return out;
}
const str = (v, fallback) => (v === undefined || v === true ? fallback : v);

const LABELS = ["A", "B", "C", "D"];

/** Xáo tại chỗ — để model không đoán được bản nào là bản đã xử lý theo vị trí. */
function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

async function judge({ model, apiKey, text, entries }) {
  const content = [{ type: "text", text: `${RUBRIC}\n\nCâu thoại: "${text}"\n\nCác bản:` }];
  for (const e of entries) {
    content.push({ type: "text", text: `Bản ${e.label}:` });
    content.push({
      type: "input_audio",
      input_audio: {
        data: (await fs.readFile(e.file)).toString("base64"),
        format: path.extname(e.file).slice(1) === "mp3" ? "mp3" : "wav",
      },
    });
  }

  const payload = { model, modalities: ["text"], messages: [{ role: "user", content }] };
  // `logBody` là object chứ không phải chuỗi đã stringify: audio base64 nằm trong
  // `content[]` bị cắt riêng từng phần tử, phần còn lại của request vẫn đọc được.
  const { raw, res } = await fetchLogged(
    log,
    `${OPENAI_V1}/chat/completions`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
    { logBody: payload },
  );
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${raw.slice(0, 400)}`);
  const json = JSON.parse(raw);
  const reply = json.choices?.[0]?.message?.content ?? "";
  const m = reply.match(/\{[\s\S]*\}/);
  if (!m) throw new Error(`không parse được JSON từ: ${reply.slice(0, 300)}`);
  return JSON.parse(m[0]);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dir = path.resolve(str(args.dir, ""));
  const speaker = str(args.speaker, "");
  if (!args.dir || !speaker) throw new Error("cần --dir <videoDir> và --speaker <tên>");
  const model = str(args.model, DEFAULT_MODEL);
  const nLines = Number.parseInt(str(args.lines, "4"), 10);
  const apiKey = config.openaiApiKey;
  if (!apiKey) throw new Error("thiếu OPENAI_API_KEY");

  const vcDir = path.resolve(str(args["vc-dir"], path.join(dir, "temp", "voice-convert")));
  const report = JSON.parse(await fs.readFile(path.join(vcDir, "report.json"), "utf8"));
  const voiceDir = path.join(dir, "voice", speaker);

  // Mốc: một câu tiếng Trung dài của chính nhân vật — người thật diễn thật.
  let anchor = null;
  if (!args["no-anchor"]) {
    const manifest = JSON.parse(await fs.readFile(path.join(voiceDir, "manifest.json"), "utf8"));
    const longest = [...manifest.clips].sort((a, b) => b.duration - a.duration)[0];
    anchor = { file: path.join(voiceDir, longest.file), kind: "gốc (tiếng Trung)" };
  }

  const kinds = { "trước VC": [], "sau VC": [], ...(anchor ? { "gốc (tiếng Trung)": [] } : {}) };
  const rows = [];

  for (const line of report.lines.slice(0, nLines)) {
    if (!line.after) continue;
    const variants = [
      { kind: "trước VC", file: path.join(vcDir, line.before.file) },
      { kind: "sau VC", file: path.join(vcDir, line.after.file) },
      ...(anchor ? [anchor] : []),
    ];
    const entries = shuffle(variants).map((v, i) => ({ ...v, label: LABELS[i] }));

    process.stdout.write(`[${String(line.index).padStart(2)}] ${line.vi.slice(0, 50)}… `);
    const verdict = await judge({ model, apiKey, text: line.vi, entries });

    const byKind = {};
    for (const e of entries) {
      const s = verdict.ban?.[e.label];
      if (!s) continue;
      byKind[e.kind] = s;
      kinds[e.kind].push(s);
    }
    const winner = entries.find((e) => e.label === verdict.tot_nhat)?.kind ?? "?";
    console.log(`→ hơn: ${winner}`);
    rows.push({ index: line.index, vi: line.vi, winner, viSao: verdict.vi_sao, scores: byKind });
  }

  const AXES = ["tuNhien", "nguDieu", "sach", "camXuc"];
  const summary = {};
  console.log(`\n${"".padEnd(20)} ${AXES.map((a) => a.padStart(8)).join(" ")}   TB`);
  for (const [kind, list] of Object.entries(kinds)) {
    if (!list.length) continue;
    const avg = AXES.map((a) => list.reduce((s, x) => s + (Number(x[a]) || 0), 0) / list.length);
    summary[kind] = Object.fromEntries(AXES.map((a, i) => [a, Number(avg[i].toFixed(2))]));
    const overall = avg.reduce((s, x) => s + x, 0) / AXES.length;
    summary[kind].tb = Number(overall.toFixed(2));
    console.log(`${kind.padEnd(20)} ${avg.map((v) => v.toFixed(2).padStart(8)).join(" ")}   ${overall.toFixed(2)}`);
  }

  console.log("\nlỗi model nghe thấy:");
  for (const r of rows) {
    for (const [kind, s] of Object.entries(r.scores)) {
      if (s.loi) console.log(`  [${String(r.index).padStart(2)}] ${kind.padEnd(18)} ${s.loi}`);
    }
  }

  const outFile = path.join(vcDir, "judge.json");
  await fs.writeFile(outFile, `${JSON.stringify({ model, speaker, summary, rows }, null, 2)}\n`, "utf8");
  console.log(`\n→ ${outFile}`);
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
