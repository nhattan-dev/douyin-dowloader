/**
 * BẢNG STAGE/SUBSTAGE — xương sống của lib.
 *
 * Mỗi công đoạn con tự khai bốn thứ, và chỉ bốn thứ đó:
 *   cost      "free" = thuần code, "llm"/"vlm" = tốn tiền
 *   artifact  file nó sở hữu (chỉ công đoạn tốn tiền mới cần)
 *   sig(ctx)  ĐẦU VÀO quyết định kết quả -> chữ ký nội dung
 *   run(ctx)  làm việc
 *
 * Luật số 1: **công đoạn miễn phí KHÔNG BAO GIỜ checkpoint.** Dựng lại mỗi lần chạy, nên
 * sửa bible hay sửa nhãn người soát xong chạy lại là thấy ngay, không phải nhớ xoá cache.
 *
 * Luật số 2: **không khai báo quan hệ phụ thuộc.** Đầu vào của một công đoạn chính là kết
 * quả của công đoạn trước; đầu vào đổi thì chữ ký đổi thì nó tự chạy lại, và mọi công đoạn
 * sau nó cũng thế. Dây chuyền tự đổ, không cần bảng phụ thuộc nào để quên cập nhật.
 */
import * as A from "./passes/a-repair.js";
import * as B from "./passes/b-speakers.js";
import * as C from "./passes/c-render.js";
import * as D from "./passes/d-verify.js";
import * as E from "./passes/e-export.js";
import { applyOps } from "./ops.js";
import * as V from "./vision.js";

/** Chữ ký của một câu thoại: đúng những trường mà công đoạn sau thật sự đọc. */
const uttSig = (utts) => utts.map((u) => [u.id, u.speaker, u.zh, u.start, u.end]);

/**
 * Câu nào phải dịch lại ở vòng này, và vì lỗi gì. Thuần hàm, gọi được nhiều lần:
 * `sig` và `run` cùng gọi nó, nên chữ ký không phụ thuộc thứ tự chạy.
 */
function fixTargets(c) {
  const hard = D.check(c.utts, c.vi, c.ent, { cps: c.cps });
  const low = Object.entries(c.scores || {}).filter(([, v]) => (v.score ?? 5) <= 3).map(([k]) => Number(k));
  const ids = [...new Set([...Object.keys(hard).map(Number), ...low])].sort((a, b) => a - b);
  const notes = Object.fromEntries(ids.map((i) => [
    i, (hard[i] || []).join("; ") + " | " + (c.scores?.[i]?.issue ?? ""),
  ]));
  return { ids, notes };
}

export const STAGES = [
  {
    id: "A",
    name: "repair",
    title: "sửa ASR (zh → zh)",
    subs: [
      {
        id: "A1",
        name: "clusters",
        title: "nhãn cụm giọng từ qwenSpeakerId",
        cost: "free",
        run(ctx) {
          ctx.segments = A.clusterLabels(ctx.transcript.segments);
          ctx.chunkSize = A.planOpsChunks(ctx.segments);
          const n = new Set(ctx.segments.map((s) => s.speaker)).size;
          return { segments: ctx.segments.length, clusters: n, chunkSize: ctx.chunkSize };
        },
      },
      {
        id: "A2",
        name: "ops",
        title: "model khai danh sách sửa",
        cost: "llm",
        artifact: "a2-ops.json",
        sig: (ctx) => [ctx.segments.map((s) => [s.text, s.speaker]), ctx.chunkSize, ctx.models.repair],
        async run(ctx) {
          ctx.llm.tag = "A-repair";
          const out = [];
          for (const grp of A.chunk(ctx.segments, ctx.chunkSize)) {
            out.push(await A.opsCall(ctx.llm, grp, { model: ctx.models.repair }));
          }
          return out;
        },
        after: (ctx, v) => { ctx.opsA2 = v; },
      },
      {
        id: "A3",
        name: "scan",
        title: "quét phiên âm, model phán đúng/sai",
        cost: "llm",
        artifact: "a3-scan.json",
        when: (ctx) => ctx.vocab.length > 0,
        sig: (ctx) => [ctx.segments.map((s) => s.text), ctx.opsA2, [...ctx.vocab].sort(), ctx.models.repair],
        async run(ctx) {
          ctx.llm.tag = "A-repair";
          const groups = A.chunk(ctx.segments, ctx.chunkSize);
          const out = [];
          for (let i = 0; i < groups.length; i++) {
            // quét trên văn bản SAU vòng 1 — vòng 2 chỉ đi nhặt chỗ vòng 1 bỏ sót
            const { units } = applyOps(groups[i], ctx.opsA2[i] || []);
            out.push(await A.scanCall(ctx.llm, units, ctx.vocab, { model: ctx.models.repair }));
          }
          return out;
        },
        after: (ctx, v) => { ctx.opsA3 = v; },
      },
      {
        id: "A4",
        name: "apply",
        title: "áp thao tác + gắn lại mốc thời gian",
        cost: "free",
        run(ctx) {
          const merged = ctx.opsA2.map((o, i) => [...(o || []), ...((ctx.opsA3 || [])[i] || [])]);
          const { utts, dropped } = A.applyAll(ctx.segments, merged, ctx.chunkSize, ctx.transcript.words);
          ctx.utts = utts;
          ctx.dropped = dropped;
          return { utts: utts.length, edits: utts.reduce((n, u) => n + u.edits.length, 0), dropped: dropped.length };
        },
        emit: (ctx) => ({ "utts.json": ctx.utts }),
      },
    ],
  },

  {
    id: "B",
    name: "speakers",
    title: "gán người nói",
    subs: [
      {
        id: "B1",
        name: "vision",
        title: "khẩu hình đặt tên cụm",
        cost: "vlm",
        artifact: "vision.json",
        when: (ctx) => Boolean(ctx.video && ctx.bible && !ctx.opts.noVision),
        sig: (ctx) => [
          uttSig(ctx.utts),
          ctx.bible.cast.map((c) => [c.zh, c.vi, c.look || c.note || ""]),
          ctx.video, ctx.opts.vision, ctx.models.vision,
        ],
        // Chữ ký khớp vẫn CHƯA đủ tin: mốc thời gian của từng câu đã hỏi phải trùng.
        // Đây là chỗ đã hỏng thật một lần — id trôi sau khi pass A tách lại câu.
        load: (ctx, raw) => V.revalidate(raw, ctx.utts, ctx.bible, ctx.log),
        run: (ctx) => V.nameClusters(ctx.llm, ctx.utts, ctx.video, ctx.bible, {
          ...ctx.opts.vision, model: ctx.models.vision, log: ctx.log,
        }),
        after: (ctx, v) => { ctx.vision = v; },
      },
      {
        id: "B2",
        name: "align",
        title: "model đọc kịch bản, phải trích dẫn được",
        cost: "llm",
        artifact: "b2-align.json",
        when: (ctx) => Boolean(ctx.bible),
        sig: (ctx) => [uttSig(ctx.utts), ctx.bible.version, ctx.epTitle, ctx.models.cast],
        run: (ctx) => B.alignCast(ctx.llm, ctx.utts, ctx.bible, {
          model: ctx.models.cast, epTitle: ctx.epTitle,
        }),
        after: (ctx, v) => { ctx.alignRaw = v; },
      },
      {
        id: "B2b",
        name: "cast",
        title: "tự suy hồ sơ (khi không có bible)",
        cost: "llm",
        artifact: "sheet.json",
        when: (ctx) => !ctx.bible,
        sig: (ctx) => [uttSig(ctx.utts), ctx.pinned, ctx.models.cast],
        run: (ctx) => B.castSheet(ctx.llm, ctx.utts, ctx.glossary, {
          model: ctx.models.cast, pinned: ctx.pinned,
        }),
        after: (ctx, v) => { ctx.sheet = v; },
      },
      {
        id: "B3",
        name: "vocative",
        title: "regex: ai BỊ GỌI tên",
        cost: "free",
        when: (ctx) => Boolean(ctx.bible),
        run(ctx) {
          ctx.vocatives = B.vocativeEvidence(ctx.utts, ctx.bible);
          return { evidence: ctx.vocatives.length };
        },
      },
      {
        id: "B4",
        name: "arbitrate",
        title: "trọng tài ba nguồn -> 4 mức",
        cost: "free",
        when: (ctx) => Boolean(ctx.bible),
        run(ctx) {
          ctx.align = B.verifyAlign({ ...ctx.alignRaw }, ctx.utts, ctx.bible, ctx.vision || null);
          const lv = Object.fromEntries(Object.entries(ctx.align.clusters).map(([k, v]) => [k, v.level]));
          return { clusters: lv, suspects: Object.keys(ctx.align.suspects).length };
        },
      },
      {
        id: "B5",
        name: "human",
        title: "nhãn người soát thắng mọi kênh máy",
        cost: "free",
        when: (ctx) => Boolean(ctx.bible && ctx.labels),
        run(ctx) {
          B.applySpeakers(ctx.utts, ctx.align, ctx.bible, ctx.labels);
          const h = ctx.align.human;
          return { clusters: Object.keys(h.clusters).length, lines: Object.keys(h.lines).length, moved: h.moved, unknown: h.unknown };
        },
        emit: (ctx) => ({ "utts.json": ctx.utts }),
      },
      {
        id: "B6",
        name: "sheet",
        title: "dựng hồ sơ dịch từ bible",
        cost: "free",
        when: (ctx) => Boolean(ctx.bible),
        run(ctx) {
          ctx.sheet = B.sheetFromBible(ctx.bible, ctx.align, { ep: ctx.ep, utts: ctx.utts });
          ctx.suspects = ctx.align.suspects || {};
          return {
            characters: ctx.sheet.characters.length,
            address: ctx.sheet.address.length,
            suspects: Object.keys(ctx.suspects).length,
          };
        },
        emit: (ctx) => ({
          "sheet.json": ctx.sheet,
          "align.final.json": {
            speakerMap: ctx.align.speakerMap,
            clusters: ctx.align.clusters,
            suspects: ctx.align.suspects,
            human: ctx.align.human ?? null,
          },
          ...(ctx.align.newTerms
            ? { "proposals.json": { terms: ctx.align.newTerms, unmapped: ctx.align.unmapped || [], bibleVersion: ctx.bible.version } }
            : {}),
        }),
      },
    ],
  },

  {
    id: "C",
    name: "render",
    title: "dịch zh → vi",
    subs: [
      {
        id: "C1",
        name: "plan",
        title: "cắt lô theo ngân sách token đầu ra",
        cost: "free",
        run(ctx) {
          ctx.renderSize = C.planChunks(ctx.utts);
          return { size: ctx.renderSize, calls: Math.ceil(ctx.utts.length / ctx.renderSize) };
        },
      },
      {
        id: "C2",
        name: "translate",
        title: "dịch",
        cost: "llm",
        artifact: "c2-vi.json",
        sig: (ctx) => [uttSig(ctx.utts), ctx.sheet, ctx.pinned, ctx.cps, ctx.renderSize, ctx.models.render],
        async run(ctx) {
          const { vi, ent } = await C.render(ctx.llm, ctx.utts, ctx.sheet, ctx.glossary, {
            cps: ctx.cps, size: ctx.renderSize, model: ctx.models.render, pinned: ctx.pinned,
          });
          return { vi, ent };
        },
        after(ctx, v) {
          ctx.vi = Object.fromEntries(Object.entries(v.vi).map(([k, s]) => [Number(k), s]));
          ctx.ent = v.ent;
        },
        emit: (ctx) => ({ "vi_raw.json": ctx.vi }),
      },
    ],
  },

  {
    id: "D",
    name: "verify",
    title: "soát và dịch lại chỗ hỏng",
    // Số vòng là tham số nên danh sách công đoạn con dựng theo ctx. Mỗi vòng là một
    // checkpoint riêng: vòng 2 hỏng thì không phải trả tiền lại cho vòng 1.
    subs(ctx) {
      const subs = [];
      for (let r = 0; r < ctx.rounds; r++) {
        subs.push({
          id: `D2.${r + 1}`,
          name: `critic-${r + 1}`,
          title: `chấm điểm vòng ${r + 1}`,
          cost: "llm",
          artifact: `d2-critic${r + 1}.json`,
          sig: (c) => [uttSig(c.utts), c.vi, c.sheet, c.models.critic],
          run: (c) => D.critic(c.llm, c.utts, c.vi, c.sheet, c.glossary, {
            model: c.models.critic, pinned: c.pinned,
          }),
          after: (c, v) => { c.scores = v; },
          emit: (c) => ({ [`critic${r + 1}.json`]: c.scores }),
        });
        subs.push({
          id: `D3.${r + 1}`,
          name: `fix-${r + 1}`,
          title: `dịch lại câu bị báo lỗi, vòng ${r + 1}`,
          cost: "llm",
          artifact: `d3-fix${r + 1}.json`,
          sig(c) {
            const { ids, notes } = fixTargets(c);
            return [uttSig(c.utts), c.vi, ids, notes, c.models.fix];
          },
          run: async (c) => {
            const { ids, notes } = fixTargets(c);
            if (!ids.length) return {};
            const before = { ...c.vi };
            const after = await D.repairLines(c.llm, c.utts, { ...c.vi }, c.sheet, c.glossary, ids, notes, {
              cps: c.cps, model: c.models.fix, pinned: c.pinned,
            });
            // chỉ lưu phần THAY ĐỔI: đọc lại checkpoint là biết vòng này đã sửa gì
            return Object.fromEntries(Object.entries(after).filter(([k, v]) => before[k] !== v));
          },
          after: (c, v) => { Object.assign(c.vi, Object.fromEntries(Object.entries(v).map(([k, s]) => [Number(k), s]))); },
        });
      }
      subs.push({
        id: "D1",
        name: "check",
        title: "luật code, vòng chốt",
        cost: "free",
        run(c) {
          c.hard = D.check(c.utts, c.vi, c.ent, { cps: c.cps });
          return { fail: Object.keys(c.hard).length, ids: Object.keys(c.hard).map(Number) };
        },
      });
      subs.push({
        id: "D4",
        name: "decjk",
        title: "cứu câu còn sót chữ Hán",
        cost: "llm",
        artifact: "d4-decjk.json",
        when: (c) => Object.values(c.vi).some((t) => C.CJK.test(t)),
        sig: (c) => [c.vi, c.ent, c.models.fix, c.models.mt],
        run: async (c) => {
          const before = { ...c.vi };
          const after = await D.decjk(c.llm, c.utts, { ...c.vi }, c.ent, {
            sheet: c.sheet, gloss: c.glossary, model: c.models.fix, mtModel: c.models.mt,
          });
          return Object.fromEntries(Object.entries(after).filter(([k, v]) => before[k] !== v));
        },
        after(c, v) {
          Object.assign(c.vi, Object.fromEntries(Object.entries(v).map(([k, s]) => [Number(k), s])));
          c.hard = D.check(c.utts, c.vi, c.ent, { cps: c.cps });
        },
      });
      return subs;
    },
  },

  {
    id: "E",
    name: "export",
    title: "xuất",
    subs: [
      {
        id: "E1",
        name: "srt",
        title: "phụ đề",
        cost: "free",
        run: (ctx) => ({ lines: ctx.utts.filter((u) => u.start !== null).length }),
        emit: (ctx) => ({ "vi.json": ctx.vi, "vi.srt": E.toSrt(ctx.utts, ctx.vi) }),
      },
      {
        id: "E2",
        name: "voices",
        title: "khớp tên với thư mục voice/",
        cost: "free",
        when: (ctx) => Boolean(ctx.dataDir),
        async run(ctx) {
          const names = (ctx.sheet.characters || []).map((c) => c.zh || c.key);
          const { alias, missing } = await E.matchVoices(names, `${ctx.dataDir}/voice`);
          ctx.alias = alias;
          return { alias, missing };
        },
      },
      {
        id: "E3",
        name: "translation",
        title: "translation.json đúng schema douyind",
        cost: "free",
        run(ctx) {
          ctx.translation = E.exportTranslation(ctx.utts, ctx.vi, ctx.sheet, ctx.meta(), {
            criticScores: ctx.scores, alias: ctx.alias, suspects: ctx.suspects,
          });
          return {
            segments: ctx.translation.segments.length,
            needsReview: ctx.translation.segments.filter((s) => s.needsReview).length,
            speakers: ctx.translation.speakers,
          };
        },
        emit: (ctx) => ({
          "translation.json": ctx.translation,
          "translation.txt": ctx.translation.segments.map((s) => s.vi).filter(Boolean).join(" "),
          "final.json": ctx.utts.map((u) => ({ ...u, vi: ctx.vi[u.id] || "" })),
        }),
      },
    ],
  },
];

export const STAGE_IDS = STAGES.map((s) => s.id);

/** Danh sách công đoạn con của một stage — `subs` có thể là hàm (pass D phụ thuộc `rounds`). */
export const subsOf = (stage, ctx) => (typeof stage.subs === "function" ? stage.subs(ctx) : stage.subs);
