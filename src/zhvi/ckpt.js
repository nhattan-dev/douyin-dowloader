/**
 * Checkpoint theo CHỮ KÝ NỘI DUNG, không theo cờ dòng lệnh.
 *
 * Bản Python chỉ dùng lại kết quả khi người chạy tự nhớ gõ `--stage`, mà mặc định
 * `--stage all` thì trả tiền lại từ đầu. Ngược hẳn với douyind (`src/stt.js`: "Hỏi đĩa,
 * không hỏi state" — mặc định bỏ qua việc đã trả tiền, `--force` mới chạy lại). Ở đây
 * theo douyind: **đĩa là nguồn sự thật**, mặc định dùng lại.
 *
 * Nhưng "có file trên đĩa" chưa đủ để tin. Mỗi công đoạn khai báo đầu vào của nó; chữ ký
 * là sha256 của đúng những thứ đó. Đầu vào đổi -> chữ ký đổi -> tự chạy lại, và mọi công
 * đoạn phía sau cũng tự chạy lại vì đầu vào của CHÚNG (chính là kết quả công đoạn này)
 * vừa đổi. Không phải khai báo quan hệ phụ thuộc ở đâu cả.
 *
 * Đây không phải chuyện tối ưu. Đã có một lỗi đo được vì thiếu nó: cache kênh hình dùng
 * lại phán quyết theo id câu, pass A tách lại câu làm id trôi, và phán quyết của câu này
 * bị gán cho câu khác — sai lặng lẽ, không lỗi nào nổ ra.
 */
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

/** Chuỗi hoá ổn định: khoá được sắp xếp nên đổi thứ tự khoá không làm đổi chữ ký. */
export function stable(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return "[" + v.map(stable).join(",") + "]";
  return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + stable(v[k])).join(",") + "}";
}

export const sig = (...parts) => createHash("sha256").update(stable(parts)).digest("hex").slice(0, 16);

export class Ckpt {
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, "ckpt.json");
    this.data = {};
  }

  async load() {
    try {
      this.data = JSON.parse(await fs.readFile(this.file, "utf8"));
    } catch {
      this.data = {};
    }
    return this;
  }

  async save() {
    await fs.mkdir(this.dir, { recursive: true });
    await fs.writeFile(this.file, JSON.stringify(this.data, null, 1), "utf8");
  }

  /** Kết quả cũ còn dùng được không: chữ ký khớp VÀ file kết quả vẫn nằm đó. */
  async hit(id, signature) {
    const rec = this.data[id];
    if (!rec || rec.sig !== signature) return null;
    if (!rec.artifact) return rec;
    try {
      await fs.access(path.join(this.dir, rec.artifact));
    } catch {
      return null;
    }
    return rec;
  }

  async mark(id, signature, artifact, extra = {}) {
    this.data[id] = { sig: signature, artifact: artifact || null, at: new Date().toISOString(), ...extra };
    await this.save();
  }

  /** Quên một công đoạn (và do đó cả những công đoạn ăn theo nó). */
  async drop(ids) {
    for (const id of ids) delete this.data[id];
    await this.save();
  }
}

/** Đọc/ghi kết quả trong thư mục ra. Tách khỏi Ckpt để test khỏi phải chạm đĩa thật. */
export class Store {
  constructor(dir) {
    this.dir = dir;
  }

  async read(name) {
    return JSON.parse(await fs.readFile(path.join(this.dir, name), "utf8"));
  }

  async write(name, obj) {
    await fs.mkdir(this.dir, { recursive: true });
    const body = typeof obj === "string" ? obj : JSON.stringify(obj, null, 1);
    await fs.writeFile(path.join(this.dir, name), body, "utf8");
    return name;
  }

  async exists(name) {
    try {
      await fs.access(path.join(this.dir, name));
      return true;
    } catch {
      return false;
    }
  }
}
