/**
 * Chọn bộ mã hoá video theo NĂNG LỰC THẬT của máy đang chạy — pipeline này chạy trên nhiều máy,
 * có máy có GPU NVIDIA, có máy chỉ có CPU.
 *
 * Hai luật, đều rút từ số đo (đo trên video HEVC 1080p/317s của Douyin, mẫu 20s):
 *
 * 1. **Máy quyết định TỐC ĐỘ, không quyết định ĐẦU RA.** Con số chất lượng của hai bộ mã hoá
 *    KHÔNG ánh xạ sang nhau: `nvenc -cq 20` ra 416 MB trong khi `libx264 -crf 20` ra 209 MB cho
 *    cùng một tập. Vì vậy cả hai đường đều ghìm bằng **trần bitrate**, không bằng con số chất
 *    lượng — đo lại thì hội tụ: CPU 104 MB / GPU 116 MB. Đổi máy thì file giao nộp không đổi.
 *
 * 2. **Preset là đòn bẩy lớn hơn GPU.** Thời gian encode một tập 317s:
 *
 *        cấu hình                  16 nhân   4 nhân   2 nhân
 *        crf20 preset medium        1,5 ph    3,2 ph   6,6 ph   ← từng là mặc định
 *        crf23 preset veryfast      0,8 ph    1,3 ph   2,0 ph
 *        h264_nvenc (GPU)           0,8 ph    0,8 ph   0,8 ph
 *
 *    Đổi preset đã nhanh hơn 3,3× trên máy 2 nhân MÀ file còn nhỏ hơn (104 so với 209 MB), nên
 *    đường CPU chỉ có MỘT cấu hình, không thêm núm theo số nhân. GPU ăn thêm 2,0 -> 0,8 phút.
 *
 * **`ffmpeg -encoders` KHÔNG dùng để dò được**: mọi bản build có bật nvenc đều liệt kê
 * `h264_nvenc` kể cả trên máy không có card NVIDIA — chỉ tới lúc encode thật mới lộ
 * (`CUDA_ERROR_NO_DEVICE`, mã thoát 171). Vì vậy phải encode thử một khung (đo: 0,39s), và chỉ
 * làm một lần: kết quả nhớ ở `data/_ui/caps.json`, khoá theo phiên bản ffmpeg nên đổi/nâng cấp
 * ffmpeg là tự dò lại. File đó theo từng máy, không vào git.
 */
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const CAPS = path.join("data", "_ui", "caps.json");

// Thứ tự thử. h264 chứ không phải hevc: cả hai đường ra đều phải phát được trong thẻ <video> của
// Chrome — đó là lý do có bước encode lại ngay từ đầu.
const GPU_ENCODERS = ["h264_nvenc", "h264_qsv", "h264_vaapi"];

/** Trần bitrate (Mbps) — nguồn Douyin thường ~1,9 Mbps nên 3 là dư để không thấy khác nguồn. */
const MAXRATE = "3M";
const BUFSIZE = "6M";

async function ffmpegVersion() {
  try {
    const { stdout } = await run("ffmpeg", ["-hide_banner", "-version"]);
    return stdout.split("\n")[0].trim();
  } catch {
    return "?";
  }
}

/** Encode thật một khung 256x256 — cách DUY NHẤT phân biệt "có trong build" với "chạy được". */
async function works(encoder) {
  try {
    await run("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=c=black:s=256x256:d=0.1",
      "-c:v", encoder, "-frames:v", "1", "-f", "null", "-"]);
    return true;
  } catch {
    return false;
  }
}

async function readCaps() {
  try {
    return JSON.parse(await fs.readFile(CAPS, "utf8"));
  } catch {
    return null;
  }
}

async function writeCaps(caps) {
  try {
    await fs.mkdir(path.dirname(CAPS), { recursive: true });
    await fs.writeFile(CAPS, `${JSON.stringify(caps, null, 2)}\n`, "utf8");
  } catch {
    // không ghi được thì chỉ mất cache, lần sau dò lại — không phải lỗi đáng dừng việc
  }
}

/**
 * Tên bộ mã hoá dùng được trên máy này, có nhớ. `want`: "auto" | "gpu" | "cpu".
 * "gpu" mà máy không có thì rơi về CPU kèm cảnh báo, chứ không ném — một máy trong đội không có
 * card không nên làm hỏng cả mẻ.
 */
export async function pickEncoder(want = "auto", { log = console } = {}) {
  if (want === "cpu") return "libx264";

  const ver = await ffmpegVersion();
  const caps = await readCaps();
  let gpu = caps?.ffmpeg === ver ? caps.gpuEncoder ?? null : undefined;

  if (gpu === undefined) {
    gpu = null;
    for (const enc of GPU_ENCODERS) {
      if (await works(enc)) { gpu = enc; break; }
    }
    await writeCaps({ ...(caps || {}), ffmpeg: ver, gpuEncoder: gpu, at: new Date().toISOString() });
    log.log?.(gpu ? `dò máy: dùng được ${gpu} (GPU)` : "dò máy: không có bộ mã hoá GPU, dùng CPU (libx264)");
  }

  if (want === "gpu" && !gpu) {
    log.warn?.("--encoder gpu nhưng máy này không có bộ mã hoá GPU chạy được — dùng CPU");
    return "libx264";
  }
  return gpu || "libx264";
}

/**
 * Tham số ffmpeg cho bộ mã hoá đã chọn. Tách khỏi `pickEncoder` để nơi gọi dò MỘT lần rồi dùng
 * cho nhiều lệnh ffmpeg trong cùng một lượt chạy.
 */
export function encoderArgs(encoder) {
  if (encoder === "libx264") {
    return ["-c:v", "libx264", "-crf", "23", "-preset", "veryfast", "-maxrate", MAXRATE, "-bufsize", BUFSIZE];
  }
  if (encoder === "h264_nvenc") {
    return ["-c:v", "h264_nvenc", "-cq", "28", "-preset", "p5", "-maxrate", MAXRATE, "-bufsize", BUFSIZE];
  }
  // qsv/vaapi: không có máy để đo, nên đi đường bitrate thuần cho chắc chắn ra đúng cỡ file
  return ["-c:v", encoder, "-b:v", MAXRATE, "-maxrate", MAXRATE, "-bufsize", BUFSIZE];
}
