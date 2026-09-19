import { randomDelay } from "./browser.js";
import { config } from "./config.js";
import { createLogger } from "./logger.js";

const log = createLogger("PROBE-TR");

/**
 * Khảo sát DOM translate.google.com để tìm khung chứa bản dịch.
 *
 * Class trên trang này là hash sinh tự động (`ryNqvb`, `HwtZe`…) và đổi theo mỗi
 * lần Google build lại, nên hardcode mù là hỏng ngầm. Lệnh này tìm phần tử nào
 * đang thực sự chứa bản dịch bằng cách dịch một câu mồi đã biết trước kết quả,
 * rồi truy ngược lên các tổ tiên của nó.
 *
 * Cùng cách đã dùng cho trang user Douyin — probe chỉ ra `user-post-list` và lộ
 * luôn chuyện footer nhiễm video của tác giả khác.
 */
export async function probeTranslatePage(context) {
  const page = await context.newPage();
  try {
    // Câu mồi nhiều dòng đánh số: kiểm tra luôn xem web UI có giữ xuống dòng và
    // số thứ tự không — thứ mà cả giao thức chia segment phụ thuộc vào.
    const probeText = "1. 你好\n2. 谢谢\n3. 再见";
    const url =
      `https://translate.google.com/?sl=${config.translateFrom}&tl=${config.translateTo}` +
      `&op=translate&text=${encodeURIComponent(probeText)}`;

    log.info(`mở ${url}`);
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
    log.info(`chờ bản dịch hiện ra (tối đa ${config.pageReadyTimeoutMs / 1000}s) — nếu gặp captcha thì xử lý trên cửa sổ`);

    // Chờ tới khi trang có chữ tiếng Việt của câu mồi.
    try {
      await page.waitForFunction(
        () => /Xin chào|xin chào|Cảm ơn|cảm ơn|Tạm biệt|tạm biệt/.test(document.body.innerText),
        { timeout: config.pageReadyTimeoutMs },
      );
    } catch {
      throw new Error(
        "không thấy bản dịch xuất hiện. Có thể bị captcha, hoặc trang đổi cấu trúc — " +
          "nhìn cửa sổ trình duyệt để biết.",
      );
    }
    await randomDelay();

    const report = await page.evaluate(() => {
      const NEEDLES = ["Xin chào", "xin chào", "Cảm ơn", "cảm ơn", "Tạm biệt", "tạm biệt"];
      const hits = (el) => NEEDLES.filter((n) => (el.textContent ?? "").includes(n)).length;

      const describe = (el) => {
        const parts = [el.tagName.toLowerCase()];
        for (const attr of ["jsname", "data-result-index", "aria-label", "role", "id"]) {
          const v = el.getAttribute?.(attr);
          if (v) parts.push(`[${attr}="${v}"]`);
        }
        const cls = (el.className || "").toString().split(/\s+/).filter(Boolean).slice(0, 3);
        if (cls.length) parts.push("." + cls.join("."));
        return parts.join("");
      };

      // Phần tử nhỏ nhất chứa đủ cả 3 câu dịch = khung kết quả.
      const all = [...document.querySelectorAll("*")];
      const containers = all
        .filter((el) => hits(el) >= 3)
        .map((el) => ({
          selector: describe(el),
          textLength: (el.textContent ?? "").length,
          text: (el.innerText ?? "").slice(0, 200),
          childCount: el.children.length,
        }))
        .sort((a, b) => a.textLength - b.textLength)
        .slice(0, 8);

      // Các phần tử lá, mỗi cái một câu — dùng khi muốn đọc theo từng dòng.
      const leaves = all
        .filter((el) => el.children.length === 0 && hits(el) >= 1)
        .map((el) => ({ selector: describe(el), text: el.textContent.trim().slice(0, 80) }))
        .slice(0, 12);

      const textareas = [...document.querySelectorAll("textarea")].map((el) => ({
        selector: describe(el),
        ariaLabel: el.getAttribute("aria-label"),
        value: el.value.slice(0, 60),
      }));

      return { containers, leaves, textareas, bodyText: document.body.innerText.slice(0, 400) };
    });

    console.log("\n── Khung nhỏ nhất chứa cả 3 câu dịch (ứng viên đọc kết quả) ──");
    for (const c of report.containers) {
      console.log(`\n  ${c.selector}`);
      console.log(`    ${c.textLength} ký tự, ${c.childCount} con`);
      console.log(`    innerText: ${JSON.stringify(c.text)}`);
    }

    console.log("\n── Phần tử lá chứa từng câu ──");
    for (const l of report.leaves) console.log(`  ${l.selector}  →  ${JSON.stringify(l.text)}`);

    console.log("\n── textarea (ô nhập) ──");
    for (const t of report.textareas) console.log(`  ${t.selector}  aria-label=${t.ariaLabel}  value=${JSON.stringify(t.value)}`);

    console.log("\n── Kiểm tra quan trọng ──");
    const kept = /1\..*\n?.*2\..*\n?.*3\./s.test(report.bodyText);
    console.log(`  Web UI có giữ đánh số 1./2./3. không: ${kept ? "CÓ" : "KHÔNG THẤY — xem body bên dưới"}`);
    console.log(`  body: ${JSON.stringify(report.bodyText.slice(0, 300))}`);

    console.log(
      "\nChọn selector của khung nhỏ nhất mà innerText có đủ 3 dòng, đưa vào RESULT_SELECTORS\n" +
        "ở src/translators/google-web.js.",
    );

    return report;
  } finally {
    await page.close();
  }
}
