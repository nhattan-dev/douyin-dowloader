/**
 * Trang duyệt bible nháp — một file HTML tự chứa (ảnh + tiếng nhúng base64).
 *
 * Người duyệt KHÔNG đọc chữ Hán, nên trang chỉ hỏi thứ phán được bằng tiếng Việt, tai và mắt:
 * tên đọc có xuôi không, giới tính/vai có khớp giọng và hình không, hai mục có phải cùng một
 * người không, look có tả đúng người trong ảnh không, xưng hô có đúng quan hệ không. Chữ Hán
 * chỉ hiện nhỏ bên cạnh vì dữ liệu khoá theo nó.
 *
 * Mọi ô mang `data-k`; nút Xuất ghi GIÁ TRỊ CUỐI của mọi ô (không chỉ ô đã sửa) — xem applyReview.
 */
import fs from "node:fs/promises";
import path from "node:path";

const esc = (s) => String(s ?? "")
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const GVI = { male: "nam", female: "nữ", "?": "?" };
const ROLE = [["main", "chính"], ["episodic", "phụ"], ["mentioned", "chỉ được nhắc tới"]];

const CSS = `
:root{--bg:#14161a;--fg:#e6e6e6;--dim:#8b93a1;--line:#2a2f38;--card:#1b1f26;--warn:#8a5a1a;--pick:#2563eb}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 ui-sans-serif,system-ui,"Noto Sans SC",sans-serif}
header{position:sticky;top:0;z-index:9;background:#0f1114;border-bottom:1px solid var(--line);
  padding:10px 16px;display:flex;gap:14px;align-items:center;flex-wrap:wrap}
h1{font-size:15px;margin:0}
h2{font-size:15px;margin:26px 0 10px;border-bottom:1px solid var(--line);padding-bottom:6px}
main{padding:14px 16px;max-width:1400px;margin:0 auto}
button,select,input,textarea{background:#12151a;color:var(--fg);border:1px solid var(--line);border-radius:6px;
  padding:5px 8px;font:inherit;font-size:13px}
button{background:#232833;cursor:pointer}button.pri{background:var(--pick);border-color:var(--pick)}
textarea{width:100%;resize:vertical}
label{display:block;font-size:12px;color:var(--dim);margin:0 0 8px}
label input:not([type=checkbox]),label select,label textarea{display:block;width:100%;margin-top:2px;color:var(--fg)}
label.chk{color:var(--fg)}label.chk input{margin-right:6px}
.dim{color:var(--dim)}.small{font-size:12px}.zhs{color:var(--dim);font-size:12px}
.hint{background:#1a2230;border:1px solid #2b3a52;border-radius:8px;padding:10px 12px;margin:10px 0;font-size:13px}
.doubts li{margin:3px 0}
.card{background:var(--card);border:1px solid var(--line);border-left:3px solid transparent;border-radius:8px;
  padding:12px;margin-bottom:12px;display:grid;grid-template-columns:minmax(0,1fr) 360px;gap:16px}
.card.warn{border-left-color:var(--warn)}.card.off{opacity:.45}
@media (max-width:900px){.card{grid-template-columns:1fr}}
.hd{display:flex;gap:8px;align-items:baseline;flex-wrap:wrap;margin-bottom:6px}.nm{font-size:16px}
.badge{font-size:11px;padding:1px 7px;border-radius:99px;border:1px solid var(--line);color:var(--dim)}
.doubt{color:#f0a04b;font-size:12.5px;margin:4px 0 8px}
.imgs{display:flex;gap:5px;flex-wrap:wrap;margin:6px 0}
.imgs img{width:150px;border-radius:4px;border:2px solid transparent}.imgs img.hit{border-color:#3f9e57}
.smp{display:flex;gap:10px;align-items:center;margin:6px 0}.smp audio{height:30px;width:220px;flex:none}
.two{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.tw{overflow-x:auto}
table{border-collapse:collapse;width:100%;font-size:13px}
td,th{border-bottom:1px solid var(--line);padding:5px 6px;text-align:left;vertical-align:middle}
th{color:var(--dim);font-weight:500;font-size:12px}
td input:not([type=checkbox]){width:100%}
input.n{width:4em!important}
`;

const PAGE_JS = String.raw`
const KEY='zhvi-bible-'+document.body.dataset.sig;
let store={};try{store=JSON.parse(localStorage.getItem(KEY)||'{}')}catch(e){}
const els=()=>[...document.querySelectorAll('[data-k]')];
const val=e=>e.type==='checkbox'?e.checked:e.value;
const setv=(e,v)=>{if(e.type==='checkbox')e.checked=Boolean(v);else e.value=v};
function keep(){try{localStorage.setItem(KEY,JSON.stringify(store))}catch(e){}}
function paint(){
  document.getElementById('prog').textContent=Object.keys(store).length+' ô đã sửa so với nháp';
  document.querySelectorAll('.card').forEach(c=>{
    const d=c.querySelector('[data-k$=".drop"]'),m=c.querySelector('[data-k$=".merge"]');
    c.classList.toggle('off',Boolean((d&&d.checked)||(m&&m.value)))});
}
document.addEventListener('DOMContentLoaded',()=>{
  els().forEach(e=>{
    const k=e.dataset.k;e.dataset.orig=JSON.stringify(val(e));
    if(k in store)setv(e,store[k]);
    e.addEventListener(e.type==='checkbox'||e.tagName==='SELECT'?'change':'input',()=>{
      const v=val(e);if(JSON.stringify(v)===e.dataset.orig)delete store[k];else store[k]=v;keep();paint()});
  });
  document.getElementById('exp').addEventListener('click',()=>{
    const values={};els().forEach(e=>{values[e.dataset.k]=val(e)});
    const b=new Blob([JSON.stringify({by:'fleex',draftVersion:document.body.dataset.sig,values},null,1)],{type:'application/json'});
    const a=document.createElement('a');a.href=URL.createObjectURL(b);a.download='bible-review.json';a.click();
  });
  document.getElementById('rst').addEventListener('click',()=>{
    if(confirm('Bỏ hết chỗ đã sửa, quay về nháp của máy?')){store={};keep();location.reload()}});
  const auds=[...document.querySelectorAll('audio')];
  auds.forEach(a=>a.addEventListener('play',()=>auds.forEach(o=>{if(o!==a)o.pause()})));
  paint();
});
`;

function select(k, opts, cur) {
  return `<select data-k="${esc(k)}">${opts.map(([v, t]) =>
    `<option value="${esc(v)}"${v === cur ? " selected" : ""}>${esc(t)}</option>`).join("")}</select>`;
}

function castCard(c, m, castOpts) {
  const k = (f) => `cast.${c.id}.${f}`;
  const imgs = (m?.images || []).map((src, i) =>
    `<img src="${src}" loading="lazy" class="${(c.lookFrames || []).includes(i) ? "hit" : ""}" title="khung ${i}">`).join("");
  const samples = (c.samples || []).map((s, i) => `
      <div class="smp"><audio controls preload="none" src="data:audio/mpeg;base64,${m?.clips?.[i] || ""}"></audio>
        <div><div>${esc(s.vi || "")}</div><div class="zhs">tập ${esc(s.ep)} · ${esc(s.zh)}</div></div></div>`).join("");
  const clus = Object.entries(c.clusters || {}).map(([ep, ks]) => `tập ${ep}: ${ks.join(", ")}`).join(" · ");
  return `
<section class="card${c.doubt ? " warn" : ""}" id="${esc(c.id)}">
  <div>
    <div class="hd"><b class="nm">${esc(c.vi || c.zh)}</b>
      <span class="zhs">${esc(c.zh)}${c.alias?.length ? " · còn gọi " + esc(c.alias.join(", ")) : ""}</span>
      <span class="badge">${c.id}</span><span class="badge">${c.lines} câu</span>
      <span class="badge">${esc(clus || "không có thoại")}</span></div>
    ${c.doubt ? `<div class="doubt">⚠ ${esc(c.doubt)}</div>` : ""}
    <div class="imgs">${imgs || '<span class="dim small">không có khung hình</span>'}</div>
    ${c.lookWhy ? `<div class="dim small">máy nhìn: ${esc(c.lookWhy)}${c.lookSure ? "" : " — <b>KHÔNG chắc</b>"} · viền xanh = khung máy bảo có người này</div>` : ""}
    ${samples}
  </div>
  <div>
    <label>Tên tiếng Việt<input data-k="${esc(k("vi"))}" value="${esc(c.vi)}"></label>
    <label>Gọi tắt<input data-k="${esc(k("viShort"))}" value="${esc(c.viShort)}" placeholder="(không có)"></label>
    <div class="two">
      <label>Giới tính${select(k("gender"), [["male", "nam"], ["female", "nữ"], ["?", "?"]], c.gender)}</label>
      <label>Vai${select(k("role"), ROLE, c.role)}</label>
    </div>
    <label>Ngoại hình — tả chỗ KHÁC người khác<textarea data-k="${esc(k("look"))}" rows="3">${esc(c.look || "")}</textarea></label>
    <label>Vai trò / quan hệ<textarea data-k="${esc(k("note"))}" rows="2">${esc(c.note)}</textarea></label>
    <label>Là cùng một người với${select(k("merge"), [["", "— không —"], ...castOpts.filter(([v]) => v !== c.id)], "")}</label>
    <label class="chk"><input type="checkbox" data-k="${esc(k("drop"))}">bỏ mục này (không phải nhân vật / máy bịa)</label>
  </div>
</section>`;
}

export async function buildBiblePage(draft, mediaByCast, out) {
  const name = Object.fromEntries(draft.cast.map((c) => [c.id, c.viShort || c.vi || c.zh]));
  const castOpts = draft.cast.map((c) => [c.id, `${c.id} ${c.vi || c.zh}`]);
  const order = [...draft.cast].sort((a, b) =>
    (a.role === "main" ? 0 : 1) - (b.role === "main" ? 0 : 1) || b.lines - a.lines);

  const eps = draft.episodes.map((e) => `
<tr><td><input type="checkbox" data-k="ep.${esc(e.videoId)}.use"${e.use ? " checked" : ""}></td>
  <td><input class="n" data-k="ep.${esc(e.videoId)}.ep" value="${esc(e.ep)}"></td>
  <td>${esc(e.title)}</td><td>${e.duration ?? "?"}s</td><td class="zhs">${esc(e.videoId)}</td>
  <td class="doubt">${esc(e.why)}</td></tr>`).join("");

  const addr = draft.address.map((a, i) => `
<tr><td><b>${esc(name[a.from])}</b> nói với <b>${esc(name[a.to])}</b></td>
  <td>tự xưng <input data-k="addr.${i}.self" value="${esc(a.self)}"></td>
  <td>gọi <input data-k="addr.${i}.other" value="${esc(a.other)}"></td>
  <td>từ tập ${esc(a.fromEp)}</td><td class="dim small">${esc(a.why)}</td>
  <td><label class="chk"><input type="checkbox" data-k="addr.${i}.drop">bỏ</label></td></tr>`).join("");

  const terms = Object.entries(draft.terms)
    .sort(([, a], [, b]) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || a.vi.localeCompare(b.vi))
    .map(([zh, t]) => (t.pinned
      ? `<tr><td>${esc(t.vi)}</td><td class="zhs">${esc(zh)}</td><td class="dim small">đã ghim tay</td></tr>`
      : `<tr><td><input data-k="term.${esc(zh)}.vi" value="${esc(t.vi)}"></td><td class="zhs">${esc(zh)}</td>
         <td><label class="chk"><input type="checkbox" data-k="term.${esc(zh)}.drop">bỏ</label></td></tr>`)).join("");

  const html = `<!doctype html><html lang="vi"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Duyệt bible — ${esc(draft.series.titleVi || draft.series.id)}</title>
<style>${CSS}</style></head><body data-sig="${esc(draft.version)}">
<header><h1>Duyệt bible — ${esc(draft.series.titleVi || draft.series.id)}</h1>
  <span class="dim small" id="prog"></span>
  <button class="pri" id="exp">Xuất JSON</button><button id="rst">Về nháp</button>
  <span class="dim small">tự lưu trong trình duyệt</span></header>
<main>
<div class="hint">Máy đã lập nháp. Chỉ cần soát phía <b>tiếng Việt</b>: nghe giọng + nhìn ảnh xem tên, giới tính, vai
có khớp không; hai mục là cùng một người thì chọn ở "Là cùng một người với"; look có tả đúng người trong ảnh không.
Không sửa gì = đồng ý với máy. Xong bấm <b>Xuất JSON</b>, rồi chạy lệnh <code>series apply</code>.</div>

${draft.doubts.length ? `<h2>⚠ Máy không chắc (${draft.doubts.length})</h2><ul class="doubts">${draft.doubts.map((d) => `<li>${esc(d)}</li>`).join("")}</ul>` : ""}

<h2>Tên phim</h2>
<label>Tên tiếng Việt <span class="zhs">${esc(draft.series.titleZh)}</span>
  <input data-k="series.titleVi" value="${esc(draft.series.titleVi)}"></label>

<h2>Tập (${draft.episodes.filter((e) => e.use).length}/${draft.episodes.length} dùng)</h2>
<div class="tw"><table><tr><th>dùng</th><th>tập</th><th>tên tác giả đặt</th><th>dài</th><th>video</th><th></th></tr>${eps}</table></div>

<h2>Nhân vật (${draft.cast.length})</h2>
${order.map((c) => castCard(c, mediaByCast[c.id], castOpts)).join("")}

<h2>Xưng hô (${draft.address.length})</h2>
<div class="tw"><table>${addr || '<tr><td class="dim">máy không đề xuất cặp nào</td></tr>'}</table></div>

<h2>Thuật ngữ (${Object.keys(draft.terms).length})</h2>
<div class="tw"><table><tr><th>tiếng Việt</th><th></th><th></th></tr>${terms}</table></div>
</main>
<script>${PAGE_JS}</script></body></html>`;
  await fs.mkdir(path.dirname(path.resolve(out)), { recursive: true });
  await fs.writeFile(out, html, "utf8");
  return out;
}
