/**
 * Hàng đợi việc cho UI: mỗi việc là một (hoặc vài) lệnh CLI có sẵn, chạy thành tiến trình con.
 *
 * Vì sao gọi CLI chứ không import lib vào server:
 * - CLI là thứ đã chạy thật và đã đo; UI chỉ là một cách bấm khác, không phải một đường code thứ hai.
 * - Tiến trình riêng thì Dừng được thật (giết cả nhóm: chromium, ffmpeg, demucs), lỗi của một
 *   việc không kéo sập server, và log y hệt khi chạy tay.
 *
 * Hai luật xếp lịch:
 * - LÀN: giới hạn số việc cùng loại chạy song song. `browser` = 1 vì chung một .browser-profile;
 *   `tts` = 1 vì VieNeu không chịu nổi song song (đã đo, xem memory vieneu) và demucs ngốn CPU.
 * - KHOÁ: hai việc đụng cùng tài nguyên không chạy cùng lúc. `user:<id>` (state.json bị ghi đè
 *   nếu hai tiến trình cùng ghi), `series:<slug>` chặn mọi `series:<slug>:epN` (đổi bible giữa
 *   lúc đang dịch là dịch bằng bible nào?).
 *
 * Tiến độ đọc từ hai nguồn: dòng "@@zhvi {json}" (zhvi --events, có cấu trúc) và vài mẫu log
 * quen thuộc của collect/fetch/voice/dub (đoán, chỉ để hiện %).
 */
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

export const LANES = { browser: 1, stt: 2, zhvi: 2, tts: 1, ffmpeg: 1 };
const ACTIVE = new Set(["queued", "running"]);
const now = () => new Date().toISOString();
const conflicts = (a, b) => a === b || a.startsWith(b + ":") || b.startsWith(a + ":");
const q = (s) => (/[\s"'$]/.test(s) ? JSON.stringify(s) : s);
const COUNTER = /^\s*(\d+)\/(\d+)\s*$/;

export class Jobs extends EventEmitter {
  constructor({ root, dir, recipes, keep = 300 }) {
    super();
    this.root = root;
    this.dir = dir;
    this.recipes = recipes;
    this.keep = keep;
    this.list = [];
    this.byId = new Map();
    this.procs = new Map();
    this.file = path.join(dir, "jobs.json");
    this.logDir = path.join(dir, "logs");
    this.seq = 0;
    this.saveTimer = null;
    this.emitTimers = new Map();
  }

  async load() {
    await fsp.mkdir(this.logDir, { recursive: true });
    let saved = [];
    try {
      saved = JSON.parse(await fsp.readFile(this.file, "utf8"));
    } catch { /* lần đầu */ }
    for (const j of saved) {
      if (j.status === "running") {
        // tiến trình con đã chết theo server; checkpoint của zhvi/dub giữ nguyên nên chạy lại là đi tiếp
        j.status = "interrupted";
        j.error = "UI bị tắt khi việc đang chạy — bấm Chạy lại, phần đã trả tiền được dùng lại";
        j.endedAt ||= now();
      }
      this.list.push(j);
      this.byId.set(j.id, j);
    }
    this.schedule();
    return this;
  }

  summary(j) {
    const { tail, errLines, ...rest } = j;
    return rest;
  }

  active(pred = () => true) {
    return this.list.filter((j) => ACTIVE.has(j.status) && pred(j));
  }

  async enqueue(type, params = {}, { parent = null } = {}) {
    const recipe = this.recipes[type];
    if (!recipe) throw new Error(`không có loại việc "${type}"`);
    const key = `${type}:${JSON.stringify(params)}`;
    const dup = this.list.find((j) => j.key === key && ACTIVE.has(j.status));
    if (dup) return dup;
    const head = await recipe.plan(params);
    const id = `${Date.now().toString(36)}${(++this.seq).toString(36)}`;
    const job = {
      id, key, type, params,
      title: head.title, lane: head.lane, locks: head.locks || [], meta: head.meta || {},
      status: "queued", createdAt: now(), progress: {}, usd: 0, parent,
      tail: [], errLines: [],
    };
    this.list.push(job);
    this.byId.set(id, job);
    this.trim();
    this.changed(job, true);
    this.schedule();
    return job;
  }

  schedule() {
    const claimed = []; // khoá của việc xếp hàng TRƯỚC mà chưa chạy được — giữ đúng thứ tự vào trước ra trước
    for (const j of this.list) {
      if (j.status !== "queued") continue;
      const running = this.list.filter((x) => x.status === "running");
      const laneFull = running.filter((x) => x.lane === j.lane).length >= (LANES[j.lane] ?? 1);
      const locked = [...running.flatMap((x) => x.locks), ...claimed].some((a) => j.locks.some((b) => conflicts(a, b)));
      if (laneFull || locked) {
        claimed.push(...j.locks);
        continue;
      }
      this.start(j);
    }
  }

  async start(job) {
    job.status = "running";
    job.startedAt = now();
    job.error = null;
    job.stopRequested = false;
    this.changed(job, true);
    try {
      const steps = await this.recipes[job.type].steps(job.params, job);
      job.steps = steps.map((s) => ({ label: s.label, optional: Boolean(s.optional), status: "pending" }));
      this.changed(job, true);
      for (let i = 0; i < steps.length && !job.stopRequested; i++) {
        job.stepIndex = i;
        job.steps[i].status = "running";
        job.progress = { ...job.progress, stepPct: null, label: steps[i].label, detail: null };
        this.pct(job);
        this.changed(job, true);
        const code = await this.exec(job, steps[i]);
        job.steps[i].status = code === 0 ? "done" : "failed";
        if (job.stopRequested) break;
        if (code !== 0 && !steps[i].optional) {
          throw new Error(job.errLines.slice(-3).join(" · ") || `${steps[i].label}: thoát mã ${code}`);
        }
      }
      job.status = job.stopRequested ? "stopped" : "done";
    } catch (ex) {
      job.status = "failed";
      job.error = String(ex?.message || ex).slice(0, 1000);
    }
    job.endedAt = now();
    // dừng ở cổng soát là "xong việc" nhưng tập mới đi nửa đường — giữ % thật, đừng báo 100%
    if (job.status === "done" && !job.progress.zhvi?.done?.stoppedAfter) job.progress.pct = 1;
    this.changed(job, true);
    if (job.status === "done") {
      try {
        const next = await this.recipes[job.type].next?.(job.params, job);
        if (next) {
          const n = await this.enqueue(next.type, next.params, { parent: job.id });
          job.nextJob = n.id;
          this.changed(job, true);
        }
      } catch (ex) {
        job.error = `xong, nhưng không xếp được việc tiếp theo: ${ex.message}`;
        this.changed(job, true);
      }
    }
    this.emit("finished", job);
    this.schedule();
  }

  exec(job, step) {
    if (step.run) {
      return step.run(job).then(() => 0, (ex) => {
        this.onLine(job, String(ex?.message || ex), "err");
        return 1;
      });
    }
    return new Promise((resolve) => {
      let settled = false;
      const finish = (code) => {
        if (settled) return;
        settled = true;
        this.procs.delete(job.id);
        log.end();
        resolve(code);
      };
      const log = fs.createWriteStream(path.join(this.logDir, `${job.id}.log`), { flags: "a" });
      const cmdline = `$ ${step.argv.map(q).join(" ")}`;
      log.write(`\n${cmdline}\n`);
      this.onLine(job, cmdline, "cmd");
      let child;
      try {
        child = spawn(step.argv[0], step.argv.slice(1), {
          cwd: this.root,
          env: { ...process.env, FORCE_COLOR: "0", ...(step.env || {}) },
          detached: true, // cả nhóm tiến trình -> Dừng giết được chromium/ffmpeg/demucs con
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch (ex) {
        this.onLine(job, `không chạy được ${step.argv[0]}: ${ex.message}`, "err");
        return finish(127);
      }
      this.procs.set(job.id, child);
      const feed = (stream, kind) => {
        let buf = "";
        stream.setEncoding("utf8");
        stream.on("data", (s) => {
          log.write(s);
          buf += s;
          const parts = buf.split(/\r\n|\n|\r/);
          buf = parts.pop();
          for (const p of parts) this.onLine(job, p, kind);
          // dòng đếm "\r 12/80" không có xuống dòng: đọc tiến độ ngay, khỏi chờ dòng sau
          if (COUNTER.test(buf)) this.progressFrom(job, buf);
        });
        stream.on("end", () => {
          if (buf) this.onLine(job, buf, kind);
        });
      };
      feed(child.stdout, "out");
      feed(child.stderr, "err");
      child.on("error", (ex) => {
        this.onLine(job, `không chạy được ${step.argv[0]}: ${ex.message}`, "err");
        finish(127);
      });
      child.on("close", (code, signal) => finish(code ?? (signal ? 143 : 1)));
    });
  }

  onLine(job, text, kind) {
    if (text.startsWith("@@zhvi ")) {
      try {
        this.zhvi(job, JSON.parse(text.slice(7)));
      } catch { /* dòng hỏng thì thôi */ }
      return;
    }
    if (!text.trim()) return;
    this.progressFrom(job, text);
    const last = job.tail.at(-1);
    const line = { t: text, k: kind };
    if (COUNTER.test(text) && last && COUNTER.test(last.t)) last.t = text;
    else job.tail.push(line);
    if (job.tail.length > 400) job.tail.splice(0, job.tail.length - 400);
    // stderr lẫn cả cảnh báo ([WARN], [!]) — chỉ giữ dòng giống lỗi thật để làm thông báo lỗi
    if (kind === "err" && !/\[WARN\]|\[!\]|ExperimentalWarning|--trace-warnings/.test(text)) {
      job.errLines.push(text.trim().slice(0, 300));
      if (job.errLines.length > 20) job.errLines.shift();
    } else if (/\[ERROR\]|\[X\]|^Lỗi:/.test(text)) {
      job.errLines.push(text.trim().slice(0, 300));
    }
    this.emit("log", job.id, line);
    this.changed(job);
  }

  /** Tiến độ đoán từ log quen thuộc của các script không phải zhvi. */
  progressFrom(job, text) {
    const p = job.progress;
    let m;
    if ((m = text.match(COUNTER))) {
      p.stepPct = Number(m[1]) / Math.max(1, Number(m[2]));
      p.detail = `tổng hợp ${m[1]}/${m[2]} câu`;
    } else if ((m = text.match(/^\[(\d)\/4\]\s*(.*)/))) {
      p.stepPct = (Number(m[1]) - 1) / 4;
      p.detail = m[2];
    } else if ((m = text.match(/vòng (\d+): (\d+)(?:\/(\d+))? video ID/))) {
      p.stepPct = m[3] ? Number(m[2]) / Number(m[3]) : null;
      p.detail = `đã thấy ${m[2]}${m[3] ? `/${m[3]}` : ""} video`;
    } else if ((m = text.match(/\[(\d+)\/(\d+)\] (\d+): (OK|bỏ qua)/))) {
      p.fetched = (p.fetched || 0) + 1;
      p.stepPct = p.fetched / Number(m[2]);
      p.detail = `đã tải ${p.fetched}/${m[2]} video`;
    } else if (/tách nền nhạc/.test(text)) {
      p.detail = "tách nền nhạc khỏi audio gốc (demucs, chậm)";
    } else if ((m = text.match(/^→ (.+dub-vi\.mp4)$/))) {
      p.output = m[1];
    } else if (/Đăng nhập Douyin trên cửa sổ/.test(text)) {
      p.waitingInput = true;
      p.detail = "chờ bạn đăng nhập trên cửa sổ trình duyệt";
    } else return;
    this.pct(job);
  }

  zhvi(job, e) {
    const z = (job.progress.zhvi ||= { usd: 0, calls: 0, subs: {}, plan: null, eps: {} });
    const scopeOf = (ep) => (z.kind === "series" && ep !== null && ep !== undefined
      ? (z.eps[String(ep)] ||= { usd: 0, calls: 0, subs: {}, plan: null })
      : z);
    switch (e.t) {
      case "plan":
        if (e.kind === "series") {
          z.kind = "series";
          z.episodes = e.episodes;
          z.steps = e.steps.map((s) => ({ ...s, status: "pending" }));
        } else {
          const s = scopeOf(e.ep);
          s.plan = e.subs;
          s.subs = {};
          s.ep = e.ep;
        }
        break;
      case "sub": {
        const s = scopeOf(e.ep);
        const cur = (s.subs[e.id] ||= { calls: 0, usd: 0 });
        cur.status = e.status;
        if (e.ms !== undefined) cur.ms = e.ms;
        if (e.info !== undefined) cur.info = e.info;
        if (e.error) cur.error = e.error;
        if (e.forced) cur.forced = true;
        if (e.status === "start") s.current = e.id;
        if (e.status === "error") job.progress.detail = `${e.id} lỗi: ${e.error}`;
        break;
      }
      case "call": {
        const s = scopeOf(e.ep);
        const usd = Number(e.usd) || 0;
        s.calls += 1;
        s.usd += usd;
        if (s !== z) {
          z.calls += 1;
          z.usd += usd;
        }
        const tgt = s.current && s.subs[s.current];
        if (tgt && tgt.status === "start") {
          tgt.calls += 1;
          tgt.usd += usd;
        } else if (z.kind === "series" && z.currentStep) {
          const st = z.steps.find((x) => x.id === z.currentStep);
          if (st) {
            st.calls = (st.calls || 0) + 1;
            st.usd = (st.usd || 0) + usd;
          }
        }
        if (!e.ok) s.lastCallError = e.error;
        job.usd = z.usd;
        break;
      }
      case "step": {
        const st = z.steps?.find((x) => x.id === e.id);
        if (st) {
          st.status = e.status === "start" || e.status === "progress" ? "running" : e.status;
          if (e.done !== undefined) Object.assign(st, { done: e.done, total: e.total });
          if (e.failed) st.failed = e.failed;
          if (e.status === "start") z.currentStep = e.id;
        }
        break;
      }
      case "gate":
        scopeOf(e.ep).gate = { need: e.need, stopped: e.stopped, why: e.why, suspects: e.suspects, noBible: e.noBible };
        break;
      case "review":
        scopeOf(e.ep).review = e.page;
        break;
      case "done":
        scopeOf(e.ep).done = { stoppedAfter: e.stoppedAfter, cost: e.cost };
        break;
      case "draft":
        z.draft = { page: e.page, cost: e.cost };
        break;
      default:
    }
    this.pct(job);
    this.changed(job);
  }

  pct(job) {
    const p = job.progress;
    const z = p.zhvi;
    const finished = (sc, stages = null) => {
      const plan = (sc.plan || []).filter((x) => !stages || stages.includes(x.stage));
      if (!plan.length) return 0;
      return plan.filter((x) => ["ran", "reused", "skipped", "error"].includes(sc.subs[x.id]?.status)).length / plan.length;
    };
    let stepPct = p.stepPct;
    if (z?.kind === "series" && z.steps?.length) {
      let sum = 0;
      for (const st of z.steps) {
        if (["done", "reused", "warn"].includes(st.status)) sum += 1;
        else if (st.status === "running") {
          if (st.id.startsWith("ep")) sum += finished(z.eps[st.id.slice(2)] || {}, ["A", "B"]);
          else if (st.total) sum += st.done / st.total;
        }
      }
      stepPct = sum / z.steps.length;
      const cur = z.steps.find((x) => x.status === "running");
      if (cur) p.detail = cur.total ? `${cur.title} (${cur.done}/${cur.total})` : cur.title;
    } else if (z?.plan) {
      stepPct = finished(z);
      const cur = z.current && z.plan.find((x) => x.id === z.current);
      if (cur && z.subs[cur.id]?.status === "start") p.detail = `${cur.id} ${cur.title}`;
      if (z.done?.stoppedAfter) p.detail = z.gate?.stopped ? "dừng ở cổng soát người nói" : `dừng sau pass ${z.done.stoppedAfter}`;
    }
    const n = job.steps?.length || 1;
    const i = job.stepIndex || 0;
    p.pct = Math.max(0, Math.min(1, (i + (stepPct ?? 0)) / n));
  }

  stop(id) {
    const j = this.byId.get(id);
    if (!j) return null;
    if (j.status === "queued") {
      j.status = "stopped";
      j.endedAt = now();
      this.changed(j, true);
      this.schedule();
      return j;
    }
    if (j.status !== "running") return j;
    j.stopRequested = true;
    const c = this.procs.get(id);
    if (c) {
      try {
        process.kill(-c.pid, "SIGTERM");
      } catch { /* đã chết */ }
      setTimeout(() => {
        if (this.procs.get(id) === c) {
          try {
            process.kill(-c.pid, "SIGKILL");
          } catch { /* đã chết */ }
        }
      }, 6000);
    }
    this.changed(j, true);
    return j;
  }

  retry(id) {
    const j = this.byId.get(id);
    if (!j) throw new Error("không có việc này");
    return this.enqueue(j.type, j.params, { parent: j.id });
  }

  input(id, text) {
    const c = this.procs.get(id);
    if (!c) throw new Error("việc không còn chạy");
    c.stdin.write(text);
    const j = this.byId.get(id);
    if (j) {
      j.progress.waitingInput = false;
      j.progress.detail = "đã gửi xác nhận";
      this.changed(j, true);
    }
  }

  async logText(id, maxBytes = 400_000) {
    const file = path.join(this.logDir, `${id}.log`);
    try {
      const { size } = await fsp.stat(file);
      const fh = await fsp.open(file, "r");
      const len = Math.min(size, maxBytes);
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, size - len);
      await fh.close();
      return buf.toString("utf8");
    } catch {
      return "";
    }
  }

  trim() {
    const done = this.list.filter((j) => !ACTIVE.has(j.status));
    const extra = done.length - this.keep;
    if (extra <= 0) return;
    const drop = new Set(done.slice(0, extra).map((j) => j.id));
    this.list = this.list.filter((j) => !drop.has(j.id));
    for (const id of drop) {
      this.byId.delete(id);
      fsp.rm(path.join(this.logDir, `${id}.log`), { force: true }).catch(() => {});
    }
  }

  /** Báo đổi: trạng thái đổi thì phát ngay; tiến độ/log thì gộp nhịp 300ms cho đỡ dội. */
  changed(job, now_ = false) {
    const fire = () => {
      this.emitTimers.delete(job.id);
      this.emit("job", this.summary(job));
    };
    if (now_) {
      clearTimeout(this.emitTimers.get(job.id));
      fire();
    } else if (!this.emitTimers.has(job.id)) {
      this.emitTimers.set(job.id, setTimeout(fire, 300));
    }
    if (!this.saveTimer) {
      this.saveTimer = setTimeout(() => {
        this.saveTimer = null;
        const body = this.list.map((j) => ({ ...j, tail: j.tail.slice(-60), errLines: j.errLines.slice(-5) }));
        fsp.writeFile(this.file + ".tmp", JSON.stringify(body))
          .then(() => fsp.rename(this.file + ".tmp", this.file))
          .catch(() => {});
      }, 1000);
    }
  }
}
