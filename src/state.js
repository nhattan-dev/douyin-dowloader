import fs from "node:fs/promises";
import path from "node:path";

import { paths } from "./config.js";

// state.json là nguồn sự thật duy nhất cho "video nào đã xử lý tới đâu".
// Vừa là cơ chế dedupe ở bước collect, vừa là cơ chế resume cho fetch/stt.
//
// status:
//   collected   — đã biết video ID, chưa tải gì
//   fetched     — đã có audio.mp3 + meta.json
//   transcribed — đã có transcript.txt
//   translated  — đã có translation.json
//   failed      — bước gần nhất lỗi; chạy lại lệnh sẽ tự retry
//   foreign     — video của tác giả khác (lọt vào từ khu vực gợi ý); bỏ hẳn, không retry

export const STATUS = {
  COLLECTED: "collected",
  FETCHED: "fetched",
  TRANSCRIBED: "transcribed",
  TRANSLATED: "translated",
  FAILED: "failed",
  FOREIGN: "foreign",
};

export function emptyState(userId) {
  return { userId, lastCollectedAt: null, videos: {} };
}

export async function loadState(userId) {
  try {
    const raw = await fs.readFile(paths.stateFile(userId), "utf8");
    const parsed = JSON.parse(raw);
    return { ...emptyState(userId), ...parsed, videos: parsed.videos ?? {} };
  } catch (err) {
    if (err.code === "ENOENT") return emptyState(userId);
    throw err;
  }
}

// Bước fetch chạy nhiều video song song nên saveState có thể bị gọi chồng nhau. Hai
// lượt ghi cùng lúc là cùng ghi vào MỘT file .tmp rồi cùng rename → state.json rách.
// Nối đuôi mọi lượt ghi vào một chuỗi promise: chậm không đáng kể (ghi vài KB), mà
// không phải rải khoá ra khắp nơi gọi.
let saveQueue = Promise.resolve();

export function saveState(state) {
  saveQueue = saveQueue.then(
    () => writeState(state),
    () => writeState(state),
  );
  return saveQueue;
}

async function writeState(state) {
  const file = paths.stateFile(state.userId);
  await fs.mkdir(path.dirname(file), { recursive: true });
  // Ghi atomic: tmp rồi rename, để Ctrl-C giữa chừng không làm hỏng state.
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(state, null, 2), "utf8");
  await fs.rename(tmp, file);
}

export function markVideo(state, videoId, patch) {
  const prev = state.videos[videoId] ?? {};
  state.videos[videoId] = {
    ...prev,
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  return state.videos[videoId];
}

export function videosByStatus(state, statuses) {
  const wanted = new Set([].concat(statuses));
  return Object.entries(state.videos)
    .filter(([, v]) => wanted.has(v.status))
    .map(([id]) => id);
}

export function countByStatus(state) {
  const counts = {};
  for (const v of Object.values(state.videos)) {
    counts[v.status] = (counts[v.status] ?? 0) + 1;
  }
  return counts;
}
