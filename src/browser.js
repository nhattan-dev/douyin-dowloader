import fs from "node:fs/promises";

import { chromium } from "playwright";

import { config, USER_AGENT } from "./config.js";
import { createLogger } from "./logger.js";

const log = createLogger("BROWSER");

/**
 * Mở Chromium với profile bền vững.
 *
 * Persistent profile là điểm mấu chốt chống bot detection: cookie/session giữ
 * nguyên giữa các lần chạy nên Douyin thấy một "người dùng quay lại" thay vì
 * một context sạch tinh mỗi lần. Cũng cho phép đăng nhập thủ công 1 lần khi bị
 * chặn — vì mặc định chạy headed nên nhìn thấy và xử lý được ngay.
 */
export async function openContext() {
  await fs.mkdir(config.browserProfileDir, { recursive: true });

  const context = await chromium.launchPersistentContext(config.browserProfileDir, {
    headless: config.headless,
    viewport: null,
    userAgent: USER_AGENT,
    locale: "zh-CN",
    args: [
      "--disable-blink-features=AutomationControlled",
      "--start-maximized",
      "--no-default-browser-check",
    ],
  });

  // Patch stealth tối thiểu — đủ để qua các check phổ biến nhất, không cần thư viện ngoài.
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    Object.defineProperty(navigator, "languages", { get: () => ["zh-CN", "zh", "en"] });
    if (!navigator.plugins?.length) {
      Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3, 4, 5] });
    }
  });

  log.info(`profile=${config.browserProfileDir} headless=${config.headless}`);
  if (config.headless) {
    log.warn("HEADLESS=true — Douyin dễ phát hiện hơn. Chỉ dùng khi đã chắc chắn không bị chặn.");
  }

  return context;
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Chặn cho tới khi người dùng bấm Enter ở terminal. */
export function waitForEnter(message) {
  return new Promise((resolve) => {
    process.stdout.write(`\n${message}\n`);
    process.stdin.resume();
    process.stdin.once("data", () => {
      process.stdin.pause();
      resolve();
    });
  });
}

/** Delay ngẫu nhiên giữa các action, tránh pattern quá đều/quá nhanh. */
export function randomDelay() {
  const { minDelayMs, maxDelayMs } = config;
  const ms = minDelayMs + Math.random() * Math.max(0, maxDelayMs - minDelayMs);
  return sleep(ms);
}
