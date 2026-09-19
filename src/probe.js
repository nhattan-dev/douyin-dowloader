import { randomDelay } from "./browser.js";
import { config, DOUYIN_ORIGIN } from "./config.js";
import { createLogger } from "./logger.js";

const log = createLogger("PROBE");

/**
 * Khảo sát DOM trang user để tìm container bọc danh sách tác phẩm.
 *
 * Trang user có cả tác phẩm của user lẫn khu vực gợi ý, và chỉ nhìn thẻ <a> thì
 * không phân biệt được. Lệnh này liệt kê mọi tổ tiên chung của các link video kèm
 * số link mà nó bọc — container đúng thường là cái bọc nhiều link nhất mà vẫn
 * không bọc hết cả trang. Kết quả dùng để chốt POST_LIST_SELECTORS trong collect.js.
 */
export async function probeUserPage(context, userId) {
  const page = await context.newPage();
  try {
    const url = `${DOUYIN_ORIGIN}/user/${userId}`;
    log.info(`mở ${url}`);
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
    log.info(`chờ danh sách hiện ra (tối đa ${config.pageReadyTimeoutMs / 1000}s)`);
    await page.waitForSelector("a[href*='/video/']", { timeout: config.pageReadyTimeoutMs });
    await randomDelay();

    const report = await page.evaluate(() => {
      const links = [...document.querySelectorAll("a[href*='/video/']")];

      const describe = (el) => {
        const e2e = el.getAttribute("data-e2e");
        if (e2e) return `[data-e2e="${e2e}"]`;
        if (el.id) return `#${el.id}`;
        const cls = (el.className || "")
          .toString()
          .split(/\s+/)
          .filter(Boolean)
          .slice(0, 2)
          .join(".");
        return cls ? `${el.tagName.toLowerCase()}.${cls}` : el.tagName.toLowerCase();
      };

      // Đếm mỗi tổ tiên bọc bao nhiêu link video.
      const counts = new Map();
      for (const link of links) {
        for (let el = link.parentElement, depth = 0; el && depth < 25; el = el.parentElement, depth += 1) {
          const key = describe(el);
          const entry = counts.get(key) ?? { selector: key, links: 0, depth };
          entry.links += 1;
          entry.depth = Math.min(entry.depth, depth);
          counts.set(key, entry);
        }
      }

      // Các tab/heading trên trang, giúp nhận ra đâu là "作品" đâu là gợi ý.
      const tabs = [...document.querySelectorAll("[data-e2e*='tab'], [role='tab']")]
        .map((el) => `${describe(el)} → "${el.textContent.trim().slice(0, 20)}"`)
        .slice(0, 15);

      return {
        totalLinks: links.length,
        candidates: [...counts.values()]
          .filter((c) => c.links >= 2 && c.links < links.length)
          .sort((a, b) => b.links - a.links)
          .slice(0, 25),
        e2eAttributes: [...new Set([...document.querySelectorAll("[data-e2e]")].map((el) => el.getAttribute("data-e2e")))].sort(),
        tabs,
        sampleLinkHtml: links[0]?.parentElement?.outerHTML.slice(0, 400) ?? null,
      };
    });

    console.log(`\nTổng link video trên trang: ${report.totalLinks}`);

    console.log(`\n── Container bọc nhiều link (ứng viên cho POST_LIST_SELECTORS) ──`);
    for (const c of report.candidates) {
      console.log(`  ${String(c.links).padStart(4)} link  depth=${c.depth}  ${c.selector}`);
    }

    console.log(`\n── Tab trên trang ──`);
    for (const t of report.tabs) console.log(`  ${t}`);

    console.log(`\n── Mọi data-e2e có trên trang ──`);
    console.log(`  ${report.e2eAttributes.join(", ")}`);

    console.log(`\n── HTML quanh link video đầu tiên ──`);
    console.log(report.sampleLinkHtml);

    console.log(
      `\nTìm container bọc ĐÚNG số tác phẩm của user (không phải ${report.totalLinks} = cả trang),` +
        `\nrồi đưa selector đó vào POST_LIST_SELECTORS ở src/collect.js.`,
    );

    return report;
  } finally {
    await page.close();
  }
}
