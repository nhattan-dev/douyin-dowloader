import { config } from "../config.js";
import { createLogger } from "../logger.js";

const log = createLogger("TR/google-web");

export const name = "google-web";
export const needsBrowser = true;
export const concurrencySafe = false; // nhiều tab cùng lúc lên trang này là mời captcha

/**
 * Lái translate.google.com bằng Playwright.
 *
 * Lý do không dùng API: endpoint free `translate_a/single` chạy model đời cũ, kém
 * hẳn — đã đo, 下品宝剑 ra "đặt một thanh kiếm vào trong một cái chai", còn bản web
 * ra "thanh kiếm tiếp theo" và còn tự sửa được cả lỗi nghe nhầm của STT.
 *
 * Selector lấy từ `npm run probe-translate`. Ưu tiên `jsname` vì class trên trang
 * này là hash sinh theo build (`ryNqvb`, `eDXd3b`) — đổi bất cứ lúc nào.
 */
// Bám vào jsname là chính; aria-label chỉ để dự phòng nên phải liệt kê theo cả ba
// ngôn ngữ giao diện có thể gặp (hl=vi mặc định, nhưng context đang là locale zh-CN).
const INPUT_SELECTORS = [
  'textarea[jsname="BJE2fc"]',
  'textarea[aria-label="Văn bản nguồn"]',
  'textarea[aria-label="原文"]',
  'textarea[aria-label="Source text"]',
];

// Trang đặt bản dịch vào cả một textarea ẩn lẫn span hiển thị. Textarea đọc bằng
// inputValue() sạch hơn: không dính khoảng trắng thừa mà innerText hay thêm vào.
const RESULT_SELECTORS = [
  { selector: 'textarea[jsname="YPqjbf"]', kind: "value" },
  { selector: 'span[jsname="W297wb"]', kind: "text" },
  { selector: "span.ryNqvb", kind: "text" },
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Giữ lại một tab dùng chung cho cả phiên: mở lại trang cho từng video vừa chậm
// vừa dễ bị để ý hơn.
const pages = new WeakMap();

async function getPage(context) {
  const existing = pages.get(context);
  if (existing && !existing.isClosed()) return existing;

  const page = await context.newPage();
  const url =
    `https://translate.google.com/?sl=${config.translateFrom}` +
    `&tl=${config.translateTo}&op=translate&hl=${config.translateUiLang}`;
  log.info(`mở ${url}`);
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
  pages.set(context, page);
  return page;
}

async function firstMatching(page, selectors) {
  for (const candidate of selectors) {
    const selector = typeof candidate === "string" ? candidate : candidate.selector;
    if (await page.$(selector)) return candidate;
  }
  return null;
}

async function readResult(page) {
  for (const { selector, kind } of RESULT_SELECTORS) {
    const el = await page.$(selector);
    if (!el) continue;
    const value = kind === "value" ? await el.inputValue() : await el.textContent();
    if (value?.trim()) return value.trim();
  }
  return null;
}

const countNumbered = (text) => (text.match(/^\s*\d+\s*[.、:：)）]/gm) ?? []).length;

/**
 * Google phục vụ hai model qua cùng một giao diện: bản LLM dịch thoát ý rất tốt, và
 * bản NMT đời cũ dịch từng chữ. Dùng nhiều thì bị hạ xuống NMT — đã đo: hai request
 * đầu ra bản tốt, các request sau ra bản tệ, cùng URL cùng nội dung.
 *
 * Trang không cho biết đang chạy model nào, nên phải suy ra từ một câu mồi đã biết
 * trước kết quả của cả hai model: một thành ngữ mà NMT luôn dịch trần thành
 * "đai vàng…", còn bản LLM thì dịch thoát ý.
 *
 * Câu mồi này được `src/translate.js` chèn vào ĐẦU chính payload thật. Đã thử cách
 * hỏi riêng bằng một request trước đó và hỏng: chính câu hỏi thăm dò đốt mất suất
 * model tốt, để payload thật rơi xuống NMT — canary báo "ổn" trong khi bản dịch
 * nhận về là bản tệ.
 */
export const qualityCanary = {
  get text() {
    return config.translateCanary;
  },
  get bad() {
    return config.translateCanaryBad;
  },
};

/**
 * @param expectLines  số dòng đánh số mong đợi. Google dịch dần từ trên xuống nên
 *   kết quả có thể "đứng yên" một nhịp khi mới xong nửa đầu; chờ đủ số dòng là cách
 *   duy nhất biết chắc đã dịch hết, thay vì đọc phải bản dở dang.
 */
export async function translateText(text, { context, expectLines = 0 }) {
  if (!context) throw new Error("provider google-web cần browser context");
  const page = await getPage(context);

  const input = await firstMatching(page, INPUT_SELECTORS);
  if (!input) {
    throw new Error(
      "không tìm thấy ô nhập của translate.google.com — trang có thể đã đổi cấu trúc, " +
        "chạy `npm run probe-translate` để lấy selector mới",
    );
  }

  const previous = await readResult(page);

  log.debug(`--- REQUEST (fill textarea, ${text.length} ký tự, expectLines=${expectLines}) ---\n${text}`);
  const t0 = Date.now();
  await page.fill(input, "");
  await page.fill(input, text);

  // Bản dịch cập nhật dần khi gõ, nên phải chờ tới lúc nó ĐỨNG YÊN chứ không phải
  // lúc vừa có chữ — đọc sớm là lấy phải bản dịch dở dang của nửa đầu payload.
  const deadline = Date.now() + config.translateTimeoutMs;
  let last = null;
  let stableRounds = 0;

  while (Date.now() < deadline) {
    await sleep(500);
    const current = await readResult(page);
    if (!current || current === previous) continue; // vẫn còn kết quả của lượt trước

    if (current === last) {
      stableRounds += 1;
      // Đứng yên là chưa đủ — phải đủ số dòng nữa. Thiếu dòng thì cứ chờ tiếp,
      // trả về sớm là bên gọi phải chia đôi payload rồi dịch lại, vừa chậm vừa
      // mất ngữ cảnh của cả đoạn.
      const enough = expectLines === 0 || countNumbered(current) >= expectLines;
      if (stableRounds >= 2 && enough) {
        log.debug(`--- RESPONSE (đứng yên đủ ${expectLines} dòng, ${((Date.now() - t0) / 1000).toFixed(1)}s) ---\n${current}`);
        return current;
      }
      if (stableRounds >= 8) {
        log.warn(`chỉ thấy ${countNumbered(current)}/${expectLines} dòng nhưng đã đứng yên — trả về`);
        log.debug(`--- RESPONSE (ép trả về sau 8 vòng đứng yên) ---\n${current}`);
        return current;
      }
    } else {
      stableRounds = 0;
      last = current;
    }
  }

  if (last) {
    log.warn("bản dịch chưa kịp đứng yên trong thời gian chờ — dùng kết quả gần nhất");
    log.debug(`--- RESPONSE (hết thời gian chờ, lấy bản gần nhất) ---\n${last}`);
    return last;
  }
  throw new Error(
    "không đọc được bản dịch (có thể đang bị captcha — nhìn cửa sổ trình duyệt, " +
      "hoặc chạy `npm run probe-translate` nếu trang đổi cấu trúc)",
  );
}
