// Đổi file apiKey CSV tải từ console Alibaba Model Studio thành các dòng .env.
//
// Console cho tải về một file CSV hai cột (`khoá,giá trị`) chứa cả key lẫn host. Host
// đi kèm key là chuyện bắt buộc phải để ý: key cấp theo workspace thì host cũng riêng
// theo workspace (`https://<workspaceId>.<region>.maas.aliyuncs.com`), dùng host chung
// dashscope-intl.aliyuncs.com với key đó là 401/404. Chép tay hai chuỗi dài đó qua
// .env là chỗ dễ sai và dễ lệch nhau, nên để script đọc thẳng từ file gốc.
//
// Dùng:
//   node scripts/apikey-csv-to-env.js                  # tự tìm CSV trong secret/, in ra
//   node scripts/apikey-csv-to-env.js --write          # ghi thẳng vào .env
//   node scripts/apikey-csv-to-env.js <file.csv> [--write]
//
// Mặc định chỉ IN RA cho soi rồi tự chép; --write mới đụng vào .env (ghi đè đúng các
// dòng khoá tương ứng, giữ nguyên phần còn lại của file).

import fs from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const SECRET_DIR = path.join(root, "secret");
const ENV_FILE = path.join(root, ".env");

/**
 * Cột nào trong CSV thành biến môi trường nào.
 *
 * `apiHost` là host trần không có scheme, còn `openAiCompatible` đã là URL đầy đủ —
 * nên mỗi dòng tự khai cách dựng giá trị thay vì đoán theo hình dạng chuỗi.
 */
const MAPPING = [
  { column: "apiKey", env: "DASHSCOPE_API_KEY", build: (v) => v, secret: true },
  // Host cho DashScope native — đường DUY NHẤT gọi được Qwen-ASR (xem src/asr-qwen.js).
  // Vào .env dưới dạng gốc, không kèm đuôi đường dẫn: asr-qwen.js tự nối `/api/v1/...`.
  { column: "apiHost", env: "DASHSCOPE_BASE_URL", build: (v) => `https://${v}` },
  // Endpoint OpenAI-compatible, dùng khi chạy Qwen làm model DỊCH. Cũng phải lấy từ
  // đây chứ không xài default trong config.js — default trỏ host chung, không khớp key.
  { column: "openAiCompatible", env: "QWEN_BASE_URL", build: (v) => v },
];

/** `sk-ws-H.DDIIRIH...49xc` — đủ để đối chiếu bằng mắt, không lộ cả key ra terminal. */
const mask = (v) => (v.length <= 16 ? "***" : `${v.slice(0, 10)}...${v.slice(-4)}`);

/** Đường dẫn gọn trong repo, nhưng file ngoài repo thì in nguyên đường tuyệt đối chứ
 * không phải một chuỗi `../../../..` không ai đọc nổi. */
function display(p) {
  const rel = path.relative(root, p);
  return rel.startsWith("..") ? p : rel;
}

/**
 * Đọc CSV hai cột thành map.
 *
 * File console xuất ra có BOM ở đầu — không bóc thì khoá đầu tiên thành "﻿id" và
 * mọi thứ khác vẫn chạy đúng, chỉ riêng dòng đầu lặng lẽ mất. Tách theo dấu phẩy ĐẦU
 * TIÊN chứ không split(",") vì giá trị có thể chứa dấu phẩy.
 */
function parseCsv(text) {
  const map = new Map();
  for (const line of text.replace(/^﻿/, "").split(/\r?\n/)) {
    const i = line.indexOf(",");
    if (i < 0) continue;
    const key = line.slice(0, i).trim();
    const value = line.slice(i + 1).trim();
    if (key && value) map.set(key, value);
  }
  return map;
}

/** Không truyền đường dẫn thì tự dò secret/ — chỉ nhận khi có đúng một file. */
async function findCsv() {
  let entries;
  try {
    entries = await fs.readdir(SECRET_DIR);
  } catch {
    throw new Error(`không có thư mục ${display(SECRET_DIR)}/ — tải file apiKey CSV từ console về đó`);
  }
  const csvs = entries.filter((f) => f.toLowerCase().endsWith(".csv"));
  if (csvs.length === 0) throw new Error(`không thấy file .csv nào trong ${display(SECRET_DIR)}/`);
  if (csvs.length > 1) {
    throw new Error(
      `có ${csvs.length} file .csv trong secret/, không đoán được dùng file nào — chỉ rõ ra:\n` +
        csvs.map((f) => `  node scripts/apikey-csv-to-env.js secret/${f}`).join("\n"),
    );
  }
  return path.join(SECRET_DIR, csvs[0]);
}

/**
 * Ghi đè từng khoá trong .env, giữ nguyên phần còn lại.
 *
 * Sửa tại chỗ chứ không nối thêm vào cuối: nối thêm thì .env dần có hai dòng cùng khoá,
 * mà Node lấy dòng SAU, nên sửa dòng đầu xong thấy không ăn gì lại càng khó hiểu.
 * Comment và thứ tự các dòng khác giữ nguyên để diff còn đọc được.
 */
function applyToEnv(envText, values) {
  let out = envText;
  const appended = [];

  for (const [key, value] of values) {
    const line = `${key}=${value}`;
    // Bắt cả dòng đang bị comment (`# KEY=...`) — đó là dòng chờ điền, không phải ghi chú.
    const re = new RegExp(`^#?\\s*${key}=.*$`, "m");
    if (re.test(out)) out = out.replace(re, line);
    else appended.push(line);
  }

  if (appended.length > 0) {
    out = `${out.replace(/\n*$/, "\n")}\n# Sinh bởi scripts/apikey-csv-to-env.js\n${appended.join("\n")}\n`;
  }
  return out;
}

async function main() {
  const args = process.argv.slice(2);
  const write = args.includes("--write");
  const csvArg = args.find((a) => !a.startsWith("--"));
  const csvPath = csvArg ? path.resolve(root, csvArg) : await findCsv();

  const map = parseCsv(await fs.readFile(csvPath, "utf8"));
  console.log(`đọc ${display(csvPath)}`);
  const label = map.get("workspaceName") ?? map.get("workspaceId");
  if (label) console.log(`workspace: ${label}${map.get("description") ? ` (${map.get("description")})` : ""}`);

  const values = new Map();
  const missing = [];
  for (const { column, env, build } of MAPPING) {
    const raw = map.get(column);
    if (!raw) {
      missing.push(column);
      continue;
    }
    values.set(env, build(raw));
  }
  if (values.size === 0) {
    throw new Error(
      `CSV không có cột nào dùng được (cần ${MAPPING.map((m) => m.column).join(", ")}) — ` +
        `file này có: ${[...map.keys()].join(", ")}`,
    );
  }
  // Thiếu cột thì chỉ nói ra rồi chạy tiếp với những cột có: file CSV của các loại key
  // khác nhau không giống hệt nhau, hỏng cả lệnh vì thiếu một cột là quá gắt.
  if (missing.length > 0) console.log(`(CSV không có cột: ${missing.join(", ")} — bỏ qua)`);

  console.log("");
  for (const { env, secret } of MAPPING) {
    const value = values.get(env);
    if (value) console.log(`${env}=${secret ? mask(value) : value}`);
  }

  if (!write) {
    console.log(`\nChưa ghi gì. Thêm --write để ghi vào ${display(ENV_FILE)}.`);
    return;
  }

  let envText = "";
  try {
    envText = await fs.readFile(ENV_FILE, "utf8");
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
    console.log(`(chưa có ${display(ENV_FILE)} — tạo mới)`);
  }
  await fs.writeFile(ENV_FILE, applyToEnv(envText, values), "utf8");
  console.log(`\nđã ghi ${values.size} biến vào ${display(ENV_FILE)}`);
}

main().catch((err) => {
  console.error("lỗi:", err.message);
  process.exit(1);
});
