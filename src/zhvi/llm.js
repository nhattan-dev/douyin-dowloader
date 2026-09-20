import { createHash } from "node:crypto";

/**
 * Client mỏng cho các endpoint LLM Trung Quốc (DashScope workspace + DeepSeek).
 *
 * Cả hai đều nói đúng giao thức /chat/completions của OpenAI nên chỉ khác baseURL + key
 * + tên model. Dùng `fetch` sẵn có của Node thay vì SDK `openai`: lib này phải bê đi được
 * mà không kéo theo phụ thuộc của douyind, và thứ duy nhất cần là một POST JSON.
 *
 * Tên model mang luôn CHẾ ĐỘ, provider tự suy theo tên:
 *   deepseek-flash@none | @low | @high | @max   reasoning_effort (đặt ở CẤP GỐC request)
 *   deepseek-flash                               = @none — không để DeepSeek bật thinking ngầm
 *   qwen3.7-max@nothink | @think                 enable_thinking false | true
 *   qwen3.7-max                                  mặc định của DashScope (với 3.7-max là CÓ nghĩ)
 *
 * Ổn định (đo 2026-09-14, xem memory zhvi-deepseek-eval):
 *   - `max_tokens` của DeepSeek tính CẢ token suy nghĩ. Đặt thấp là nghĩ hết ngân sách rồi trả
 *     content RỖNG với finish=length. Nên có sàn: tắt nghĩ ≥16k, bật nghĩ ≥128k. Trần chỉ là
 *     giới hạn trên — không dùng tới thì không mất tiền.
 *   - Rỗng / finish=length -> nhân đôi trần, gọi lại. Rỗng lần thứ hai -> hạ effort về none.
 *   - jsonMode mà JSON hỏng -> gọi lại (v4-pro từng hỏng 1/7 lượt).
 *   - Timeout 900s: qwen3.7-max có lượt chạy 706s rồi mới trả.
 *
 * Provider thứ ba `queue`: đẩy lượt gọi thành task vào hàng đợi to-do LLM của fleex (Claude nhận
 * qua MCP), poll tới khi xong. Chỉ chữ, không ảnh; mỗi lượt 3-6 phút (đo 2026-09-17).
 *   queue@<model dự phòng>   vd. queue@qwen3.8-max, queue@deepseek-flash@low
 * Task hỏng / quá hạn / thiếu token -> gọi model dự phòng. JSON trả về không đọc được ->
 * deepseek-flash@none chép lại sang JSON (không làm lại bài). external_id = hash prompt nên chạy
 * lại tập thì nhận lại đúng kết quả cũ, không đẩy task mới. Bị SIGTERM (Dừng job) -> huỷ task đang chờ.
 */
const DEFAULT_TIMEOUT_MS = 900_000;
const QUEUE_URL = "https://task-queue-connector.nhattan-fleex.workers.dev";
const QUEUE_POLL_MS = 10_000;
const QUEUE_WAIT_MS = 45 * 60_000;
const QUEUE_END = ["done", "failed", "cancelled", "expired"];
const queuePending = new Map(); // id -> [base, token]

// USD / 1M token [vào, ra], giá peak công bố 2026-09 (Singapore). DeepSeek off-peak = ½ — không tự trừ.
export const PRICE = {
  "deepseek-flash": [0.30, 1.20],
  "deepseek-v4-pro": [1.32, 3.96],
  "qwen3.7-max": [2.5, 7.5],
  "qwen3.8-max": [2.5, 7.5], // chưa tra giá, tạm tính bằng 3.7-max
  "qwen3-max": [1.2, 6],
  "qwen-plus": [0.4, 1.2],
  "qwen-flash": [0.05, 0.4],
  "qwen-vl-max": [0.8, 3.2],
  "qwen3-vl-plus": [0.2, 1.6],
  "qwen-mt-plus": [2.46, 7.37],
};

/**
 * Chọn theo đo đạc, không theo cảm tính:
 *   render/critic/fix — C+D chạy trọn 4 tập + chấm mù 3 tập: không kém qwen3.7-max, rẻ ~5×.
 *     Tiền nằm ở bước fix, nên chỉ fix mới bật nghĩ (@low); render tắt nghĩ thì hay quá dài, fix vá.
 *   critic cùng nhà với render: đo 2×2, critic nào cũng chấm GẮT hơn với bản của nhà mình;
 *     luật "critic khác nhà" cũ đo trên qwen-max/qwen3-max, không lặp lại với cặp này.
 *   cast — qwen3-max rồi qwen3.7-max hết quota free (2026-09-17) -> qwen3.8-max, cùng họ, không đo lại.
 *   vision — qwen-vl-max hết quota free (403, 2026-09-14). deepseek-flash đo trên 90 câu có đáp án
 *     (B1, 768px): 65/90, hơn cả qwen-vl-max 61–62 và qwen3-vl-plus 61, lại rẻ nhất; 1536px không hơn.
 */
export const MODELS = {
  repair: "qwen-plus",
  cast: "qwen3.7-max-2026-06-08",
  render: "deepseek-flash@none",
  critic: "deepseek-flash@none",
  fix: "deepseek-flash@low",
  mt: "qwen-mt-plus",
  vision: "deepseek-flash",
};

// profile = lượt gộp dựng hồ sơ series (series init); không đặt thì đi theo cast (ZHVI_PROFILE=queue@... để chạy qua to-do LLM)
const ROLES = ["repair", "cast", "profile", "render", "critic", "fix", "mt", "vision"];

/** Đổi model không cần sửa code: ZHVI_FIX=deepseek-flash@high, ZHVI_RENDER=qwen3.7-max ... */
export function modelsFromEnv(env = process.env) {
  const m = { ...MODELS };
  for (const k of ROLES) {
    const v = env["ZHVI_" + k.toUpperCase()];
    if (v) m[k] = v;
  }
  m.profile ||= m.cast;
  return m;
}

/** "deepseek-flash@low" -> { model, mode, provider } */
export function parseModel(spec, fallbackProvider = "qwen") {
  const [model, mode = null] = String(spec).split("@");
  if (model === "queue") return { model, mode: null, provider: "queue", fallback: String(spec).slice(6) || null };
  return { model, mode, provider: model.startsWith("deepseek") ? "deepseek" : fallbackProvider };
}

// max_tokens: sàn theo chế độ, trần của API. Qwen: không biết chắc trần từng model -> dừng ở 32k.
const TOKENS = { deepseek: { floor: 16_000, thinkFloor: 128_000, max: 384_000 }, qwen: { floor: 0, thinkFloor: 0, max: 32_768 } };

export class Llm {
  /**
   * @param {object} o
   * @param {string} o.qwenBaseUrl  QWEN_BASE_URL (DashScope compatible-mode)
   * @param {string} o.qwenKey      DASHSCOPE_API_KEY
   * @param {string} o.deepseekKey  DEEPSEEK_API_KEY
   */
  constructor({ qwenBaseUrl, qwenKey, deepseekKey, queueUrl, queueToken, timeoutMs = DEFAULT_TIMEOUT_MS, log = null } = {}) {
    this.providers = {
      qwen: [String(qwenBaseUrl || "").replace(/\/+$/, ""), qwenKey || ""],
      deepseek: ["https://api.deepseek.com/v1", deepseekKey || ""],
      queue: [String(queueUrl || QUEUE_URL).replace(/\/+$/, ""), queueToken || ""],
    };
    this.timeoutMs = timeoutMs;
    this.log = log;
    this.usage = []; // {tag, model, in, out, think, sec, finish, ok}
    this.tag = "?";
  }

  /** Tổng kết theo công đoạn/model: [số lượt, token vào, token ra, giây, token nghĩ]. Lượt hỏng vẫn tính. */
  report() {
    const agg = {};
    for (const u of this.usage) {
      const k = `${u.tag}/${u.model}`;
      const a = (agg[k] ||= [0, 0, 0, 0, 0]);
      a[0] += 1;
      a[1] += u.in || 0;
      a[2] += u.out || 0;
      a[3] += u.sec;
      a[4] += u.think || 0;
    }
    for (const k of Object.keys(agg)) agg[k][3] = Math.round(agg[k][3] * 10) / 10;
    return agg;
  }

  /** Cùng key + cấu hình, sổ usage riêng — mỗi tập ghi usage.json của chính nó, không cộng dồn tập trước. */
  fork() {
    const f = new Llm({ timeoutMs: this.timeoutMs, log: this.log });
    f.providers = this.providers;
    return f;
  }

  totalTokens() {
    return this.usage.reduce((n, u) => n + (u.in || 0) + (u.out || 0), 0);
  }

  /** Tiền ước tính (USD, giá peak) theo bảng PRICE; model lạ tính 0. Lượt hỏng vẫn tính — nó vẫn bị trừ tiền. */
  cost() {
    return this.usage.reduce((n, u) => n + usd(u), 0);
  }

  async chat(spec, messages, {
    provider: providerHint = "qwen", temperature = 0.2, maxTokens = 8000,
    jsonMode = false, extra = null, retries = 4,
  } = {}) {
    const { model, mode, provider, fallback } = parseModel(spec, providerHint);
    if (provider === "queue") return this.queueChat(spec, fallback, messages, { providerHint, temperature, maxTokens, jsonMode, extra, retries });
    const [base, key] = this.providers[provider];
    if (!key) throw new Error(`thiếu API key cho provider ${provider}`);
    const lim = TOKENS[provider];

    let effort = provider === "deepseek" ? mode || "none" : null;
    const floor = () => (effort && effort !== "none" ? lim.thinkFloor : lim.floor);
    let budget = Math.min(Math.max(maxTokens, floor()), lim.max);
    let empties = 0;
    let last = "";
    let tries = 0;

    for (let i = 0; i < retries; i++) {
      tries = i + 1;
      const body = { model, messages, temperature, max_tokens: budget };
      if (jsonMode) body.response_format = { type: "json_object" };
      if (extra) Object.assign(body, extra);
      if (effort) body.reasoning_effort = effort;
      if (provider === "qwen" && mode === "nothink") body.enable_thinking = false;
      if (provider === "qwen" && mode === "think") body.enable_thinking = true;

      const t0 = Date.now();
      let wait = 2000 * (i + 1);
      try {
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), this.timeoutMs);
        let r;
        try {
          r = await fetch(base + "/chat/completions", {
            method: "POST",
            headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
            body: JSON.stringify(body),
            signal: ac.signal,
          });
        } finally {
          clearTimeout(timer);
        }
        if (!r.ok) {
          last = `${r.status} ${(await r.text()).slice(0, 300)}`;
          this.onCall?.({ tag: this.tag, model: spec, ok: false, status: r.status, error: last.slice(0, 160), usd: 0 });
          // Hết quota / sai key: gọi lại không bao giờ khá lên, chỉ tốn 4 lượt chờ. Gặp thật:
          // qwen-vl-max "Free quota exhausted" bị gọi lại 4 lượt cho TỪNG nhân vật.
          if (r.status === 401 || r.status === 403) break;
          if (r.status === 429) wait = 15000 * (i + 1);
        } else {
          const j = await r.json();
          const c = j.choices?.[0] || {};
          const u = j.usage || {};
          const sec = Math.round((Date.now() - t0) / 100) / 10;
          const text = c.message?.content || "";
          const rec = {
            tag: this.tag, model: spec, in: u.prompt_tokens, out: u.completion_tokens,
            think: u.completion_tokens_details?.reasoning_tokens || 0, sec, finish: c.finish_reason, ok: false,
          };
          this.usage.push(rec);

          if (!text || c.finish_reason === "length") {
            // hết ngân sách (thường là nghĩ hết): nới trần; hỏng lần hai thì thôi nghĩ
            empties += 1;
            last = `content ${text ? "bị cắt" : "rỗng"} (finish=${c.finish_reason}, nghĩ ${rec.think}/${budget})`;
            if (effort && effort !== "none" && empties >= 2) effort = "none";
            budget = Math.min(Math.max(budget * 2, floor()), lim.max);
            this.log?.warn?.(`${spec}: ${last} -> gọi lại, trần ${budget}${effort === "none" && mode && mode !== "none" ? ", hạ effort về none" : ""}`);
            this.onCall?.({ ...rec, error: last, usd: usd(rec) });
            wait = 0;
          } else if (jsonMode && !parses(text)) {
            last = `JSON hỏng: ${text.slice(0, 120)}`;
            this.log?.warn?.(`${spec}: ${last} -> gọi lại`);
            this.onCall?.({ ...rec, error: last, usd: usd(rec) });
            wait = 0;
          } else {
            rec.ok = true;
            this.onCall?.({ ...rec, usd: usd(rec) });
            return { text, in: u.prompt_tokens, out: u.completion_tokens, think: rec.think, sec, model: spec };
          }
        }
      } catch (ex) {
        last = String(ex?.name === "AbortError" ? `timeout ${this.timeoutMs / 1000}s` : ex?.message || ex);
      }
      if (wait) await new Promise((res) => setTimeout(res, wait));
    }
    throw new Error(`${spec} failed sau ${tries} lượt: ${last}`);
  }

  async queueChat(spec, fallback, messages, opts) {
    const [base, token] = this.providers.queue;
    const t0 = Date.now();
    const rec = { tag: this.tag, model: spec, in: 0, out: 0, think: 0, sec: 0, finish: null, ok: false };
    const fail = async (why) => {
      rec.sec = Math.round((Date.now() - t0) / 100) / 10;
      this.usage.push(rec);
      this.onCall?.({ ...rec, error: why, usd: 0 });
      if (!fallback) throw new Error(`${spec}: ${why}`);
      this.log?.warn?.(`${spec}: ${why} -> dùng ${fallback}`);
      return this.chat(fallback, messages, opts);
    };
    if (!token) return fail("thiếu TODO_TOKEN");
    if (messages.some((m) => typeof m.content !== "string")) return fail("hàng đợi không nhận ảnh");

    // Một lượt = một system + một user thì ghép thẳng; hội thoại nhiều lượt (gọi lại vì thiếu id) thì ghi rõ vai.
    const multi = messages.filter((m) => m.role !== "system").length > 1;
    const instructions = messages.map((m) => (multi ? `### ${m.role}\n` : "") + m.content).join("\n\n")
      + (multi ? "\n\n### Việc cần làm\nTrả lời lượt user cuối cùng." : "");
    if (instructions.length > 100_000) return fail(`prompt ${instructions.length} ký tự > 100k`);

    const H = { Authorization: "Bearer " + token, "Content-Type": "application/json" };
    const api = async (method, p, body) => {
      const r = await fetch(base + p, { method, headers: H, body: body && JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
      if (!r.ok) throw new Error(`${method} ${p} ${r.status} ${(await r.text()).slice(0, 200)}`);
      return r.json();
    };
    const hash = createHash("sha256").update(JSON.stringify([messages, opts.jsonMode])).digest("hex").slice(0, 24);

    let task = null;
    try {
      // Task cùng prompt từng hỏng thì external_id cũ trả lại đúng task hỏng đó -> thêm hậu tố.
      for (let n = 0; n < 3; n++) {
        task = await api("POST", "/api/tasks", {
          external_id: `zhvi-${hash}${n ? "-r" + n : ""}`,
          type: "zhvi",
          title: `zhvi ${this.tag}`,
          instructions,
          output_format: opts.jsonMode ? "Chỉ một object JSON đúng như hướng dẫn mô tả, không kèm chữ nào khác" : null,
          deadline: new Date(Date.now() + QUEUE_WAIT_MS).toISOString(),
          metadata: { tag: this.tag },
        });
        if (!["failed", "cancelled", "expired"].includes(task.status)) break;
      }
      queuePending.set(task.id, [base, token]);
      onceCancelOnExit();
      this.log?.info?.(`${spec}: task #${task.id} ${task.status === "done" ? "đã có kết quả" : "đang chờ Claude nhận"}`);
      let picked = Boolean(task.picked_at);
      while (!QUEUE_END.includes(task.status) && Date.now() - t0 < QUEUE_WAIT_MS) {
        await new Promise((res) => setTimeout(res, QUEUE_POLL_MS));
        try {
          task = await api("GET", `/api/tasks/${task.id}`);
        } catch (ex) {
          this.log?.warn?.(`${spec}: poll #${task.id} lỗi ${ex.message}`);
          continue;
        }
        if (task.picked_at && !picked) {
          picked = true;
          this.log?.info?.(`${spec}: task #${task.id} đã được nhận sau ${Math.round((Date.now() - t0) / 1000)}s`);
        }
      }
      if (!QUEUE_END.includes(task.status)) {
        await api("POST", `/api/tasks/${task.id}/cancel`).catch(() => {});
        return fail(`task #${task.id} chờ quá ${QUEUE_WAIT_MS / 60_000} phút`);
      }
    } catch (ex) {
      return fail(String(ex?.message || ex));
    } finally {
      if (task) queuePending.delete(task.id);
    }
    if (!task.acked_at) await api("POST", `/api/tasks/${task.id}/ack`).catch(() => {});
    if (task.status !== "done") return fail(`task #${task.id} ${task.status}${task.reason ? ": " + task.reason : ""}`);

    let text = typeof task.output === "string" ? task.output : JSON.stringify(task.output);
    if (opts.jsonMode && !parses(text)) {
      // Lâu lâu kết quả lệch định dạng: nhờ model rẻ CHÉP lại sang JSON, không cho làm lại bài.
      this.log?.warn?.(`${spec}: task #${task.id} trả JSON không đọc được -> deepseek-flash@none chép lại`);
      try {
        const r = await this.chat("deepseek-flash@none", [
          { role: "system", content: "Bạn là bộ chuyển định dạng. Chép dữ liệu trong BÀI TRẢ LỜI sang đúng định dạng JSON mà HƯỚNG DẪN mô tả. KHÔNG làm lại bài, KHÔNG thêm, bớt, sửa hay suy ra nội dung; thiếu thì bỏ trống. Chỉ xuất JSON." },
          { role: "user", content: `HƯỚNG DẪN:\n${instructions}\n\n==========\nBÀI TRẢ LỜI:\n${text}` },
        ], { jsonMode: true, maxTokens: 16_000, temperature: 0 });
        text = r.text;
      } catch (ex) {
        return fail(`task #${task.id} JSON hỏng, chép lại cũng hỏng: ${ex.message}`);
      }
    }
    rec.ok = true;
    rec.finish = "queue";
    rec.sec = Math.round((Date.now() - t0) / 100) / 10;
    this.usage.push(rec);
    this.onCall?.({ ...rec, usd: 0 });
    return { text, in: 0, out: 0, think: 0, sec: rec.sec, model: spec };
  }
}

/** Dừng job (UI gửi SIGTERM, 6s sau SIGKILL): huỷ task còn chờ để Claude khỏi làm việc thừa. */
let cancelHooked = false;
function onceCancelOnExit() {
  if (cancelHooked) return;
  cancelHooked = true;
  for (const [sig, code] of [["SIGTERM", 143], ["SIGINT", 130]]) {
    process.once(sig, async () => {
      await Promise.allSettled([...queuePending].map(([id, [base, token]]) => fetch(`${base}/api/tasks/${id}/cancel`, {
        method: "POST", headers: { Authorization: "Bearer " + token }, signal: AbortSignal.timeout(4000),
      })));
      process.exit(code);
    });
  }
}

/** Tiền một lượt gọi (USD, giá peak); model lạ tính 0. */
function usd(u) {
  const p = PRICE[parseModel(u.model).model] || [0, 0];
  return (p[0] * (u.in || 0) + p[1] * (u.out || 0)) / 1e6;
}

function parses(text) {
  try {
    jparse(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * Model đôi khi bọc JSON trong ```, đôi khi phun mấy khối JSON liền nhau.
 * Gộp tất cả các object đọc được thành một — port từ `llm.jparse`.
 */
export function jparse(s) {
  s = String(s ?? "").trim();
  if (s.startsWith("```")) {
    s = s.split("```")[1] ?? "";
    const nl = s.indexOf("\n");
    if (nl >= 0 && nl < 10) s = s.slice(nl);
    s = s.replace(/^json/i, "").trim();
  }
  const a = s.indexOf("{");
  if (a > 0) s = s.slice(a);

  const out = {};
  let i = 0;
  let found = false;
  while (i < s.length) {
    const [obj, end] = rawDecode(s, i);
    if (obj === undefined) break;
    if (obj && typeof obj === "object" && !Array.isArray(obj)) {
      Object.assign(out, obj);
      found = true;
    }
    i = end;
    while (i < s.length && " \n\r\t,".includes(s[i])) i++;
  }
  if (!found) throw new Error("no JSON object in: " + s.slice(0, 200));
  return out;
}

/** Bản JS của `json.JSONDecoder().raw_decode`: đọc MỘT giá trị JSON từ vị trí i. */
function rawDecode(s, i) {
  while (i < s.length && " \n\r\t".includes(s[i])) i++;
  if (i >= s.length || (s[i] !== "{" && s[i] !== "[")) return [undefined, i];
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let j = i; j < s.length; j++) {
    const c = s[j];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") {
      depth--;
      if (depth === 0) {
        try {
          return [JSON.parse(s.slice(i, j + 1)), j + 1];
        } catch {
          return [undefined, i];
        }
      }
    }
  }
  return [undefined, i];
}
