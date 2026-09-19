/**
 * Ánh xạ một đoạn con của nguồn về mốc thời gian thật.
 *
 * Ưu tiên `words` (mốc do ASR trả về cho từng từ). Chỉ nội suy tuyến tính trong
 * segment ở những chỗ words không phủ tới. Nội suy thuần gây ra lỗi đo được:
 * segment 0 của full_video kéo 7.0->11.0 nhưng chữ thật chỉ nằm ở 10.68->11.0,
 * làm 3.7s im lặng bị tính vào câu -> mật độ giả 12 chữ/giây và thời lượng âm.
 *
 * Cổng port từ `zhvi/timing.py`. Chỉ số ký tự dùng chỉ số chuỗi thuần (không phải code
 * point) để trùng khít với bản Python — chữ Hán đều nằm trong BMP nên hai cách bằng nhau.
 */
export class CharClock {
  constructor(segments, words = null) {
    this.text = segments.map((s) => s.text).join("");

    // ký tự thứ i thuộc segment nào — để truy ngược segmentIndexes
    this.segOf = [];
    segments.forEach((s, k) => {
      for (let i = 0; i < s.text.length; i++) this.segOf.push(k);
    });
    this.t = new Array(this.text.length).fill(null);

    // 1) rải mốc thật từ words lên đúng vị trí ký tự
    if (words) {
      let pos = 0;
      for (const w of words) {
        const tok = (w.word || "").trim();
        if (!tok) continue;
        let i = this.text.indexOf(tok, pos);
        if (i < 0) {
          i = this.text.indexOf(tok); // ASR đôi khi đảo thứ tự
          if (i < 0) continue;
        }
        const dur = Math.max(w.end - w.start, 1e-3);
        for (let k = 0; k < tok.length; k++) {
          this.t[i + k] = [w.start + (dur * k) / tok.length, w.start + (dur * (k + 1)) / tok.length];
        }
        pos = i + tok.length;
      }
    }

    // 2) chỗ trống (dấu câu, từ words bỏ sót) -> nội suy trong segment
    let off = 0;
    for (const s of segments) {
      const L = s.text.length;
      if (L) {
        const dur = Math.max(s.end - s.start, 1e-3);
        for (let k = 0; k < L; k++) {
          if (this.t[off + k] === null) {
            this.t[off + k] = [s.start + (dur * k) / L, s.start + (dur * (k + 1)) / L];
          }
        }
      }
      off += L;
    }

    // 3) đơn điệu hoá: mốc phải tăng dần, không thì sinh ra thời lượng âm
    let last = null;
    for (let i = 0; i < this.t.length; i++) {
      let [a, b] = this.t[i];
      if (last !== null && a < last) a = last;
      if (b < a) b = a;
      this.t[i] = [a, b];
      last = a;
    }
  }

  locate(needle, frm = 0) {
    let i = this.text.indexOf(needle, frm);
    if (i < 0) i = this.text.indexOf(needle);
    if (i < 0) return null;
    return [i, i + needle.length];
  }

  /** Các segment nguồn mà đoạn [a,b) chạm vào. */
  segmentsOf(a, b) {
    return [...new Set(this.segOf.slice(a, Math.min(b, this.segOf.length)))].sort((x, y) => x - y);
  }

  span(a, b) {
    b = Math.min(b, this.t.length);
    if (b <= a) return [null, null];
    const st = this.t[a][0];
    const en = Math.max(this.t[b - 1][1], st + 0.05);
    return [Math.round(st * 100) / 100, Math.round(en * 100) / 100];
  }
}
