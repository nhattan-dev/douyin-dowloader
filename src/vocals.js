import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { createLogger } from "./logger.js";

const run = promisify(execFile);
const log = createLogger("VOCALS");

/**
 * Tách vocal khỏi audio bằng Demucs (`--two-stems=vocals`).
 *
 * KHÔNG dùng trong pipeline chính (src/stt.js) — đã thử đưa vào nhánh diarize và đo
 * được cải thiện thật (coverage video mẫu 81.6% → 97.3%, xem README mục "Tách vocal
 * trước khi gửi diarize — đã thử, bỏ"), nhưng Demucs là neural net chạy CPU, tốn vài
 * phút/video, nhân với hàng trăm video trong 1 batch thì thành bottleneck cổ chai
 * của cả pipeline. Không đáng đổi tốc độ batch lấy vài % coverage cho riêng nhãn
 * người nói, khi đã có "không xác định" làm phương án chấp nhận được.
 *
 * Vẫn giữ module này lại — dùng độc lập bởi `scripts/compare-diarize-bgm.js` khi
 * cần đo lại, hoặc cho ai muốn tự bật lại cho một mẻ nhỏ cần chất lượng cao thay vì
 * default cho cả batch.
 *
 * Không cache vĩnh viễn `vocals.wav`: gọi `cleanupVocals` sau khi dùng xong — giữ
 * nguyên file WAV (~40MB/video ở PCM 44.1kHz) nhân với hàng trăm video thì tốn ổ đĩa
 * vô ích, tách lại tốn CPU chứ không tốn tiền.
 */
export async function separateVocals(audioPath, workDir) {
  const outDir = path.join(workDir, "_demucs");
  await fs.rm(outDir, { recursive: true, force: true }); // dọn tàn dư nếu lần trước lỗi giữa chừng

  const args = ["--two-stems=vocals", "-n", "htdemucs", "-o", outDir, audioPath];
  log.info(`tách vocal: demucs ${args.join(" ")}`);
  const t0 = Date.now();
  try {
    await run("demucs", args, { maxBuffer: 1024 * 1024 * 50, env: { ...process.env, PYTHONUTF8: "1" } });
  } catch (err) {
    throw new Error(
      `demucs lỗi (đã cài chưa? \`pipx install demucs\` rồi \`pipx inject demucs numpy\`): ${err.message}`,
    );
  }
  log.info(`tách vocal xong trong ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  const stem = path.basename(audioPath, path.extname(audioPath));
  const vocalsPath = path.join(outDir, "htdemucs", stem, "vocals.wav");
  await fs.access(vocalsPath); // báo lỗi rõ nếu demucs không sinh file như kỳ vọng
  return vocalsPath;
}

/** Dọn thư mục tạm của demucs (vocals.wav + no_vocals.wav) sau khi đã dùng xong. */
export async function cleanupVocals(workDir) {
  await fs.rm(path.join(workDir, "_demucs"), { recursive: true, force: true });
}
