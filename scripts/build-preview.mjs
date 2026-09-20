// Dựng bản xem trước phát được trong trình duyệt cho video.mp4 mã hoá không phổ biến (Douyin hay
// xuất HEVC/h265): Chrome/Chromium không giải mã HEVC trong thẻ <video> (canPlayType rỗng,
// videoWidth luôn 0) — âm thanh vẫn phát, currentTime vẫn chạy (đồng hồ theo track audio) nhưng
// hình đứng im, dễ tưởng nhầm là video hỏng.
//
// video.mp4 gốc không đụng tới (còn dùng cho demucs, dub-video…), nên dựng riêng preview.mp4 nhẹ
// hơn (thu nhỏ cạnh dài còn 1280, preset nhanh) chỉ để xem đối chiếu ở tab Dịch / nút «Bản gốc» —
// không phải bản xuất nên không cần giữ nguyên độ phân giải như dub-video.mjs.
//
// Dùng: node scripts/build-preview.mjs --dir <videoDir>
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import { encoderArgs, pickEncoder } from "./lib/encoder.mjs";

const run = promisify(execFile);
const sh = (cmd, args) => run(cmd, args, { maxBuffer: 1024 * 1024 * 64 });

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith("--")) continue;
    out[argv[i].slice(2)] = argv[i + 1];
    i += 1;
  }
  return out;
}

async function main() {
  const { dir } = parseArgs(process.argv.slice(2));
  if (!dir) throw new Error("cần --dir <videoDir>");
  const src = path.join(dir, "video.mp4");
  const dst = path.join(dir, "preview.mp4");

  const { stdout } = await sh("ffprobe", ["-v", "error", "-select_streams", "v:0",
    "-show_entries", "stream=codec_name", "-of", "csv=p=0", src]);
  const codec = stdout.trim();
  if (codec === "h264") {
    console.log("video.mp4 đã là h264, trình duyệt phát thẳng được — khỏi cần bản xem trước riêng");
    return;
  }

  // Bộ mã hoá theo năng lực máy (lib/encoder.mjs) — cùng một lựa chọn với dub-video, dò một lần
  // rồi nhớ, nên máy có GPU không phải chờ CPU encode.
  const encoder = await pickEncoder(parseArgs(process.argv.slice(2)).encoder ?? "auto", { log: console });
  console.log(`video.mp4 codec ${codec} — dựng bản xem trước (thu nhỏ cạnh dài 1280) [${encoder}]…`);
  const vf = "scale='if(gt(iw,ih),1280,-2)':'if(gt(iw,ih),-2,1280)'";
  await sh("ffmpeg", ["-v", "error", "-y", "-i", src, "-vf", vf,
    ...encoderArgs(encoder), "-c:a", "aac", "-b:a", "128k", dst]);
  console.log(`→ ${dst}`);
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
