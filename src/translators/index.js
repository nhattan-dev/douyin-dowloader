/**
 * Registry provider dịch.
 *
 * Nạp động (dynamic import) để provider nào không dùng thì không phải nạp phụ thuộc
 * của nó — chọn google-web thì không cần OPENAI_API_KEY, và ngược lại.
 *
 * Provider phải export:
 *   name            — tên hiển thị
 *   needsBrowser    — có cần browser context của Playwright không
 *   translateText(text, { from, to, context }) → string
 *                     nhận nguyên payload, trả nguyên bản dịch. Việc đánh số và
 *                     tách lại theo segment do src/translate.js lo, provider chỉ
 *                     cần giữ nguyên xuống dòng.
 */

const MODULES = {
  "google-web": () => import("./google-web.js"),
  "google-free": () => import("./google-free.js"),
  openai: () => import("./openai.js"),
  deepseek: () => import("./deepseek.js"),
  qwen: () => import("./qwen.js"),
  "openai-2pass": () => import("./openai-2pass.js"),
  "google-2pass": () => import("./google-2pass.js"),
  "deepseek-2pass": () => import("./deepseek-2pass.js"),
};

export const PROVIDER_NAMES = Object.keys(MODULES);

export async function resolveProvider(name) {
  const load = MODULES[name];
  if (!load) {
    throw new Error(`provider "${name}" không tồn tại — chọn một trong: ${PROVIDER_NAMES.join(", ")}`);
  }
  return load();
}
