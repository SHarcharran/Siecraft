/* SieCraft name sign builder: runs the cutout engine off the main thread. */
importScripts("/js/lib/jsts.min.js", "/js/lib/opentype.min.js", "/js/namesign-engine.js");
const loaded = {};
function font(id, file) {
  if (!loaded[id]) loaded[id] = fetch("/fonts/namesign/" + file).then(r => { if (!r.ok) throw new Error("font"); return r.arrayBuffer(); })
    .then(b => SieName.addFont(id, b)).catch(e => { delete loaded[id]; throw e; });
  return loaded[id];
}
let pending = null, busy = false;
onmessage = e => { if (e.data.preload) { font(e.data.preload.id, e.data.preload.file).catch(() => {}); return; } pending = e.data; if (!busy) next(); };
async function next() {
  if (!pending) return;
  const m = pending; pending = null; busy = true;
  let out;
  try {
    await font(m.font, m.file);
    const t = Date.now();
    const r = SieName.design({ text: m.text, font: m.font, width: m.width, stock: m.stock, bar: m.bar });
    out = { id: m.id, ok: r.ok, errors: r.errors, notes: r.notes, ms: Date.now() - t };
    if (r.geom) Object.assign(out, { d: SieName.pathD(r), width: r.width, height: r.height, cap: r.capHeight });
    if (r.ok && m.dxf) out.dxf = SieName.makeDXF(r);
  } catch (err) {
    out = { id: m.id, ok: false, errors: ["Something went wrong building the preview. Try again."], notes: [], debug: String(err && err.message || err) };
  }
  postMessage(out); busy = false;
  if (pending) next();
}
