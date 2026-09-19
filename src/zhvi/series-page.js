/**
 * Trang duyệt bible nháp — một file HTML tự chứa (ảnh + tiếng nhúng base64).
 *
 * Người duyệt KHÔNG đọc chữ Hán, nên trang chỉ hỏi thứ phán được bằng tiếng Việt, tai và mắt:
 * tên đọc có xuôi không, giới tính/vai có khớp giọng và hình không, hai mục có phải cùng một
 * người không, look có tả đúng người trong ảnh không, xưng hô có đúng quan hệ không. Chữ Hán
 * chỉ hiện nhỏ bên cạnh vì dữ liệu khoá theo nó.
 *
 * Ba thứ ở đây sinh ra từ việc tự đi lại luồng bằng mắt người duyệt:
 *
 *   - CẢNH, không phải câu lẻ. Một câu đứng một mình («Ngươi dám!») thì ai nói với ai cũng được,
 *     nên mỗi câu mẫu mang theo mấy câu trước/sau, có bản dịch thô của cả cảnh.
 *   - XEM VIDEO đúng đoạn đó. Ảnh tĩnh không phân biệt được người ĐANG NÓI với người ĐANG NGHE
 *     (máy quay hay chiếu mặt người nghe — chính chỗ VLM tả nhầm), mà trang này lại hỏi "look có
 *     tả đúng người không". Video KHÔNG nhúng vào file: phát thẳng từ video.mp4 gốc, vì trang đã
 *     2,7 MB chỉ với ảnh + tiếng. Mở bằng file:// thì đi đường dẫn tương đối, mở qua UI thì /media/.
 *   - THÊM nhân vật. Máy bỏ sót một người là ngõ cụt: trang soát người nói từng tập chỉ cho chọn
 *     trong dàn nhân vật của bible. Kèm theo là bằng chứng (cụm giọng chưa ai nhận) và danh sách
 *     tên gọi trong thoại để CHỌN — người duyệt không gõ được chữ Hán.
 *
 * Mọi ô mang `data-k`; nút Xuất ghi GIÁ TRỊ CUỐI của mọi ô (không chỉ ô đã sửa) — xem applyReview.
 */
import fs from "node:fs/promises";
import path from "node:path";

const esc = (s) => String(s ?? "")
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const GENDER_OPTS = [["male", "nam"], ["female", "nữ"], ["?", "?"]];
const ROLE = [["main", "chính"], ["episodic", "phụ"], ["mentioned", "chỉ được nhắc tới"]];
// Một hàng trống là đủ: ba hàng trống chiếm ~1200px dọc trang mà phần lớn lượt duyệt không dùng tới.
const NEW_ROWS = 1;

const mmss = (t) => {
  const s = Math.max(0, Math.round(Number(t) || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

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
.card.add{border-left-color:var(--pick)}
/* 1fr trên mobile bị nội dung (câu dài, thẻ audio) đẩy rộng hơn màn hình -> minmax(0,1fr) */
@media (max-width:900px){.card{grid-template-columns:minmax(0,1fr)}}
.hd{display:flex;gap:8px;align-items:baseline;flex-wrap:wrap;margin-bottom:6px}.nm{font-size:16px}
.badge{font-size:11px;padding:1px 7px;border-radius:99px;border:1px solid var(--line);color:var(--dim)}
.doubt{color:#f0a04b;font-size:12.5px;margin:4px 0 8px}
.imgs{display:flex;gap:5px;flex-wrap:wrap;margin:6px 0}
.imgs img{width:150px;border-radius:4px;border:2px solid transparent}.imgs img.hit{border-color:#3f9e57}
.smp{display:flex;gap:10px;align-items:flex-start;margin:8px 0}
.smp audio{height:30px;width:200px;flex:none;margin-top:2px}
.smp details{flex:1;min-width:0}
summary{cursor:pointer;list-style:none}summary::-webkit-details-marker{display:none}
summary::before{content:"▸ ";color:var(--dim)}details[open]>summary::before{content:"▾ "}
summary{display:flex;gap:8px;align-items:baseline}
summary .sum{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
details[open]>summary .sum{color:var(--dim)}
summary .zhs{flex:none}
.scn{border-left:2px solid var(--line);margin:6px 0 4px 6px;padding:2px 0 2px 10px}
.ln{display:flex;gap:8px;margin:3px 0}
.ln .spk{flex:none;width:6.5em;color:var(--dim);font-size:11px;text-align:right;padding-top:2px;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ln.self>div{font-weight:600}
.ln:not(.self){color:#b9c0cc}
.play{margin-top:6px}
.vid{width:100%;max-width:480px;border-radius:6px;margin-top:6px;background:#000}
.two{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.tw{overflow-x:auto}
table{border-collapse:collapse;width:100%;font-size:13px}
td,th{border-bottom:1px solid var(--line);padding:5px 6px;text-align:left;vertical-align:middle}
th{color:var(--dim);font-weight:500;font-size:12px}
td input:not([type=checkbox]){width:100%}
input.n{width:4em!important}
/* đặt CUỐI stylesheet: media query cùng độ ưu tiên, để trước là bị luật .smp audio ở dưới đè */
@media (max-width:600px){.smp{flex-wrap:wrap}.smp audio{width:100%}.smp details{flex:1 0 100%}
  .ln .spk{width:4.5em}.imgs img{width:calc(50% - 3px)}}
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
function wire(e){
  const k=e.dataset.k;e.dataset.orig=JSON.stringify(val(e));
  if(k in store)setv(e,store[k]);
  e.addEventListener(e.type==='checkbox'||e.tagName==='SELECT'?'change':'input',()=>{
    const v=val(e);if(JSON.stringify(v)===e.dataset.orig)delete store[k];else store[k]=v;keep();paint()});
}
// Trang mở được hai kiểu: file:// (đường dẫn tương đối tới video.mp4) và qua UI (/media/…).
function srcOf(el){
  const rel=el.dataset.rel||'',repo=el.dataset.repo||'';
  if(location.protocol==='file:'||!repo)return rel;
  return '/media/'+repo.split('/').map(encodeURIComponent).join('/');
}
function playScene(btn){
  const a=Number(btn.dataset.a||0),b=Number(btn.dataset.b||0),src=srcOf(btn);
  if(!src){btn.replaceWith(note('không có video.mp4 của tập này'));return}
  const v=document.createElement('video');
  v.className='vid';v.controls=true;v.autoplay=true;v.preload='metadata';
  v.src=src+'#t='+a.toFixed(2)+','+b.toFixed(2);
  v.addEventListener('timeupdate',()=>{if(b&&v.currentTime>b+0.25)v.pause()});
  v.addEventListener('error',()=>{v.replaceWith(note('không mở được '+src))});
  btn.replaceWith(v);
}
function note(t){const d=document.createElement('div');d.className='dim small';d.textContent=t;return d}
function addRow(i){
  const box=document.getElementById('newrows');
  const d=document.createElement('section');
  d.className='card add';
  d.innerHTML=document.getElementById('newrow').innerHTML.replace(/__I__/g,String(i));
  box.appendChild(d);
  return d;
}
document.addEventListener('DOMContentLoaded',()=>{
  // hàng "thêm nhân vật": dựng lại đủ số hàng đã gõ dở trước khi nạp giá trị
  let maxNew=NEWROWS-1;
  Object.keys(store).forEach(k=>{const m=/^new\.(\d+)\./.exec(k);if(m)maxNew=Math.max(maxNew,Number(m[1]))});
  for(let i=0;i<=maxNew;i++)addRow(i);
  const more=document.getElementById('more');
  if(more)more.addEventListener('click',()=>{
    const n=document.querySelectorAll('#newrows .card').length;
    addRow(n).querySelectorAll('[data-k]').forEach(wire);
    bindPicks();});

  els().forEach(wire);
  bindPicks();
  document.getElementById('exp').addEventListener('click',()=>{
    const values={};els().forEach(e=>{values[e.dataset.k]=val(e)});
    const b=new Blob([JSON.stringify({by:'fleex',draftVersion:document.body.dataset.sig,values},null,1)],{type:'application/json'});
    const a=document.createElement('a');a.href=URL.createObjectURL(b);a.download='bible-review.json';a.click();
  });
  document.getElementById('rst').addEventListener('click',()=>{
    if(confirm('Bỏ hết chỗ đã sửa, quay về nháp của máy?')){store={};keep();location.reload()}});
  document.addEventListener('click',ev=>{
    const b=ev.target.closest('button.play');if(b)playScene(b)});
  // play không nổi bọt -> bắt ở pha capture, ăn cả thẻ dựng thêm sau
  document.addEventListener('play',ev=>{
    document.querySelectorAll('audio,video').forEach(o=>{if(o!==ev.target)o.pause()})},true);
  paint();
});
function bindPicks(){
  document.querySelectorAll('select.pick:not([data-bound])').forEach(p=>{
    p.dataset.bound='1';
    p.addEventListener('change',()=>{
      const o=p.options[p.selectedIndex];if(!o.value)return;
      const row=p.closest('.card');
      const zh=row.querySelector('[data-k$=".zh"]'),vi=row.querySelector('[data-k$=".vi"]');
      if(zh){zh.value=o.value;zh.dispatchEvent(new Event('input'))}
      if(vi&&!vi.value){vi.value=o.dataset.vi||'';vi.dispatchEvent(new Event('input'))}});
  });
}
`;

function select(k, opts, cur) {
  return `<select data-k="${esc(k)}">${opts.map(([v, t]) =>
    `<option value="${esc(v)}"${v === cur ? " selected" : ""}>${esc(t)}</option>`).join("")}</select>`;
}

/** Nút phát đúng đoạn video của cảnh. Không có video.mp4 thì không vẽ nút chết. */
function playBtn(s, label = "Xem cảnh") {
  if (!s.video) return '<div class="dim small">không có video.mp4 — không xem được cảnh</div>';
  const len = Math.max(1, Math.round((s.sceneEnd ?? s.end) - (s.sceneStart ?? s.start)));
  return `<button class="play" data-rel="${esc(s.video.rel || "")}" data-repo="${esc(s.video.repo || "")}"
    data-a="${(s.sceneStart ?? s.start).toFixed(2)}" data-b="${(s.sceneEnd ?? s.end).toFixed(2)}">▶ Xem cảnh (${len}s)</button>`;
}

/**
 * Một cảnh: câu mẫu in đậm, mấy câu quanh nó mờ hơn, kèm nút xem video đúng đoạn.
 *
 * Nhãn bên trái là TÊN nhân vật chứ không phải mã cụm giọng khi máy đã nhận ra cụm đó — "S5"
 * không nói gì với người duyệt, "Thẩm Uyển Nhi" thì cho biết ngay đang là cảnh ai với ai.
 */
function sceneBlock(s, spkName, { open = false, extra = "" } = {}) {
  const lines = (s.scene || []).map((l) => `
      <div class="ln${l.self ? " self" : ""}"><span class="spk" title="cụm giọng ${esc(l.spk || "?")}">${esc(spkName[`${s.ep}|${l.spk}`] || l.spk || "")}</span>
        <div><div>${esc(l.vi || "(chưa dịch)")}</div><div class="zhs">${esc(l.zh)}</div></div></div>`).join("");
  return `
    <details class="scene"${open ? " open" : ""}>
      <summary><span class="sum">${esc(s.vi || s.zh)}</span>
        <span class="zhs">tập ${esc(s.ep)} · ${mmss(s.sceneStart ?? s.start)} · ${(s.scene || []).length} câu</span></summary>
      <div class="scn">${lines}
        <div class="play">${playBtn(s)}</div>${extra}</div>
    </details>`;
}

function castCard(c, m, castOpts, spkName) {
  const k = (f) => `cast.${c.id}.${f}`;
  const imgs = (m?.images || []).map((src, i) =>
    `<img src="${src}" loading="lazy" class="${(c.lookFrames || []).includes(i) ? "hit" : ""}" title="khung ${i}">`).join("");
  // CHỈ mở sẵn cảnh đầu. Từng thử mở hết ở nhân vật máy không chắc: 4 cảnh × 5 câu thành bức
  // tường chữ ngay thẻ đầu trang, mà nhân vật chính thì gần như luôn có dòng ⚠.
  const samples = (c.samples || []).map((s, i) => `
      <div class="smp"><audio controls preload="none" src="data:audio/mpeg;base64,${m?.clips?.[i] || ""}"></audio>
        ${sceneBlock(s, spkName, { open: i === 0 })}</div>`).join("");
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
    ${samples || '<div class="dim small">không có câu mẫu</div>'}
  </div>
  <div>
    <label>Tên tiếng Việt<input data-k="${esc(k("vi"))}" value="${esc(c.vi)}"></label>
    <label>Gọi tắt<input data-k="${esc(k("viShort"))}" value="${esc(c.viShort)}" placeholder="(không có)"></label>
    <div class="two">
      <label>Giới tính${select(k("gender"), GENDER_OPTS, c.gender)}</label>
      <label>Vai${select(k("role"), ROLE, c.role)}</label>
    </div>
    <label>Ngoại hình — tả chỗ KHÁC người khác<textarea data-k="${esc(k("look"))}" rows="3">${esc(c.look || "")}</textarea></label>
    <label>Vai trò / quan hệ<textarea data-k="${esc(k("note"))}" rows="2">${esc(c.note)}</textarea></label>
    <label>Là cùng một người với${select(k("merge"), [["", "— không —"], ...castOpts.filter(([v]) => v !== c.id)], "")}</label>
    <label class="chk"><input type="checkbox" data-k="${esc(k("drop"))}">bỏ mục này (không phải nhân vật / máy bịa)</label>
  </div>
</section>`;
}

/** Cụm giọng không nhân vật nào nhận — bằng chứng để quyết "có phải người máy bỏ sót không". */
function unassignedCard(un, spkName) {
  return `
<section class="card">
  <div>
    <div class="hd"><b class="nm">Tập ${esc(un.ep)} · cụm giọng ${esc(un.spk)}</b>
      <span class="badge">${un.lines} câu</span>
      <span class="badge">chưa ai nhận</span></div>
    <div class="smp">
      ${un.clip ? `<audio controls preload="none" src="data:audio/mpeg;base64,${un.clip}"></audio>` : ""}
      ${sceneBlock(un, spkName, { open: true })}
    </div>
  </div>
  <div class="dim small">Nghe + xem cảnh: nếu là một người CHƯA có trong danh sách trên thì thêm ở dưới.
    Nếu là người đã có, không phải làm gì ở đây — việc gán cụm giọng này cho đúng người làm ở bước
    <b>Soát người nói</b> của tập ${esc(un.ep)}, sau khi dịch.</div>
</section>`;
}

function newRowTemplate(candidates) {
  const opts = [`<option value="">— không có trong danh sách, tự đặt tên —</option>`,
    ...candidates.map((t) => `<option value="${esc(t.zh)}" data-vi="${esc(t.vi)}">${esc(t.vi || t.zh)} (${esc(t.zh)}) · ${t.count} lần</option>`)].join("");
  const lines = candidates.slice(0, 6).map((t) => `
    <div class="ln"><span class="spk">${t.count}×</span>
      <div><div>${esc(t.vi || t.zh)} <span class="zhs">${esc(t.zh)}</span></div>
        <div class="dim small">tập ${esc(t.ep)}: ${esc(t.line.vi || t.line.zh)}</div></div></div>`).join("");
  return `
<template id="newrow">
  <div>
    <div class="hd"><b class="nm">Nhân vật thêm tay</b></div>
    <label>Tên máy nghe thấy người ta GỌI trong thoại
      <select class="pick">${opts}</select></label>
    ${candidates.length ? `<div class="scn">${lines}</div>` : '<div class="dim small">máy không thấy tên nào bị gọi mà chưa có trong danh sách</div>'}
    <div class="dim small">Không có trong danh sách cũng không sao: cứ đặt tên tiếng Việt, máy dùng đúng tên đó.</div>
  </div>
  <div>
    <label>Tên tiếng Việt<input data-k="new.__I__.vi" placeholder="để trống = không thêm ai"></label>
    <label>Gọi tắt<input data-k="new.__I__.viShort" placeholder="(không có)"></label>
    <div class="two">
      <label>Giới tính<select data-k="new.__I__.gender">${GENDER_OPTS.map(([v, t]) => `<option value="${v}"${v === "?" ? " selected" : ""}>${t}</option>`).join("")}</select></label>
      <label>Vai<select data-k="new.__I__.role">${ROLE.map(([v, t]) => `<option value="${v}"${v === "episodic" ? " selected" : ""}>${t}</option>`).join("")}</select></label>
    </div>
    <label>Tên gốc (chữ Hán)<input data-k="new.__I__.zh" placeholder="(chọn ở bên trái — bỏ trống cũng được)"></label>
    <label>Ngoại hình — tả chỗ KHÁC người khác<textarea data-k="new.__I__.look" rows="2"></textarea></label>
    <label>Vai trò / quan hệ<textarea data-k="new.__I__.note" rows="2"></textarea></label>
  </div>
</template>`;
}

export async function buildBiblePage(draft, mediaByCast, out) {
  const name = Object.fromEntries(draft.cast.map((c) => [c.id, c.viShort || c.vi || c.zh]));
  const castOpts = draft.cast.map((c) => [c.id, `${c.id} ${c.vi || c.zh}`]);
  const order = [...draft.cast].sort((a, b) =>
    (a.role === "main" ? 0 : 1) - (b.role === "main" ? 0 : 1) || b.lines - a.lines);
  const unassigned = draft.unassigned || [];
  const candidates = draft.candidates || [];
  // "S5" không nói gì với người duyệt; cụm nào máy đã nhận ra thì hiện tên người
  const spkName = {};
  for (const c of draft.cast) {
    for (const [ep, ks] of Object.entries(c.clusters || {})) {
      for (const s of ks) spkName[`${ep}|${s}`] = c.viShort || c.vi || c.zh;
    }
  }

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
Bấm một cảnh để đọc mấy câu quanh nó, bấm <b>▶ Xem cảnh</b> để xem đúng đoạn phim đó (thấy ai đang mấp máy miệng).
Máy bỏ sót người nào thì thêm ở mục <b>Thêm nhân vật</b> cuối trang.
Không sửa gì = đồng ý với máy. Xong bấm <b>Xuất JSON</b>, rồi chạy lệnh <code>series apply</code>.</div>

${draft.doubts.length ? `<h2>⚠ Máy không chắc (${draft.doubts.length})</h2><ul class="doubts">${draft.doubts.map((d) => `<li>${esc(d)}</li>`).join("")}</ul>` : ""}

<h2>Tên phim</h2>
<label>Tên tiếng Việt <span class="zhs">${esc(draft.series.titleZh)}</span>
  <input data-k="series.titleVi" value="${esc(draft.series.titleVi)}"></label>

<h2>Tập (${draft.episodes.filter((e) => e.use).length}/${draft.episodes.length} dùng)</h2>
<div class="tw"><table><tr><th>dùng</th><th>tập</th><th>tên tác giả đặt</th><th>dài</th><th>video</th><th></th></tr>${eps}</table></div>

<h2>Nhân vật (${draft.cast.length})</h2>
${order.map((c) => castCard(c, mediaByCast[c.id], castOpts, spkName)).join("")}

<h2>Thêm nhân vật máy bỏ sót</h2>
<div class="hint">Thiếu một người ở đây là <b>ngõ cụt</b>: lúc soát người nói từng tập chỉ chọn được trong danh sách trên.
${unassigned.length ? `Dưới đây là ${unassigned.length} cụm giọng có người nói mà máy không gán cho ai — nghe thử xem có phải người mới không.` : "Máy đã gán hết các cụm giọng, nhưng nếu bạn thấy thiếu ai thì cứ thêm."}</div>
${unassigned.map((un) => unassignedCard(un, spkName)).join("")}
<div id="newrows"></div>
<button id="more">+ thêm một nhân vật nữa</button>
${newRowTemplate(candidates)}

<h2>Xưng hô (${draft.address.length})</h2>
<div class="tw"><table>${addr || '<tr><td class="dim">máy không đề xuất cặp nào</td></tr>'}</table></div>

<h2>Thuật ngữ (${Object.keys(draft.terms).length})</h2>
<div class="tw"><table><tr><th>tiếng Việt</th><th></th><th></th></tr>${terms}</table></div>
</main>
<script>const NEWROWS=${NEW_ROWS};${PAGE_JS}</script></body></html>`;
  await fs.mkdir(path.dirname(path.resolve(out)), { recursive: true });
  await fs.writeFile(out, html, "utf8");
  return out;
}
