/**
 * Cổng người của pass B: một file HTML tự chứa để soát người nói, và đường về.
 *
 * Đặt GIỮA pass B và pass C, không phải ở cuối. Lý do: `sheetFromBible` dựng bảng xưng hô
 * TỪ speakerMap, nên sai người nói không phải sai một cái tên mà sai đại từ của cả câu —
 * soát sau pass C thì mỗi lần sửa một cụm là phải render lại, mà C là pass đắt nhất.
 *
 * Hệ quả: ở đây chưa có bản dịch thật. Cột tiếng Việt chạy qwen-mt-plus thô cho người đọc
 * lướt; người soát cần hình + tiếng + chữ Hán, tiếng Việt chỉ để định hướng.
 */
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import * as BIBLE from "./bible.js";
import { vocativeNames } from "./passes/b-speakers.js";

const pexec = promisify(execFile);

const NA = { ngoai_khung: "ngoài khung", khong_chac: "không chắc", "?parse": "lỗi đọc" };
const SPECIAL = ["ngoài khung", "nhiều người", "không rõ"];
// Cụm không phải ai trong bible -> người duyệt khai một nhân vật MỚI ngay tại đây.
const NEWC = "__new__";
const LEVEL = {
  human: ["người đã chốt", "#3f9e57"], confirmed: ["chốt", "#3f9e57"],
  single: ["một nguồn", "#c98a2b"], conflict: ["cãi nhau", "#d4622a"],
  split: ["cụm lẫn người", "#c0392b"], none: ["không tên", "#c0392b"],
};

async function ff(args) {
  const { stdout } = await pexec("ffmpeg", ["-v", "error", ...args], {
    encoding: "buffer", maxBuffer: 256 * 1024 * 1024,
  });
  return stdout;
}

const readJson = async (p, dflt = null) => {
  try {
    return JSON.parse(await fs.readFile(p, "utf8"));
  } catch {
    return dflt;
  }
};

/**
 * Ảnh + tiếng cho từng câu, base64 nhúng thẳng vào HTML.
 *
 * Có cache vì trích lại 90 câu mất vài phút mà nội dung không đổi; khoá theo id + mốc
 * thời gian nên câu nào bị pass A gộp/tách lại thì tự trích lại, còn lại dùng lại hết.
 */
export async function media(video, utts, cachePath, {
  n = 3, width = 300, q = 6, pad = 0.15, kbps = 40, log = null,
} = {}) {
  const old = (cachePath && (await readJson(cachePath))) || {};
  const out = {};
  let fresh = 0;
  // khoá theo MỐC, không theo id: người cắt một câu thì id các câu sau đánh lại mà clip không đổi
  const keyOf = (u) => `${u.start.toFixed(2)}-${u.end.toFixed(2)}`;

  for (const u of utts) {
    const k = keyOf(u);
    if (k in old) {
      out[k] = old[k];
      continue;
    }
    const ts = Array.from({ length: n }, (_, i) => u.start + ((u.end - u.start) * (i + 0.5)) / n);
    const thumbs = [];
    for (const t of ts) {
      thumbs.push((await ff([
        "-ss", t.toFixed(3), "-i", video, "-frames:v", "1", "-vf", `scale=${width}:-2`,
        "-q:v", String(q), "-f", "image2pipe", "-vcodec", "mjpeg", "-",
      ])).toString("base64"));
    }
    const clip = (await ff([
      "-ss", Math.max(0, u.start - pad).toFixed(3), "-t", (u.end - u.start + 2 * pad).toFixed(3),
      "-i", video, "-vn", "-ac", "1", "-ar", "24000", "-c:a", "libmp3lame",
      "-b:a", `${kbps}k`, "-f", "mp3", "-",
    ])).toString("base64");
    out[k] = { times: ts.map((t) => Math.round(t * 100) / 100), thumbs, clip };
    fresh += 1;
    if (fresh % 10 === 0) log?.info?.(`    trích ${fresh} câu...`);
  }
  if (cachePath) await fs.writeFile(cachePath, JSON.stringify(out), "utf8");
  const mb = Object.values(out).reduce((n2, v) => n2 + JSON.stringify(v).length, 0) / 1e6;
  log?.info?.(`  media: ${Object.keys(out).length} câu (${fresh} trích mới), ${mb.toFixed(1)} MB`);
  return Object.fromEntries(utts.map((u) => [u.id, out[keyOf(u)]]));
}

/**
 * Bản dịch thô CHỈ để người soát đọc lướt — không phải bản dịch của pipeline.
 *
 * Dùng qwen-mt-plus vì nó rẻ, nhanh, và không bao giờ lẫn chữ Hán vào; nó dịch từng câu
 * rời nên thuật ngữ trôi, nhưng ở đây không sao: người soát chỉ cần biết câu nói về cái gì.
 */
export async function roughVi(llm, utts, bib, cachePath = null, { model = "qwen-mt-plus" } = {}) {
  llm.tag = "B-roughvi";
  const old = (cachePath && (await readJson(cachePath))) || {};
  const terms = [
    ...Object.entries(bib.terms).filter(([, t]) => t.approved).map(([zh, t]) => ({ source: zh, target: t.vi })),
    ...bib.cast.map((c) => ({ source: c.zh, target: c.vi || c.zh })),
  ];
  const out = {};
  for (const u of utts) {
    const k = u.zh; // khoá theo câu Hán: id trôi giữa các lần chạy, nội dung thì không
    if (!(k in old)) {
      try {
        const r = await llm.chat(model, [{ role: "user", content: u.zh }], {
          temperature: 0.0, maxTokens: 500,
          extra: {
            translation_options: {
              source_lang: "Chinese", target_lang: "Vietnamese",
              terms: terms.filter((t) => u.zh.includes(t.source)),
            },
          },
        });
        old[k] = r.text.trim();
      } catch (ex) {
        old[k] = `(dịch lỗi: ${String(ex?.message || ex).slice(0, 60)})`;
      }
    }
    out[u.id] = old[k];
  }
  if (cachePath) await fs.writeFile(cachePath, JSON.stringify(old, null, 1), "utf8");
  return out;
}

// ---------- HTML ----------

const CSS = `
:root{--bg:#14161a;--fg:#e6e6e6;--dim:#8b93a1;--line:#2a2f38;--card:#1b1f26;
      --susp:#3a2a12;--suspb:#8a5a1a;--pick:#2563eb}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);
     font:14px/1.5 ui-sans-serif,system-ui,"Noto Sans SC","Microsoft YaHei",sans-serif}
header{position:sticky;top:0;z-index:9;background:#0f1114;border-bottom:1px solid var(--line);
       padding:10px 16px;display:flex;gap:14px;align-items:center;flex-wrap:wrap}
h1{font-size:15px;margin:0;font-weight:600}
button,select{background:#232833;color:var(--fg);border:1px solid var(--line);
              border-radius:6px;padding:5px 10px;font-size:13px;cursor:pointer}
button:hover{background:#2d3441}
button.pri{background:var(--pick);border-color:var(--pick)}
.stat{color:var(--dim);font-size:12px}
main{padding:14px;max-width:1500px;margin:0 auto}
.row{background:var(--card);border:1px solid var(--line);border-left:3px solid transparent;
     border-radius:8px;padding:10px 12px;margin-bottom:10px;display:grid;
     grid-template-columns:minmax(0,1fr) 340px;gap:14px}
.row.susp{border-left-color:var(--suspb);background:var(--susp)}
.row.done{border-left-color:#3f9e57}
.row.cl{grid-template-columns:minmax(0,1fr) 340px;background:#181d24}
.hd{display:flex;gap:10px;align-items:baseline;flex-wrap:wrap;margin-bottom:6px}
.id{font-weight:700;font-size:15px}
.t{color:var(--dim);font-size:12px;font-variant-numeric:tabular-nums}
.badge{font-size:11px;padding:1px 7px;border-radius:99px;border:1px solid var(--line);color:var(--dim)}
.zh{font-size:16px;margin:6px 0 2px;line-height:1.6}
.vi{font-size:13.5px;color:#9fd0a8;margin:0 0 8px;line-height:1.5}
.au{display:flex;align-items:center;gap:8px;margin:0 0 8px}
.au audio{height:32px;flex:1;max-width:420px}
.au .hint{color:var(--dim);font-size:11px}
.thumbs{display:flex;gap:6px;flex-wrap:wrap}
.thumbs figure{margin:0}
.thumbs img{display:block;border-radius:5px;border:1px solid var(--line);width:230px;height:auto}
.thumbs figcaption{color:var(--dim);font-size:10px;text-align:center;margin-top:2px}
table.ch{width:100%;border-collapse:collapse;font-size:12.5px;margin-bottom:8px}
table.ch td{padding:3px 6px;border-bottom:1px solid var(--line);vertical-align:top}
table.ch td:first-child{color:var(--dim);width:62px}
table.ch tr.fin td{border-bottom:2px solid var(--line);font-size:13.5px}
table.ch tr.fin td.finv b{color:#7fd67f}
table.ch tr.fin td.finv.auto b{color:var(--fg,#ddd)}
.disagree{color:#f0a04b;font-weight:600}
.zhname{color:var(--dim);font-size:11px;font-weight:400;margin-left:3px}
.why{color:var(--dim);font-size:11.5px;font-style:italic;margin-bottom:8px}
.picks{display:flex;gap:5px;flex-wrap:wrap}
.picks label{border:1px solid var(--line);border-radius:6px;padding:3px 9px;cursor:pointer;font-size:12.5px}
.picks input{display:none}
.picks label:has(input:checked){background:var(--pick);border-color:var(--pick)}
.note{width:100%;margin-top:6px;background:#12151a;color:var(--fg);border:1px solid var(--line);
      border-radius:6px;padding:5px 8px;font-size:12.5px}
.epttl{margin:22px 0 10px;font-size:16px;font-weight:600;border-bottom:1px solid var(--line);padding-bottom:6px}
.sub{margin:16px 0 8px;font-size:13px;color:var(--dim);text-transform:uppercase;letter-spacing:.06em}
.lv{font-size:11px;padding:1px 8px;border-radius:99px;color:#fff}
.nc{display:none;margin-top:8px;padding:8px 10px;border:1px dashed var(--line);border-radius:6px;background:#12151a}
.row.newpick .nc{display:block}
.nc label{display:block;font-size:11px;color:var(--dim);margin:5px 0 2px}
.nc input,.nc select{width:100%;background:#0e1116;color:var(--fg);border:1px solid var(--line);
      border-radius:5px;padding:4px 7px;font-size:12.5px}
.trm{display:grid;grid-template-columns:160px minmax(0,1fr) 80px;gap:12px;align-items:center;
      padding:7px 10px;border-bottom:1px solid var(--line)}
.trm .tzh{font-size:15px}
.trm input[type=text]{width:100%;background:#12151a;color:var(--fg);border:1px solid var(--line);
      border-radius:5px;padding:4px 8px;font-size:13px}
.trm .dr{font-size:11.5px;color:var(--dim);cursor:pointer;user-select:none}
.trm.dropped{opacity:.35}
.sp{display:none;grid-column:1/-1;margin-top:4px;padding:10px 12px;border:1px dashed #c0392b;border-radius:8px;background:#12151a}
.row.splitpick .sp{display:block}
.sp .spt{font-size:12.5px;color:var(--dim);margin-bottom:6px}
.sp .who{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px}
.sp .who label{border:1px solid var(--line);border-radius:6px;padding:3px 9px;cursor:pointer;font-size:12.5px}
.sp .who label:has(input:checked){background:#7a2e22;border-color:#c0392b}
.spl{display:grid;grid-template-columns:130px minmax(0,1fr) 300px;gap:10px;align-items:center;
     padding:7px 4px;border-top:1px solid var(--line)}
.spl.hov{background:#1b2330}
.spl img{width:130px;border-radius:5px;border:1px solid var(--line);display:block}
.spl .vi{margin:2px 0 4px}
.spl audio{height:28px;width:100%;max-width:360px}
.sppicks{display:flex;gap:5px;flex-wrap:wrap}
.sppicks label{border:1px solid var(--line);border-radius:6px;padding:3px 9px;cursor:pointer;font-size:12.5px}
.sppicks label.off{display:none}
.sppicks input{display:none}
.sppicks label:has(input:checked){background:var(--pick);border-color:var(--pick)}
.guess{font-size:11px;color:#f0a04b}
.thumbs img.scene,.spl img.scene{cursor:zoom-in}
.thumbs img.scene:hover{border-color:var(--pick)}
#vbox{position:fixed;inset:0;z-index:20;background:rgba(0,0,0,.82);display:flex;flex-direction:column;
      align-items:center;justify-content:center;gap:8px;padding:16px}
#vbox[hidden]{display:none}
.row[hidden]{display:none}
.cut{display:none;grid-column:1/-1;margin-top:4px;padding:10px 12px;border:1px dashed #c0392b;border-radius:8px;background:#12151a}
.row.cutpick .cut{display:block}
.cut .hint{font-size:12px;color:var(--dim);margin-bottom:8px}
.ctext{font-size:22px;line-height:1.9;margin-bottom:10px;display:flex;flex-wrap:wrap;align-items:center}
.ctext .gap{display:inline-block;width:9px;height:1.5em;cursor:col-resize;border-radius:3px}
.ctext .gap:hover{background:#3a4150}
.ctext .gap.on{background:#c0392b;width:4px;margin:0 3px}
.cpart{display:grid;grid-template-columns:34px minmax(0,1fr) 150px 220px;gap:8px;align-items:center;padding:4px 0;border-top:1px solid var(--line)}
.cpart .ctx{font-size:15px}
.cpart input{width:90px;background:#0c0e12;color:inherit;border:1px solid var(--line);border-radius:4px;padding:3px 5px}
.cpart input.bad,.cpart select.bad{border-color:#c0392b}
.cpart select{background:#0c0e12;color:inherit;border:1px solid var(--line);border-radius:4px;padding:3px 5px;width:100%}
.cpart button{cursor:pointer}
#vbox video{max-width:min(96vw,1100px);max-height:80vh;border-radius:8px;background:#000}
#vbox .cap{color:var(--dim);font-size:12.5px;text-align:center}
.trm.dropped input[type=text]{text-decoration:line-through}
`;

const PAGE_JS = String.raw`
const KEY='zhvi-spk-'+document.body.dataset.sig;
let store=JSON.parse(localStorage.getItem(KEY)||'{}');
function save(){localStorage.setItem(KEY,JSON.stringify(store));paint()}
// Dòng "chốt" = người mà câu này SẼ dùng nếu nộp bây giờ: câu tự chọn > cụm đã chốt > máy (LLM).
// Cùng thứ tự applySpeakers áp nhãn, nên câu không bấm gì vẫn thấy mình đang theo ai.
function finOf(r){const s=store[r.dataset.key]||{};
  if(s.v)return [s.v,s.guess?'máy điền sẵn — chưa bấm':'bạn chọn câu này'];
  const c=(store[r.dataset.ep+'|S:'+r.dataset.spk]||{}).v;
  if(c==='nhiều người')return ['','cụm '+r.dataset.spk+' đang chia — chọn người cho câu này'];
  if(c==='__new__')return ['','cụm '+r.dataset.spk+' → người mới'];
  if(c)return [c,'theo cụm '+r.dataset.spk+' bạn đã chốt'];
  return [r.dataset.auto,'máy (LLM), chưa ai xem'];}
function paintFin(r){const td=r.querySelector('.finv');if(!td)return;
  const s=store[r.dataset.key]||{};
  if(s.v==='nhiều người'&&r.querySelector('.cut')&&(s.cut?.at||[]).length){const ps=cutParts(r),ok=ps.every(p=>p.ok&&p.who);
    td.innerHTML='<b>'+ps.map(p=>p.who||'?').join(' | ')+'</b> <span class="zhname">'+(ok?'bạn cắt '+ps.length+' mảnh':'cắt chưa xong — thiếu mốc/người')+'</span>';
    td.className='finv'+(ok?'':' auto');return}
  const [v,src]=finOf(r);
  const i=v&&[...document.getElementsByName(r.dataset.key)].find(x=>x.value===v);
  const name=i?i.nextElementSibling.innerHTML:(v?v.replace(/</g,'&lt;'):'—');
  td.innerHTML='<b>'+name+'</b> <span class="zhname">'+src+'</span>';
  td.className='finv'+(src.startsWith('máy (')?' auto':'')}
function paint(){
  document.querySelectorAll('.row[data-kind=line]').forEach(paintFin);
  let done=0,tot=0,sd=0,st=0;
  document.querySelectorAll('.row').forEach(r=>{
    tot++;if(r.dataset.susp==='1')st++;
    const k=r.dataset.key,ok=store[k]&&store[k].v;
    if(ok){done++;if(r.dataset.susp==='1')sd++;r.classList.add('done')}else r.classList.remove('done');
  });
  document.getElementById('prog').textContent=done+'/'+tot+' đã chốt · cần soi '+sd+'/'+st;
}
function onPick(e){const r=e.target.closest('.row'),k=r.dataset.key;
  store[k]=Object.assign({},store[k],{v:e.target.value,guess:false});
  r.classList.toggle('newpick',e.target.value==='__new__');
  if(r.dataset.kind==='line'){r.classList.toggle('cutpick',e.target.value==='nhiều người'&&!!r.querySelector('.cut'));renderCut(r)}
  if(r.dataset.kind==='cluster'){r.classList.toggle('splitpick',e.target.value==='nhiều người');
    if(e.target.value==='nhiều người')prefill(r)}
  syncLine(k);save()}
// ---- chia cụm: "nhiều người" ở một cụm = chọn 2–3 người rồi gán từng câu ----
// Câu trong phần chia dùng CHUNG khoá với hàng câu ở mục 2, nên chọn ở đâu cũng là một.
function chosen(r){return [...r.querySelectorAll('.spw:checked')].map(i=>i.value)}
function borrow(r){r.querySelectorAll('.spl').forEach(l=>{
  const src=document.querySelector('.row[data-key="'+CSS.escape(l.dataset.k)+'"]');if(!src)return;
  const a=l.querySelector('audio'),sa=src.querySelector('audio'),i=l.querySelector('img'),
    im=src.querySelectorAll('.thumbs img');
  if(sa&&!a.src)a.src=sa.src;
  if(im.length&&!i.src){const m=im[Math.floor(im.length/2)];i.src=m.src;
    if(m.classList.contains('scene')){i.className='scene';Object.assign(i.dataset,m.dataset)}}})}
// ---- bấm ảnh = xem đúng đoạn video quanh câu đó ----
// Video KHÔNG nhúng vào trang (như trang duyệt bible): phát thẳng video.mp4 gốc. Mở bằng
// file:// thì đi đường dẫn tương đối, mở qua UI thì /media/…
function srcOf(el){const rel=el.dataset.rel||'',repo=el.dataset.repo||'';
  if(location.protocol==='file:'||!repo)return rel;
  return '/media/'+repo.split('/').map(encodeURIComponent).join('/')}
function playScene(img){
  const box=document.getElementById('vbox'),v=box.querySelector('video'),
    a=Number(img.dataset.a||0),b=Number(img.dataset.b||0),src=srcOf(img);
  document.querySelectorAll('audio').forEach(o=>o.pause());
  box.querySelector('.cap').textContent=(img.dataset.cap||'')+' · '+a.toFixed(1)+'–'+b.toFixed(1)+'s · Esc / bấm nền để đóng';
  v.dataset.b=b;v.src=src+'#t='+a.toFixed(2)+','+b.toFixed(2);box.hidden=false;v.play().catch(()=>{})}
// ---- cắt tay câu nhiều người: cut = {at:[vị trí ký tự], t:{vị trí: mốc người sửa}, who:{vị trí đầu mảnh: tên}}
function cutOf(k){const c=(store[k]||{}).cut||{};return {at:c.at||[],t:c.t||{},who:c.who||{}}}
function cutParts(r){const c=r.querySelector('.cut'),st=cutOf(r.dataset.key),zh=c.dataset.zh,
  w=JSON.parse(c.dataset.w||'{}'),t0=+c.dataset.t0,t1=+c.dataset.t1,at=[...st.at].sort((a,b)=>a-b),b=[0,...at,zh.length];
  const ps=[];for(let p=0;p<b.length-1;p++){const i=b[p],tv=p?(st.t[i]!==undefined?st.t[i]:w[i]):t0;
    ps.push({i,text:zh.slice(i,b[p+1]),start:tv===undefined||tv===''?null:Number(tv),who:st.who[i]||'',auto:p&&st.t[i]===undefined&&w[i]!==undefined})}
  ps.forEach((p,k)=>{p.end=k+1<ps.length?ps[k+1].start:t1;
    p.ok=p.start!==null&&(k===0||(p.start>ps[k-1].start&&p.start<t1))});
  return ps}
function renderCut(r){const c=r.querySelector('.cut');if(!c||!r.classList.contains('cutpick'))return;
  const st=cutOf(r.dataset.key),zh=c.dataset.zh,e=s=>s.replace(/&/g,'&amp;').replace(/</g,'&lt;');
  let h='';for(let i=0;i<zh.length;i++){if(i)h+='<span class="gap'+(st.at.includes(i)?' on':'')+'" data-i="'+i+'" title="cắt ở đây"></span>';h+='<span>'+e(zh[i])+'</span>'}
  c.querySelector('.ctext').innerHTML=h;
  const tpl=c.querySelector('.cwho-tpl').innerHTML,ps=cutParts(r);
  c.querySelector('.cparts').innerHTML=ps.length<2?'':ps.map((p,k)=>'<div class="cpart" data-i="'+p.i+'">'
    +'<button class="scene" data-rel="'+e(c.dataset.rel)+'" data-repo="'+e(c.dataset.repo)+'" data-a="'+(p.start??0)+'" data-b="'+(p.end??c.dataset.t1)
    +'" data-cap="'+e(c.dataset.cap)+' mảnh '+(k+1)+'"'+(p.start===null||p.end===null?' disabled':'')+'>▶</button>'
    +'<span class="ctx">'+e(p.text)+'</span>'
    +'<span>'+(k?'từ <input class="cst'+(p.ok?'':' bad')+'" type="number" step="0.05" value="'+(p.start??'')+'">s'+(p.auto?' <span class="zhname">ASR</span>':''):'từ '+p.start+'s')+'</span>'
    +'<select class="cwho'+(p.who?'':' bad')+'">'+tpl+'</select></div>').join('');
  c.querySelectorAll('.cpart').forEach((d,k)=>{d.querySelector('select').value=ps[k].who})}
function onCut(e){const r=e.target.closest('.row'),k=r.dataset.key,st=cutOf(k);
  if(e.target.classList.contains('gap')){const i=+e.target.dataset.i;
    st.at=st.at.includes(i)?st.at.filter(x=>x!==i):[...st.at,i];if(!st.at.includes(i)){delete st.t[i];delete st.who[i]}}
  else if(e.target.classList.contains('cst'))st.t[e.target.closest('.cpart').dataset.i]=e.target.value;
  else if(e.target.classList.contains('cwho'))st.who[e.target.closest('.cpart').dataset.i]=e.target.value;
  else return;
  store[k]=Object.assign({},store[k],{cut:st});save();renderCut(r)}
function closeScene(){const box=document.getElementById('vbox'),v=box.querySelector('video');
  v.pause();v.removeAttribute('src');v.load();box.hidden=true}
function narrow(r){const ws=chosen(r);borrow(r);
  r.querySelectorAll('.sppicks label').forEach(l=>{const v=l.dataset.v;
    l.classList.toggle('off',v!=='không rõ'&&!ws.includes(v))})}
function prefill(r){const ws=chosen(r);
  r.querySelectorAll('.spl').forEach(l=>{const k=l.dataset.k,g=l.dataset.guess;
    if(!(store[k]&&store[k].v)&&g&&ws.includes(g))store[k]={v:g,guess:true};syncLine(k)});
  narrow(r);save()}
function syncLine(k){const v=(store[k]||{}).v,g=(store[k]||{}).guess;
  document.getElementsByName(k).forEach(i=>i.checked=i.value===v);
  document.getElementsByName('sp|'+k).forEach(i=>i.checked=i.value===v);
  document.querySelectorAll('.spl').forEach(l=>{if(l.dataset.k!==k)return;
    const b=l.querySelector('.guess');if(b)b.hidden=!g})}
function onSpw(e){const r=e.target.closest('.row'),k=r.dataset.key;
  store[k]=Object.assign({},store[k],{who:chosen(r)});prefill(r)}
function onSpr(e){const k=e.target.closest('.spl').dataset.k;
  store[k]=Object.assign({},store[k],{v:e.target.value,guess:false});syncLine(k);save()}
function onNc(e){const r=e.target.closest('.row'),k=r.dataset.key;
  const nc=Object.assign({},(store[k]||{}).nc);nc[e.target.dataset.f]=e.target.value;
  store[k]=Object.assign({},store[k],{nc:nc});localStorage.setItem(KEY,JSON.stringify(store))}
function onTerm(e){const t=e.target.closest('.trm'),k=t.dataset.k;
  const cur=Object.assign({},store[k]);
  if(e.target.classList.contains('tdr')){cur.drop=e.target.checked;t.classList.toggle('dropped',e.target.checked)}
  else cur.vi=e.target.value;
  store[k]=cur;localStorage.setItem(KEY,JSON.stringify(store))}
function onNote(e){const k=e.target.closest('.row').dataset.key;
  store[k]=Object.assign({},store[k],{note:e.target.value});
  localStorage.setItem(KEY,JSON.stringify(store))}
function applyFilter(){const f=document.getElementById('filt').value;
  document.querySelectorAll('.row').forEach(r=>{
    const s=r.dataset.susp==='1',d=r.classList.contains('done'),c=r.dataset.kind==='cluster';
    r.hidden=(f==='susp'&&!s&&!c)||(f==='todo'&&d)||(f==='suspTodo'&&((!s&&!c)||d))||(f==='cl'&&!c);
  })}
function exportJson(){
  const eps={};
  document.querySelectorAll('.row').forEach(r=>{
    const s=store[r.dataset.key]||{};if(!s.v&&!s.note)return;
    const e=eps[r.dataset.ep]=eps[r.dataset.ep]||{clusters:{},lines:{},notes:{}};
    const lid=r.dataset.sk?'@'+r.dataset.sk:r.dataset.id;
    // câu đã cắt tay đủ (mốc hợp lệ + mỗi mảnh có người): xuất nhát cắt, mỗi mảnh là một nhãn người chốt
    if(r.dataset.kind==='line'&&s.v==='nhiều người'&&r.querySelector('.cut')&&(s.cut?.at||[]).length){
      const ps=cutParts(r);
      if(ps.every(p=>p.ok&&p.who)){e.cuts=e.cuts||{};
        e.cuts[r.dataset.sk]={zh:r.querySelector('.cut').dataset.zh,parts:ps.map(p=>({start:p.start,text:p.text,who:p.who}))};
        ps.forEach((p,k)=>e.lines['@'+r.dataset.sk+'/'+k]=p.who);
        if(s.note)e.notes['@'+r.dataset.sk]=s.note;return}
      (e.cutBad=e.cutBad||[]).push('#'+r.dataset.id)}
    if(s.v&&s.v!=='__new__'){if(r.dataset.kind==='cluster')e.clusters[r.dataset.spk]=s.v;else e.lines[lid]=s.v}
    // máy điền sẵn mà người không bấm lại: vẫn dùng để dịch, nhưng không đủ tin để làm mẫu giọng
    if(s.guess&&r.dataset.kind!=='cluster')(e.guessed=e.guessed||[]).push(lid);
    if(s.note)e.notes[r.dataset.kind==='cluster'?'S:'+r.dataset.spk:(r.dataset.sk?'@'+r.dataset.sk:'#'+r.dataset.id)]=s.note;
  });
  const ep0=function(x){return eps[x]=eps[x]||{clusters:{},lines:{},notes:{}}};
  // nhân vật người duyệt khai mới: cụm trỏ thẳng vào tên sắp tạo, applyExport tạo TRƯỚC rồi
  // mới ghi nhãn, nếu không B5 tra bible không thấy
  document.querySelectorAll('.row.cl').forEach(r=>{
    const s=store[r.dataset.key]||{};
    if(s.v!=='__new__'||!s.nc||!(s.nc.vi||'').trim())return;
    const e=ep0(r.dataset.ep);e.newCast=e.newCast||[];
    const zh=(s.nc.zh||'').trim()||s.nc.vi.trim();
    e.newCast.push({spk:r.dataset.spk,zh:zh,vi:s.nc.vi.trim(),
      gender:s.nc.gender||'?',note:s.nc.note||''});
    e.clusters[r.dataset.spk]=zh;
  });
  // thuật ngữ: KHÔNG sửa gì = đồng ý với máy, nên xuất cả hàng chưa đụng tới
  document.querySelectorAll('.trm').forEach(t=>{
    const s=store[t.dataset.k]||{},e=ep0(t.dataset.ep);
    e.terms=e.terms||{};e.termsDropped=e.termsDropped||[];
    if(s.drop)e.termsDropped.push(t.dataset.zh);
    else e.terms[t.dataset.zh]=(s.vi!==undefined?s.vi:t.dataset.vi);
  });
  const bad=Object.values(eps).flatMap(e=>{const x=e.cutBad||[];delete e.cutBad;return x});
  if(bad.length&&!confirm('Câu cắt chưa xong (thiếu mốc/người nói hoặc mốc không tăng dần): '+bad.join(' ')
    +'\nCác câu này sẽ xuất là «nhiều người» (không cắt). Vẫn xuất?'))return;
  const b=new Blob([JSON.stringify({by:'fleex',eps:eps},null,1)],{type:'application/json'});
  const a=document.createElement('a');a.href=URL.createObjectURL(b);
  a.download='speaker-review.json';a.click();
}
function resetAll(){if(confirm('Xoá hết phán quyết đã lưu?')){store={};save();
  document.querySelectorAll('.picks input').forEach(i=>i.checked=false)}}
document.addEventListener('DOMContentLoaded',()=>{
  document.querySelectorAll('.picks input').forEach(i=>{
    const r=i.closest('.row'),k=r.dataset.key;
    if(store[k]&&store[k].v===i.value){i.checked=true;
      if(i.value==='__new__')r.classList.add('newpick')}
    i.addEventListener('change',onPick)});
  document.querySelectorAll('.row.cl').forEach(r=>{
    const s=store[r.dataset.key]||{};
    if(s.who)r.querySelectorAll('.spw').forEach(i=>i.checked=s.who.includes(i.value));
    r.querySelectorAll('.spw').forEach(i=>i.addEventListener('change',onSpw));
    if(s.v==='nhiều người'){r.classList.add('splitpick');narrow(r)}});
  document.querySelectorAll('.spl').forEach(l=>{syncLine(l.dataset.k);
    l.querySelectorAll('.spr').forEach(i=>i.addEventListener('change',onSpr))});
  document.querySelectorAll('.ncf').forEach(f=>{
    const k=f.closest('.row').dataset.key,nc=(store[k]||{}).nc;
    if(nc&&nc[f.dataset.f]!==undefined)f.value=nc[f.dataset.f];
    f.addEventListener('input',onNc);f.addEventListener('change',onNc)});
  document.querySelectorAll('.trm').forEach(t=>{
    const s=store[t.dataset.k]||{};
    if(s.vi!==undefined)t.querySelector('.tvi').value=s.vi;
    if(s.drop){t.querySelector('.tdr').checked=true;t.classList.add('dropped')}
    t.querySelector('.tvi').addEventListener('input',onTerm);
    t.querySelector('.tdr').addEventListener('change',onTerm)});
  document.querySelectorAll('.note').forEach(n=>{
    const k=n.closest('.row').dataset.key;
    if(store[k]&&store[k].note)n.value=store[k].note;
    n.addEventListener('input',onNote)});
  // chỉ một câu phát tại một thời điểm — nghe chồng nhau thì vô nghĩa
  const auds=[...document.querySelectorAll('audio')];
  auds.forEach(a=>a.addEventListener('play',()=>auds.forEach(o=>{if(o!==a)o.pause()})));
  const vb=document.getElementById('vbox'),vv=vb.querySelector('video');
  // timeupdate chỉ bắn ~4 lần/giây -> lố tới 0,25s, đủ nghe sang câu kế. Soi theo từng khung hình.
  const stopAt=()=>{const b=Number(vv.dataset.b||0);if(vv.paused)return;
    if(b&&vv.currentTime>=b){vv.pause();return}requestAnimationFrame(stopAt)};
  vv.addEventListener('play',()=>requestAnimationFrame(stopAt));
  vv.addEventListener('error',()=>{if(vv.getAttribute('src'))vb.querySelector('.cap').textContent='không mở được '+vv.getAttribute('src')});
  vb.addEventListener('click',e=>{if(e.target===vb)closeScene()});
  document.addEventListener('click',e=>{const i=e.target.closest('img.scene,button.scene');if(i)playScene(i)});
  // bộ cắt tay: khe (click), mốc (gõ xong mới vẽ lại, không thì mất con trỏ), người nói
  document.addEventListener('click',e=>{if(e.target.classList.contains('gap'))onCut(e)});
  document.addEventListener('change',e=>{if(e.target.classList.contains('cst')||e.target.classList.contains('cwho'))onCut(e)});
  // khoá câu cũ "ep|#id" -> "ep|@sk" (v2): id đánh lại khi có câu bị cắt, sk thì không
  let mig=false;document.querySelectorAll('.row[data-kind=line]').forEach(r=>{if(!r.dataset.sk)return;
    const o=r.dataset.ep+'|#'+r.dataset.id;if(store[o]&&!store[r.dataset.key]){store[r.dataset.key]=store[o];mig=true}});
  if(mig){Object.keys(store).forEach(k=>{if(k.includes('|#'))delete store[k]});localStorage.setItem(KEY,JSON.stringify(store))}
  document.querySelectorAll('.row[data-kind=line]').forEach(r=>{if((store[r.dataset.key]||{}).v==='nhiều người'&&r.querySelector('.cut')){r.classList.add('cutpick');renderCut(r)}});
  // Space phát câu đang trỏ chuột, khỏi phải rê tới nút play từng câu
  let hov=null,hovL=null;
  document.querySelectorAll('.row').forEach(r=>r.addEventListener('mouseenter',()=>hov=r));
  document.querySelectorAll('.spl').forEach(l=>{
    l.addEventListener('mouseenter',()=>{hovL=l;l.classList.add('hov')});
    l.addEventListener('mouseleave',()=>{if(hovL===l)hovL=null;l.classList.remove('hov')})});
  document.addEventListener('keydown',e=>{
    if(!vb.hidden){if(e.code==='Escape')closeScene();return}
    if(/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName))return;
    // trong phần chia cụm: 1..9 chọn người thứ n đang hiện, Space phát đúng câu đó
    if(hovL&&/^Digit[1-9]$/.test(e.code)){
      const ls=[...hovL.querySelectorAll('.sppicks label:not(.off) input')],i=ls[+e.code.slice(5)-1];
      if(i){e.preventDefault();i.checked=true;i.dispatchEvent(new Event('change'))}return}
    if(e.code!=='Space')return;
    const box=hovL||hov;if(!box)return;
    const a=box.querySelector('audio');if(!a)return;e.preventDefault();
    if(a.paused){a.currentTime=0;a.play()}else a.pause()});
  document.getElementById('filt').addEventListener('change',applyFilter);
  document.getElementById('exp').addEventListener('click',exportJson);
  document.getElementById('rst').addEventListener('click',resetAll);
  paint();
});
`;

const esc = (s) => (s === null || s === undefined ? "—" : String(s))
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Hiện tên Việt cho người đọc, giữ tên Hán nhỏ bên cạnh vì dữ liệu khoá theo tên Hán. */
function lbl(bib, zh) {
  if (!zh) return "—";
  if (zh in NA) return NA[zh];
  for (const c of bib.cast) {
    if (c.zh === zh || (c.alias || []).includes(zh)) {
      return `${esc(c.vi || c.zh)} <span class="zhname">${esc(c.zh)}</span>`;
    }
  }
  return esc(zh);
}

function picks(bib, key, { withNew = false } = {}) {
  const opts = [...bib.cast.map((c) => c.zh), ...SPECIAL];
  const rows = opts.map((o) =>
    `<label><input type="radio" name="${esc(key)}" value="${esc(o)}">`
    + `<span>${o === "nhiều người" && withNew ? "nhiều người — chia cụm" : SPECIAL.includes(o) ? esc(o) : lbl(bib, o)}</span></label>`).join("");
  // Không có nút này thì máy bỏ sót một nhân vật là ngõ cụt: trang chỉ cho chọn trong
  // bible.cast, mà bible chỉ lớn thêm được từ chính chỗ này.
  return withNew
    ? rows + `<label><input type="radio" name="${esc(key)}" value="${NEWC}"><span>+ người mới…</span></label>`
    : rows;
}

/** Ô khai nhân vật mới cho một cụm. Tên chữ Hán CHỌN từ thoại, vì người duyệt không gõ được. */
function newCastForm(key, cands, vi) {
  const opt = (t) => {
    const line = vi[t.line?.id] || "";
    return `<option value="${esc(t.zh)}">${esc(t.zh)} · ${t.count} lần`
      + `${line ? ` · ${esc(line.slice(0, 40))}` : ""}</option>`;
  };
  return `<div class="nc">
  <label>Tên tiếng Việt (bắt buộc)</label>
  <input class="ncf" data-f="vi" placeholder="vd. Cố Ngôn">
  <label>Tên chữ Hán — chọn từ tên được GỌI trong tập này</label>
  <select class="ncf" data-f="zh">
    <option value="">— không có (khoá sẽ lấy tên tiếng Việt) —</option>
    ${cands.map(opt).join("")}
  </select>
  <label>Giới tính</label>
  <select class="ncf" data-f="gender">
    <option value="?">chưa rõ</option><option value="male">nam</option><option value="female">nữ</option>
  </select>
  <label>Ghi chú (ai của ai, vai gì)</label>
  <input class="ncf" data-f="note" placeholder="vd. em gái nữ chính">
</div>`;
}

/** Thuật ngữ pass B vừa gặp mà bible chưa có. Không sửa gì = đồng ý với máy. */
function termRows(ep, newTerms, bib) {
  const rows = Object.entries(newTerms || {}).filter(([zh]) => !(zh in bib.terms));
  if (!rows.length) return "";
  return `<div class="sub">Thuật ngữ mới (${rows.length}) — nạp vào bible dùng chung cả bộ</div>`
    + rows.map(([zh, vi]) => `<div class="trm" data-k="T:${esc(ep)}|${esc(zh)}" data-ep="${esc(ep)}"
     data-zh="${esc(zh)}" data-vi="${esc(vi)}">
  <div class="tzh">${esc(zh)}</div>
  <div><input type="text" class="tvi" value="${esc(vi)}"></div>
  <div><label class="dr"><input type="checkbox" class="tdr"> bỏ</label></div>
</div>`).join("");
}

// v2 khoá câu bằng `sk` (ổn định khi người cắt câu làm id đánh lại); v1 không có sk -> khoá theo id
const lineKey = (ep, u) => (u.sk != null ? `${ep}|@${u.sk}` : `${ep}|#${u.id}`);

/**
 * Bộ cắt tay cho câu nhiều người (chỉ v2: cần \`sk\`). Người cắt là bản cuối — không gửi LLM
 * xác nhận. Mốc điền sẵn chỉ ở đúng ranh giới từ ASR (\`at\`); ngoài đó người tự đặt.
 */
function cutPanel(bib, u, at, vref) {
  if (u.sk == null || !vref) return "";
  const opts = [...bib.cast.map((c) => c.zh), "không rõ"]
    .map((o) => `<option value="${esc(o)}">${o === "không rõ" ? o : esc(bib.cast.find((c) => c.zh === o)?.vi || "") + " " + esc(o)}</option>`).join("");
  const q = (x) => esc(x).replace(/"/g, "&quot;"); // esc không thoát dấu nháy, mà JSON đầy nháy
  return `<div class="cut" data-zh="${q(u.zh)}" data-t0="${u.start}" data-t1="${u.end}" data-w="${q(JSON.stringify(at || {}))}"
    data-rel="${q(vref.rel)}" data-repo="${q(vref.repo)}" data-cap="#${u.id}">
  <div class="hint">Câu có nhiều người: bấm vào <b>khe giữa hai chữ</b> để cắt (bấm lại để bỏ). Mỗi mảnh chọn người nói;
    mốc điền sẵn từ ASR khi khe trùng ranh giới từ, ▶ để nghe/xem đúng mảnh đó rồi chỉnh mốc nếu lệch.</div>
  <div class="ctext"></div><div class="cparts"></div>
  <select class="cwho-tpl" hidden><option value="">— ai nói —</option>${opts}</select>
</div>`;
}

const cidName = (bib, cid) => bib.cast.find((c) => c.id === cid)?.zh ?? null;

/**
 * Phần chia cụm của một cụm lẫn người: chọn 2–3 người, rồi mỗi câu một cú bấm.
 *
 * Gợi ý điền sẵn CHỈ lấy từ cờ của lượt gộp series (LLM đọc cả bộ). Code không tự xếp ưu tiên
 * các kênh (hình, tên cụm) để đoán thay — câu LLM không nhắc thì để trống cho người chọn.
 * Câu máy kém chắc nhất lên đầu: người soát nghe hết cũng được, bỏ dở giữa chừng thì phần đã
 * nghe là phần đáng nghe nhất.
 */
function splitPanel(ep, spk, c, utts, vi, bib, llm = null) {
  // theo cụm GIỌNG (zhvi2 dời câu lệch sang cụm người khác nhưng giữ `asrSpeaker`)
  const mine = utts.filter((u) => (u.asrSpeaker ?? u.speaker) === spk);
  if (!mine.length) return "";
  const own = cidName(bib, c.cid);
  const inCast = (zh) => (bib.cast.some((x) => x.zh === zh) ? zh : null);
  const guessOf = (u) => {
    const a = c.asr?.lines?.[String(u.id)];
    // Chỉ điền sẵn đúng thứ LLM đã nói. Code KHÔNG tự xếp ưu tiên các kênh để đoán thay —
    // câu LLM không nhắc thì để trống cho người nghe rồi chọn.
    if (a) return [cidName(bib, a), "máy gộp series", 0];
    const l = llm?.[String(u.id)];
    // zhvi2: phán quyết từng câu của task hiểu tập; câu khác chủ cụm lên đầu
    if (l && inCast(l.who)) return [l.who, l.by === "cụm" ? "LLM · theo tên cụm" : "LLM", l.who === own ? 1 : 0];
    return [null, "", 2];
  };
  const rows = mine.map((u) => ({ u, g: guessOf(u) })).sort((a, b) => a.g[2] - b.g[2] || a.u.id - b.u.id);
  // người khoanh sẵn: chủ cụm + mọi người mà ít nhất một kênh gọi tên trong cụm này
  const def = new Set([own, ...rows.map((r) => r.g[0])].filter(Boolean));
  const who = bib.cast.map((x) => `<label><input type="checkbox" class="spw" value="${esc(x.zh)}"${def.has(x.zh) ? " checked" : ""}>`
    + ` ${lbl(bib, x.zh)}</label>`).join("");
  const opts = [...bib.cast.map((x) => x.zh), "không rõ"];
  const line = ({ u, g }) => {
    const k = lineKey(ep, u);
    // ảnh + tiếng KHÔNG nhúng lại: mục 2 đã có đủ, trang mở phần chia thì mượn sang (JS).
    // Nhúng hai lần là nhân đôi trang (đo ở 飞鸟炮灰 tập 1: 4,5 MB -> 7,0 MB).
    return `<div class="spl" data-k="${esc(k)}" data-guess="${esc(g[0] || "")}">
  <div><img alt=""></div>
  <div><div class="hd"><span class="id">#${u.id}</span><span class="t">${u.start}–${u.end}s</span>
    <span class="guess" hidden>máy đoán · ${esc(g[1])}</span></div>
    <div class="vi">${esc(vi[u.id] || u.zh)}</div>
    <audio controls preload="none"></audio></div>
  <div class="sppicks">${opts.map((o) => `<label data-v="${esc(o)}"><input type="radio" class="spr" name="sp|${esc(k)}" value="${esc(o)}">`
    + `<span>${o === "không rõ" ? "không rõ" : lbl(bib, o)}</span></label>`).join("")}</div>
</div>`;
  };
  return `<div class="sp">
  <div class="spt">Cụm này có mấy người? Tích đúng những người nói trong cụm — mỗi câu bên dưới chỉ còn chọn giữa họ.
    Rê chuột lên câu: <b>Space</b> nghe, <b>1/2/3</b> chọn. Máy đã điền sẵn chỗ nó đoán được; sai thì bấm lại.</div>
  <div class="who">${who}</div>
  ${rows.map(line).join("")}
</div>`;
}

/**
 * Chỗ phát video.mp4 của tập, ghi hai đường như trang duyệt bible: tương đối từ file trang
 * (mở bằng file://) và từ gốc repo (UI phục vụ /media/…). Không có video thì ảnh không bấm được.
 */
async function videoRef(video, out) {
  if (!video) return null;
  try {
    await fs.access(video);
  } catch {
    return null;
  }
  const slash = (p) => p.split(path.sep).join("/");
  const repo = slash(path.relative(process.cwd(), path.resolve(video)));
  return {
    rel: slash(path.relative(path.dirname(path.resolve(out)), path.resolve(video))),
    repo: repo.startsWith("..") ? "" : repo,
  };
}

/**
 * Thuộc tính cho ảnh bấm-để-xem: đúng câu đó, dư 0,2s mỗi đầu nhưng không lấn sang câu bên
 * cạnh. Từng đệm 1s: câu #92 của ai-qing tập 1 kéo theo «怕了吧？» của người khác cách 0,48s,
 * người soát tưởng câu gộp hai người.
 */
const PAD = 0.2;
function scene(vref, u, cap, prev, next) {
  if (!vref || !u) return "";
  const a = Math.max(0, u.start - PAD, Math.min(u.start, prev?.end ?? 0));
  const b = Math.min(u.end + PAD, Math.max(u.end, next?.start ?? Infinity));
  return ` class="scene" data-rel="${esc(vref.rel)}" data-repo="${esc(vref.repo)}"`
    + ` data-a="${a.toFixed(2)}" data-b="${b.toFixed(2)}"`
    + ` data-cap="${esc(cap)}" title="bấm để xem đoạn video"`;
}

function renderEp(ep, d, bib, vref = null) {
  const { utts, align: al, media: med, vi, cands = [] } = d;
  // láng giềng theo THỜI GIAN (không theo id): đoạn phát của một câu dừng trước câu kế
  const byTime = [...utts].sort((x, y) => x.start - y.start);
  const near = new Map(byTime.map((u, k) => [u.id, [byTime[k - 1], byTime[k + 1]]]));
  const sceneOf = (u, cap) => scene(vref, u, cap, ...(near.get(u?.id) || []));
  const byId = new Map(utts.map((u) => [u.id, u]));
  const vis = al.vision || {};
  const cc = al.clusters || {};
  const susp = al.suspects || {};
  const vlines = vis.lines || {};

  const h = [
    `<h2 class="epttl">Tập ${esc(ep)} — ${utts.length} câu, ${Object.keys(cc).length} cụm giọng, `
    + `${Object.keys(susp).length} câu cần soi</h2>`,
    termRows(ep, al.newTerms, bib),
    '<div class="sub">1. Đặt tên cụm — sửa ở đây là sửa cả cụm cùng lúc</div>',
  ];

  for (const [spk, c] of Object.entries(cc).sort((a, b) => (b[1].size || 0) - (a[1].size || 0))) {
    const [lv, col] = LEVEL[c.level] || ["?", "#666"];
    const key = `${ep}|S:${spk}`;
    const ex = utts.filter((u) => u.speaker === spk).slice(0, 3);
    const probed = (c.probed || []).filter((i) => i in med).map((i) => {
      const th = med[i].thumbs[Math.floor(med[i].thumbs.length / 2)];
      const pred = (vlines[String(i)] || vlines[i] || {}).pred;
      return `<figure><img src="data:image/jpeg;base64,${th}" loading="lazy"${sceneOf(byId.get(Number(i)), `#${i}`)}>`
        + `<figcaption>#${i} · ${esc(pred)}</figcaption></figure>`;
    }).join("");

    h.push(`
<div class="row cl" data-key="${esc(key)}" data-ep="${esc(ep)}" data-kind="cluster"
     data-spk="${esc(spk)}" data-susp="0">
  <div>
    <div class="hd"><span class="id">cụm ${esc(spk)}</span>
      <span class="badge">${c.size || 0} câu</span>
      <span class="lv" style="background:${col}">${lv}</span></div>
    <div class="why">${esc(c.why)}</div>
    <div class="thumbs">${probed}</div>
    <div class="vi">${esc(ex.map((u) => u.zh.slice(0, 28)).join(" / "))}</div>
  </div>
  <div>
    <table class="ch">
      <tr><td>máy chốt</td><td><b>${lbl(bib, cidName(bib, c.cid))}</b></td></tr>
      <tr><td>text</td><td>${lbl(bib, cidName(bib, c.text))}
          ${c.textVerified ? '<span class="badge">có trích dẫn</span>' : ""}</td></tr>
      <tr><td>hình</td><td>${lbl(bib, cidName(bib, c.vision))}
          <span class="zhname">${esc(c.votes ? JSON.stringify(c.votes) : null)}</span></td></tr>
      <tr><td>vocative</td><td>${c.veto?.length ? esc(c.veto.map((x) => cidName(bib, x) || x).join(", ")) : "—"}</td></tr>
    </table>
    <div class="picks">${picks(bib, key, { withNew: true })}</div>
    ${newCastForm(key, cands, vi)}
    <input class="note" placeholder="ghi chú…">
  </div>
  ${splitPanel(ep, spk, c, utts, vi, bib, al.llm)}
</div>`);
  }

  h.push('<div class="sub">2. Từng câu — chỉ cần soi câu được đánh dấu</div>');
  for (const u of utts) {
    const i = u.id;
    const c = cc[u.speaker] || {};
    const base = cidName(bib, c.cid);
    const vp = vlines[String(i)] || vlines[i] || {};
    // zhvi2: tách GIỌNG (cụm ASR gốc) khỏi LLM — gộp làm một ô thì câu LLM đã dời cụm trông như
    // giọng và chữ đồng ý (ai-qing tập 1: 24 câu lệch chỉ lộ ở dòng chữ cam)
    const asrSpk = u.asrSpeaker ?? u.speaker;
    const ac = cc[asrSpk] || {};
    const voice = cidName(bib, ac.cid);
    const lj = al.llm?.[String(i)];
    const who = lj ? lj.who : base;
    const why = susp[String(i)];
    const key = lineKey(ep, u);
    const thumbs = med[i].thumbs.map((t, k) =>
      `<figure><img src="data:image/jpeg;base64,${t}" loading="lazy"${sceneOf(u, `#${i}`)}>`
      + `<figcaption>${med[i].times[k]}s</figcaption></figure>`).join("");
    const dis = vp.pred && !(vp.pred in NA) && vp.pred !== who ? ' class="disagree"' : "";
    const ldis = lj && lj.who !== voice ? ' class="disagree"' : "";
    const verdict = lj
      ? `<tr><td>giọng</td><td>cụm ${esc(asrSpk)} → ${lbl(bib, voice)}</td></tr>
      <tr><td>LLM</td><td${ldis}><b>${lbl(bib, lj.who)}</b>${lj.by === "cụm" ? ' <span class="zhname">theo tên cụm</span>' : ""}</td></tr>`
      : `<tr><td>theo cụm</td><td><b>${lbl(bib, base)}</b></td></tr>`;

    h.push(`
<div class="row${why ? " susp" : ""}" data-key="${esc(key)}" data-ep="${esc(ep)}"
     data-kind="line" data-id="${i}" data-sk="${esc(u.sk ?? "")}" data-susp="${why ? 1 : 0}" data-spk="${esc(u.speaker)}" data-auto="${esc(who || "")}">
  <div>
    <div class="hd"><span class="id">#${i}</span>
      <span class="t">${u.start}–${u.end}s</span>
      <span class="badge">cụm ${esc(asrSpk)} · ${ac.size || 0} câu</span>
      ${why ? `<span class="badge" style="color:#f0a04b;border-color:#8a5a1a">${esc(why.join("; "))}</span>` : ""}
    </div>
    <div class="zh">${esc(u.zh)}</div>
    <div class="vi">${esc(vi[i] || "")}</div>
    <div class="au"><audio controls preload="none" src="data:audio/mpeg;base64,${med[i].clip}"></audio>
      <span class="hint">${(u.end - u.start).toFixed(1)}s · phím <b>Space</b> phát câu đang trỏ</span></div>
    <div class="thumbs">${thumbs}</div>
  </div>
  <div>
    <table class="ch">
      <tr class="fin"><td>chốt</td><td class="finv"></td></tr>
      ${verdict}
      <tr><td>hình</td><td${dis}>${vp.pred !== undefined ? lbl(bib, vp.pred) : "<i>chưa hỏi</i>"}</td></tr>
    </table>
    <div class="why">${lj?.why ? "LLM: " + esc(lj.why) + "<br>" : ""}${vp.why ? "hình: " + esc(vp.why) : ""}</div>
    <div class="picks">${picks(bib, key)}</div>
    <input class="note" placeholder="ghi chú…">
  </div>
  ${cutPanel(bib, u, d.words?.[i], vref)}
</div>`);
  }
  return h.join("\n");
}

export async function build(eps, bib, out, { log = null, sigPrefix = "" } = {}) {
  const parts = [];
  for (const [ep, d] of Object.entries(eps)) parts.push(renderEp(ep, d, bib, await videoRef(d.video, out)));
  const body = parts.join("");
  // sigPrefix: zhvi2 đánh số câu khác v1 -> khoá localStorage riêng, không để phán quyết của trang này điền nhầm trang kia
  const sig = sigPrefix + Object.keys(eps).sort().join("-");
  const title = bib.series?.vi || bib.series?.zh || "";
  const html = `<!doctype html><html lang="vi"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Soát người nói — ${esc(title)}</title>
<style>${CSS}</style></head><body data-sig="${esc(sig)}">
<header>
  <h1>Soát người nói</h1>
  <select id="filt">
    <option value="susp">cụm + câu cần soi</option>
    <option value="all">tất cả</option>
    <option value="cl">chỉ cụm</option>
    <option value="todo">chưa chốt</option>
    <option value="suspTodo">cần soi &amp; chưa chốt</option>
  </select>
  <span class="stat" id="prog"></span>
  <button class="pri" id="exp">Xuất JSON</button>
  <button id="rst">Xoá hết</button>
  <span class="stat">lưu tự động trong trình duyệt · chốt CỤM trước, câu lẻ sau</span>
</header>
<main>${body}</main>
<div id="vbox" hidden><video controls playsinline preload="metadata"></video><div class="cap"></div></div>
<script>${PAGE_JS}</script></body></html>`;
  await fs.mkdir(path.dirname(path.resolve(out)), { recursive: true });
  await fs.writeFile(out, html, "utf8");
  const { size } = await fs.stat(out);
  log?.info?.(`${(size / 1e6).toFixed(1)} MB -> ${out}`);
  return out;
}

/**
 * Dựng trang soát cho một tập từ trạng thái pipeline đã có.
 * `ctx` là thứ `runPipeline({stopAfter:"B"})` trả về.
 */
export async function buildReview(ctx, { out = null, thumbs = 3, noRoughVi = false } = {}) {
  if (!ctx.video || !ctx.bible) throw new Error("dựng trang soát cần video + bible");
  const dir = ctx.outDir;
  const med = await media(ctx.video, ctx.utts, path.join(dir, "media.json"), { n: thumbs, log: ctx.log });
  const vi = noRoughVi ? {} : await roughVi(ctx.llm, ctx.utts, ctx.bible, path.join(dir, "rough_vi.json"));
  const key = ctx.ep ?? path.basename(dir.replace(/\/+$/, ""));
  // Tên được GỌI trong tập mà bible chưa có — để người duyệt CHỌN khi khai nhân vật mới,
  // vì họ không gõ được chữ Hán. Thuần regex, không tốn lượt LLM nào.
  const known = ctx.bible.cast.flatMap((c) => [c.zh, c.vi, c.viShort, ...(c.alias || [])])
    .concat(Object.keys(ctx.bible.terms || {}));
  const cands = vocativeNames([{ ep: key, utts: ctx.utts }], known);
  return build({ [key]: { utts: ctx.utts, align: ctx.align, media: med, vi, cands, video: ctx.video } },
    ctx.bible, out || path.join(dir, "review.html"), { log: ctx.log });
}

/**
 * Đường về: chuẩn hoá file trình duyệt xuất ra thành series/<slug>/ep<N>.speakers.json.
 *
 * Tách làm hai bước (xuất rồi nạp) chứ không cho trang tự ghi, vì trang chạy bằng
 * file:// nên không có đường nào ghi thẳng vào repo — và như vậy cũng còn dấu vết.
 */
export async function applyExport(file, seriesDir, ep = null, { log = null, labelsName = (e) => `ep${e}.speakers.json` } = {}) {
  const d = JSON.parse(await fs.readFile(file, "utf8"));
  const eps = d.eps || { [ep]: d };
  const now = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  const by = d.by || "fleex";
  const biblePath = path.join(seriesDir, "bible.json");
  const bib = await readJson(biblePath);
  const written = [];
  let grown = false;

  for (const [e, v] of Object.entries(eps)) {
    // Bible lớn thêm TRƯỚC khi ghi nhãn: nhãn cụm trỏ vào tên nhân vật vừa khai, mà B5 tra
    // tên đó trong bible — tạo sau thì lần chạy tới cụm ấy lại thành "không khớp".
    const wants = (v.newCast || []).length || Object.keys(v.terms || {}).length;
    if (wants && !bib) log?.warn?.(`tập ${e}: có đề xuất cho bible nhưng ${biblePath} không đọc được`);
    if (wants && bib) {
      const r = BIBLE.extend(bib, { cast: v.newCast || [], terms: v.terms || {} }, { by, ep: e });
      for (const c of r.added.cast) log?.info?.(`[bible] + nhân vật ${c.id} ${c.vi} (${c.zh}) — tập ${e}`);
      for (const t of r.added.terms) log?.info?.(`[bible] + thuật ngữ ${t} — tập ${e}`);
      for (const w of r.skipped) log?.warn?.(`[bible] bỏ qua: ${w}`);
      grown ||= r.added.cast.length > 0 || r.added.terms.length > 0;
    }

    const dst = path.join(seriesDir, labelsName(e));
    const old = (await readJson(dst)) || {};
    // cắt tay (v2): lần xuất mới thắng. Cắt lại -> bỏ nhãn các mảnh cũ; bỏ cắt (câu lại mang
    // nhãn thường) -> bỏ nhát cắt cũ.
    const cuts = { ...(old.cuts || {}), ...(v.cuts || {}) };
    const oldLines = { ...(old.lines || {}) };
    for (const sk of Object.keys(v.cuts || {})) {
      for (const k of Object.keys(oldLines)) if (k === "@" + sk || k.startsWith(`@${sk}/`)) delete oldLines[k];
    }
    for (const k of Object.keys(v.lines || {})) if (k.startsWith("@") && !(k.slice(1) in (v.cuts || {}))) delete cuts[k.slice(1)];
    const out = {
      ep: e, reviewedBy: by, at: now,
      clusters: { ...(old.clusters || {}), ...(v.clusters || {}) },
      lines: { ...oldLines, ...(v.lines || {}) },
      ...(Object.keys(cuts).length ? { cuts } : {}),
      notes: { ...(old.notes || {}), ...(v.notes || {}) },
      // câu nhận nguyên gợi ý của máy ở phần chia cụm; câu người bấm lại ở lần xuất sau thì rút ra
      guessed: [...new Set([...(old.guessed || []).filter((i) => !(i in (v.lines || {})) || (v.guessed || []).includes(i)),
        ...(v.guessed || [])])].map(String),
      // Mục đã trả lời — kể cả trả lời là BỎ. Không ghi lại thì cổng hỏi mãi một thứ.
      terms: { ...(old.terms || {}), ...(v.terms || {}) },
      termsDropped: [...new Set([...(old.termsDropped || []), ...(v.termsDropped || [])])],
    };
    await fs.writeFile(dst, JSON.stringify(out, null, 1), "utf8");
    written.push(`${dst} (${Object.keys(out.clusters).length} cụm, ${Object.keys(out.lines).length} câu`
      + `, ${Object.keys(out.terms).length + out.termsDropped.length} thuật ngữ đã quyết)`);
  }

  if (grown) {
    await fs.copyFile(biblePath, biblePath + ".prev");
    const v = await BIBLE.save(bib, biblePath);
    log?.info?.(`[bible] ${biblePath} -> version ${v} (${bib.cast.length} nhân vật, `
      + `${Object.keys(bib.terms).length} thuật ngữ); bản cũ ở .prev`);
  }
  written.forEach((w) => log?.info?.("[+] " + w));
  return written;
}
