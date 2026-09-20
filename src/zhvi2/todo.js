/**
 * Client của todo LLM (hàng đợi task của fleex; Claude Sonnet bản web nhận qua MCP).
 *
 * Khác `queueChat` của v1 ở ba chỗ, đều có chủ ý:
 *   - `output_format` là JSON SCHEMA, không phải một câu mô tả: server kiểm output theo schema
 *     trước khi nhận, nên lỗi "lâu lâu trả sai định dạng" chặn được ngay ở nguồn thay vì phải
 *     nhờ DeepSeek chép lại như v1.
 *   - Dữ liệu (kịch bản, bible) đi ô `context`, hướng dẫn đi ô `instructions`: context được hiện
 *     cho model như dữ liệu, không như mệnh lệnh.
 *   - KHÔNG có model dự phòng. Task hỏng/quá hạn thì ném lỗi rõ; chạy lại thì `external_id` (hash
 *     của cả task) trả về đúng task cũ, không đẩy trùng. Một đường chất lượng kém lặng lẽ thay
 *     vào là thứ không phân biệt được với kết quả thật.
 *
 * `ask()` lo vòng "kiểm → sai thì hỏi lại kèm lỗi": code chỉ kiểm, không tự sửa.
 */
import { createHash } from "node:crypto";

const URL0 = "https://task-queue-connector.nhattan-fleex.workers.dev";
const POLL_MS = 10_000;
const WAIT_MS = 60 * 60_000; // đo 2026-09-17: nhận sau ~13s, xong sau 3-6 phút; lượt dài nhất 343s
const END = ["done", "failed", "cancelled", "expired"];
const pending = new Map(); // id -> [base, token]

export class Todo {
  constructor({ url = URL0, token, log = null, waitMs = WAIT_MS } = {}) {
    if (!token) throw new Error("thiếu TODO_TOKEN");
    this.base = String(url || URL0).replace(/\/+$/, "");
    this.token = token;
    this.log = log;
    this.waitMs = waitMs;
    this.calls = []; // {tag, id, sec, ok}
  }

  async api(method, p, body) {
    const r = await fetch(this.base + p, {
      method,
      headers: { Authorization: "Bearer " + this.token, "Content-Type": "application/json" },
      body: body && JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    if (!r.ok) throw new Error(`${method} ${p} ${r.status} ${(await r.text()).slice(0, 300)}`);
    return r.json();
  }

  /** Một task, chờ tới khi xong. Trả `output` (JSON đã được server kiểm theo schema). */
  async run({ tag, title, instructions, context, schema, routine = "default" }) {
    if (instructions.length > 100_000) throw new Error(`${tag}: instructions ${instructions.length} ký tự > 100k`);
    const hash = createHash("sha256").update(JSON.stringify([instructions, context, schema, routine])).digest("hex").slice(0, 24);
    const t0 = Date.now();
    let task = null;
    // Task cùng nội dung từng hỏng thì external_id cũ trả lại đúng task hỏng đó -> thêm hậu tố.
    for (let n = 0; n < 3; n++) {
      task = await this.api("POST", "/api/tasks", {
        external_id: `zhvi2-${hash}${n ? "-r" + n : ""}`,
        type: "zhvi2",
        title: String(title || tag).slice(0, 300),
        instructions,
        context,
        output_format: schema,
        routine, // "default" = Sonnet 5, "lite" = Haiku 4.5 (GET /api/routines)
        deadline: new Date(Date.now() + this.waitMs).toISOString(),
        metadata: { tag },
      });
      if (!["failed", "cancelled", "expired"].includes(task.status)) break;
    }
    pending.set(task.id, [this.base, this.token]);
    hookCancel();
    this.log?.info?.(`  [todo] ${tag}@${routine}: task #${task.id} ${task.status === "done" ? "đã có kết quả" : "chờ Claude nhận"}`);
    try {
      let picked = Boolean(task.picked_at);
      while (!END.includes(task.status)) {
        if (Date.now() - t0 > this.waitMs) {
          await this.api("POST", `/api/tasks/${task.id}/cancel`).catch(() => {});
          throw new Error(`${tag}: task #${task.id} chờ quá ${this.waitMs / 60_000} phút — chạy lại để đẩy task mới`);
        }
        await new Promise((res) => setTimeout(res, POLL_MS));
        try {
          task = await this.api("GET", `/api/tasks/${task.id}`);
        } catch (ex) {
          this.log?.warn?.(`  [todo] ${tag}: poll #${task.id} lỗi ${ex.message}`);
          continue;
        }
        if (task.picked_at && !picked) {
          picked = true;
          this.log?.info?.(`  [todo] ${tag}: #${task.id} được nhận sau ${Math.round((Date.now() - t0) / 1000)}s`);
        }
      }
    } finally {
      pending.delete(task.id);
    }
    if (!task.acked_at) await this.api("POST", `/api/tasks/${task.id}/ack`).catch(() => {});
    const sec = Math.round((Date.now() - t0) / 1000);
    this.calls.push({ tag, id: task.id, sec, ok: task.status === "done" });
    if (task.status !== "done") {
      throw new Error(`${tag}: task #${task.id} ${task.status}${task.reason_code ? ` (${task.reason_code})` : ""}${task.reason ? ": " + task.reason : ""}`);
    }
    this.log?.info?.(`  [todo] ${tag}: #${task.id} xong sau ${sec}s`);
    return typeof task.output === "string" ? JSON.parse(task.output) : task.output;
  }

  /**
   * Hỏi, kiểm, sai thì hỏi lại kèm đúng lỗi — tối đa `rounds` lượt.
   * `check(out)` trả mảng lỗi (chuỗi); rỗng là đạt. Hết lượt mà vẫn lỗi thì trả kèm `errors`,
   * để nơi gọi quyết: bỏ đúng mục hỏng (và ghi lại) hay dừng hẳn.
   */
  async ask({ tag, title, instructions, context, schema, check, rounds = 3, routine = "default" }) {
    let out = await this.run({ tag, title, instructions, context, schema, routine });
    let errors = check(out);
    for (let r = 1; r < rounds && errors.length; r++) {
      this.log?.warn?.(`  [todo] ${tag}: ${errors.length} lỗi -> hỏi lại (lượt ${r + 1}/${rounds})`);
      for (const e of errors.slice(0, 8)) this.log?.warn?.(`      ${e}`);
      out = await this.run({
        tag, title: `${title || tag} (sửa lỗi ${r})`, schema, routine,
        instructions: instructions + "\n\n" + RETRY_NOTE,
        context: { ...asObj(context), previousAnswer: out, errors },
      });
      errors = check(out);
    }
    return { out, errors };
  }
}

const RETRY_NOTE = `## Lượt sửa lỗi
Context có thêm \`previousAnswer\` (câu trả lời lần trước của bạn) và \`errors\` (lỗi code kiểm ra).
Trả lại TOÀN BỘ câu trả lời theo đúng schema, đã sửa hết các lỗi trong \`errors\`. Phần không bị
báo lỗi thì giữ nguyên như \`previousAnswer\`.`;

const asObj = (c) => (c && typeof c === "object" && !Array.isArray(c) ? c : { input: c });

/** Dừng job (UI gửi SIGTERM): huỷ task còn chờ để Claude khỏi làm việc thừa. */
let hooked = false;
function hookCancel() {
  if (hooked) return;
  hooked = true;
  for (const [sig, code] of [["SIGTERM", 143], ["SIGINT", 130]]) {
    process.once(sig, async () => {
      await Promise.allSettled([...pending].map(([id, [base, token]]) => fetch(`${base}/api/tasks/${id}/cancel`, {
        method: "POST", headers: { Authorization: "Bearer " + token }, signal: AbortSignal.timeout(4000),
      })));
      process.exit(code);
    });
  }
}
