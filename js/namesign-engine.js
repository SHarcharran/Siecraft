/* SieCraft name-cutout engine v1 (Nov 17, 2026).
   Text -> one connected wood piece, cut on the CNC with an end mill. Needs globals `jsts` and `opentype`.
   What you see is what gets cut: the preview is the shape AFTER the end mill's radius is applied.
   Units: inches. Origin: lower-left of the piece. */
(function (root) {
"use strict";

// Per-thickness rules. Adjust after real test cuts.
const STOCK = {
  "1/4": { label: '1/4" Baltic birch', toolDia: 0.125, minWidth: 0.18 },
  "1/2": { label: '1/2" Baltic birch', toolDia: 0.125, minWidth: 0.20 },
  "3/4": { label: '3/4" birch',        toolDia: 0.25,  minWidth: 0.30 },
};
const RULES = {
  flatten_tol: 0.002,     // curve chord error (in)
  thin_area: 0.008,       // a thinner-than-minWidth region bigger than this (sq in, ~0.09in square) = fragile part; smaller = harmless sliver
  max_bridge: 0.75,       // farthest a loose piece (i-dot, accent) may be from the body to get a bridge (in)
  max_height: 23.0,       // bed limit (in)
  max_chars: 16,
  min_cap_height: 1.0,    // smallest capital letter allowed (in): below this, names stop reading at wall distance
};
class CutError extends Error {}

let J, GF, AT, UU, DOp;
function initGeo() {
  if (GF) return;
  J = root.jsts; GF = new J.geom.GeometryFactory(); AT = J.geom.util.AffineTransformation;
  UU = J.operation.union.UnaryUnionOp; DOp = J.operation.distance.DistanceOp;
}
const C = (x, y) => new J.geom.Coordinate(x, y);
function polygon(pts) { const cs = pts.map(p => C(p[0], p[1])); cs.push(C(pts[0][0], pts[0][1])); return GF.createPolygon(GF.createLinearRing(cs)); }
const empty = () => GF.createPolygon();
function union(arr) { arr = arr.filter(g => g && !g.isEmpty()); if (!arr.length) return empty(); if (arr.length === 1) return arr[0]; return UU.union(GF.createGeometryCollection(arr)); }
const affine = (g, a, b, d, e, xo, yo) => new AT(a, b, xo, d, e, yo).transform(g);
function bounds(g) { const e = g.getEnvelopeInternal(); return [e.getMinX(), e.getMinY(), e.getMaxX(), e.getMaxY()]; }
function polysOf(g) { if (!g || g.isEmpty()) return []; if (g.getGeometryType() === "Polygon") return [g]; const o = []; for (let i = 0; i < g.getNumGeometries(); i++) o.push(...polysOf(g.getGeometryN(i))); return o; }
function ringXY(r) { return r.getCoordinates().map(c => [c.x, c.y]); }
function interiors(p) { const r = []; for (let i = 0; i < p.getNumInteriorRing(); i++) r.push(p.getInteriorRingN(i)); return r; }

// ------------------------------------------------------------ fonts
const fontBytes = {}, fonts = {};
function addFont(id, arrayBuffer) { fontBytes[id] = arrayBuffer; delete fonts[id]; }
function getFont(id) {
  if (fonts[id]) return fonts[id];
  if (!fontBytes[id]) throw new CutError("font isn't loaded yet");
  const f = root.opentype.parse(fontBytes[id]);
  return (fonts[id] = { f, upem: f.unitsPerEm, cap: (f.tables.os2 && f.tables.os2.sCapHeight) || f.unitsPerEm * 0.7 });
}
function flattenRings(cmds, tol) {
  const rings = []; let cur = [];
  const close = () => { if (cur.length) rings.push(cur); cur = []; };
  for (const c of cmds) {
    if (c.type === "M") { close(); cur = [[c.x, c.y]]; }
    else if (c.type === "L") cur.push([c.x, c.y]);
    else if (c.type === "Q") { const p0 = cur[cur.length - 1]; const d = Math.hypot(p0[0] - 2 * c.x1 + c.x, p0[1] - 2 * c.y1 + c.y);
      const n = Math.max(2, Math.ceil(Math.sqrt(d / (4 * tol)))); for (let i = 1; i <= n; i++) { const t = i / n, u = 1 - t; cur.push([u * u * p0[0] + 2 * u * t * c.x1 + t * t * c.x, u * u * p0[1] + 2 * u * t * c.y1 + t * t * c.y]); } }
    else if (c.type === "C") { const p0 = cur[cur.length - 1]; const d = Math.max(Math.hypot(p0[0] - 2 * c.x1 + c.x2, p0[1] - 2 * c.y1 + c.y2), Math.hypot(c.x1 - 2 * c.x2 + c.x, c.y1 - 2 * c.y2 + c.y));
      const n = Math.max(2, Math.ceil(Math.sqrt(3 * d / (4 * tol)))); for (let i = 1; i <= n; i++) { const t = i / n, u = 1 - t; cur.push([u ** 3 * p0[0] + 3 * u * u * t * c.x1 + 3 * u * t * t * c.x2 + t ** 3 * c.x, u ** 3 * p0[1] + 3 * u * u * t * c.y1 + 3 * u * t * t * c.y2 + t ** 3 * c.y]); } }
    else if (c.type === "Z") close();
  }
  close(); return rings;
}
function ringArea(r) { let a = 0; for (let i = 0; i < r.length; i++) { const p = r[i], q = r[(i + 1) % r.length]; a += p[0] * q[1] - q[0] * p[1]; } return a / 2; }
function glyphGeom(f, glyph, tolUnits) {
  // Each contour is filled even-odd within the glyph (fonts mix contour directions); overlaps were removed in the font.
  const rings = flattenRings(glyph.path.commands, tolUnits).filter(r => r.length > 2);
  rings.sort((a, b) => Math.abs(ringArea(b)) - Math.abs(ringArea(a)));
  let g = empty();
  for (const r of rings) g = g.symDifference(polygon(r).buffer(0));
  return g;
}

// Lay text out in font units (baseline y=0). Returns {glyphs:[geom], width, cap} in font units.
function layout(fontId, text, trackingEm) {
  const F = getFont(fontId), f = F.f;
  for (const ch of Array.from(text)) {
    if (ch !== " " && f.charToGlyphIndex(ch) === 0) {
      throw new CutError(`"${ch}" isn't in this font. Use letters, numbers, spaces, & ' - .`);
    }
  }
  let gl;
  try { gl = f.stringToGlyphs(text); }
  catch (e) { gl = Array.from(text).map(ch => f.charToGlyph(ch)); }   // font has a feature opentype.js can't run: plain glyphs
  const tol = RULES.flatten_tol * F.cap / 2.5;   // ~0.002in at a 2.5in capital; refined by scale later
  let x = 0; const out = [];
  for (let i = 0; i < gl.length; i++) {
    const g = glyphGeom(f, gl[i], tol);
    if (!g.isEmpty()) out.push(affine(g, 1, 0, 0, 1, x, 0));
    let adv = gl[i].advanceWidth || 0;
    if (i + 1 < gl.length) adv += f.getKerningValue(gl[i], gl[i + 1]) || 0;
    x += adv + trackingEm * F.upem;
  }
  return { glyphs: out, cap: F.cap, upem: F.upem };
}

// Bridge loose pieces to the main body: dots/accents (small pieces, short gap) and letters that
// almost touch (tiny gap). Separate words or wide letter gaps need the underline bar instead.
function bridgeAll(g, width, capIn, notes) {
  let parts = polysOf(g).sort((a, b) => b.getArea() - a.getArea());
  if (parts.length <= 1) return g;
  let body = parts[0], loose = parts.slice(1), bridged = 0;
  for (let guard = 0; loose.length && guard < 60; guard++) {
    let best = null;
    for (const p of loose) { const d = body.distance(p); if (!best || d < best.d) best = { p, d }; }
    const small = best.p.getArea() < 0.04 * body.getArea();
    const okGap = small ? 0.45 * capIn : 0.18 * capIn;
    if (best.d > okGap) {
      throw new CutError(small
        ? "A dot or accent sits too far from its letter to join safely. Turn on the underline bar or pick another font."
        : "Some letters or words don't touch, so the sign would fall apart. Turn on the underline bar, or pick a connected script font.");
    }
    const pts = DOp.nearestPoints(body, best.p);
    const br = GF.createLineString([pts[0], pts[1]]).buffer(width / 2 * 1.15, 8);
    body = polysOf(union([body, best.p, br])).sort((a, b) => b.getArea() - a.getArea())[0];
    loose = loose.filter(q => q !== best.p);
    bridged++;
  }
  if (bridged) notes.push(`${bridged} small bridge${bridged > 1 ? "s" : ""} join${bridged > 1 ? "" : "s"} loose dots or letters to the sign.`);
  return body;
}

// Region of `g` thinner than `w` (morphological opening), worst piece area.
function thinWorst(g, w) {
  const h = w / 2;
  const opened = g.buffer(-h, 8).buffer(h, 8);
  if (g.getArea() - opened.getArea() <= RULES.thin_area * 0.5) return 0;
  return Math.max(0, ...polysOf(g.difference(opened)).map(p => p.getArea()));
}

/* design({text, font, width, stock, bar, fontMeta}) -> {ok, errors, notes, geom, width, height}
   fontMeta: {tracking (em), connected (bool), bar (bool default for font)} */
function design(o) {
  initGeo();
  const notes = [];
  const stock = STOCK[o.stock] || STOCK["1/4"];
  const text = String(o.text || "").normalize("NFC").replace(/\s+/g, " ").trim();
  if (!text) return { ok: false, errors: ["Type a name."], notes };
  if (Array.from(text).length > RULES.max_chars) return { ok: false, errors: [`Keep it to ${RULES.max_chars} characters or fewer.`], notes };
  if (!/^[\p{L}\p{M}0-9 &'’.\-]+$/u.test(text)) return { ok: false, errors: ["Use letters, numbers, spaces, & ' - . only."], notes };
  const W = Number(o.width);
  let lay;
  try { lay = layout(o.font, text, (o.fontMeta && o.fontMeta.tracking) || 0); }
  catch (e) { if (e instanceof CutError) return { ok: false, errors: [e.message], notes }; throw e; }
  if (!lay.glyphs.length) return { ok: false, errors: ["Type a name."], notes };

  let raw = union(lay.glyphs);
  const bar = !!o.bar;
  if (bar) {
    // underline bar through the bottom of the letters, end to end
    const [x0, , x1] = bounds(raw);
    const bh = lay.cap * 0.16, pad = lay.cap * 0.06;
    raw = union([raw, polygon([[x0 - pad, -bh * 0.55], [x1 + pad, -bh * 0.55], [x1 + pad, bh * 0.45], [x0 - pad, bh * 0.45]])]);
  }
  // scale font units -> inches so the finished piece is exactly W wide (after the grow step below)
  const tool = stock.toolDia / 2, minW = stock.minWidth;
  let [bx0, by0, bx1, by1] = bounds(raw);
  // grow amount: half the min width at most, only as much as the font needs
  let grow = 0, geom = null, scaleIn = 0, errors = [], stepNotes = [];
  // Try the font as drawn; if anything is too thin, thicken every stroke by half the minimum width
  // (that guarantees every part is at least minWidth wide) and check again.
  for (const g of [0, minW / 4, minW / 2]) {
    scaleIn = (W - 2 * g) / (bx1 - bx0);
    if (!(scaleIn > 0)) continue;
    stepNotes = [];
    let s = affine(raw, scaleIn, 0, 0, scaleIn, -bx0 * scaleIn, -by0 * scaleIn);
    if (g > 0) s = s.buffer(g, 8);
    try { s = bridgeAll(s, minW, lay.cap * scaleIn, stepNotes); }
    catch (e) { if (e instanceof CutError) { errors = [e.message]; geom = null; break; } throw e; }
    // what the end mill actually produces: inside corners round to the tool radius, slots narrower than the tool fill in
    s = s.buffer(tool, 8).buffer(-tool, 8);
    s = polysOf(s).sort((a, b) => b.getArea() - a.getArea())[0];
    geom = s; grow = g;
    if (thinWorst(s, minW) <= RULES.thin_area) { errors = []; break; }
    errors = ["Parts of the letters are too thin to cut safely at this size. Try a bigger size, a bolder font, or the underline bar."];
  }
  notes.push(...stepNotes);
  if (!geom) return { ok: false, errors, notes };
  // final bridge pass notes (re-run on final scale to report)
  const capIn = lay.cap * scaleIn;
  // normalize to origin
  let [gx0, gy0, gx1, gy1] = bounds(geom);
  geom = affine(geom, 1, 0, 0, 1, -gx0, -gy0);
  const width = gx1 - gx0, height = gy1 - gy0;
  if (polysOf(geom).length !== 1) errors.push("The sign isn't one connected piece.");
  if (height > RULES.max_height) errors.push(`At this width the sign would be ${height.toFixed(1)}in tall, more than our 23in machine limit.`);
  if (capIn < RULES.min_cap_height) errors.push(`Capital letters would only be ${capIn.toFixed(2)}in tall. Pick a bigger size or a shorter name.`);
  const holes = polysOf(geom).reduce((n, p) => n + p.getNumInteriorRing(), 0);
  if (grow > 0) notes.push(`Strokes thickened ${(grow * 2).toFixed(2)}in so thin parts won't snap.`);
  return { ok: errors.length === 0, errors, notes, geom, width, height, capHeight: capIn, holes, stock: o.stock, toolDia: stock.toolDia };
}

// ------------------------------------------------------------ output
const fmt = x => { let s = (Math.round(x * 1e5) / 1e5).toString(); if (!/[.e]/.test(s)) s += ".0"; return s; };
function makeDXF(res, template) {
  if (!res || !res.ok) throw new Error("refusing to write a cut file that failed the rules");
  const out = []; let h = 0x1000;
  const ring = (coords) => {
    const pts = coords.slice(0, -1);
    const body = [" 90", String(pts.length), " 70", "1"];
    for (const [x, y] of pts) body.push(" 10", fmt(x), " 20", fmt(y));
    out.push("  0", "LWPOLYLINE", "  5", (h++).toString(16).toUpperCase(), "330", "17", "100", "AcDbEntity", "  8", "PROFILE_CUT", "100", "AcDbPolyline", ...body);
  };
  for (const p of polysOf(res.geom)) { ring(ringXY(p.getExteriorRing())); for (const it of interiors(p)) ring(ringXY(it)); }
  let t = template.replace("ENTITIES\n  0\nENDSEC", "ENTITIES\n" + out.join("\n") + "\n  0\nENDSEC");
  return t.replace(/\$HANDSEED\n  5\n[0-9A-Fa-f]+\n/, "$HANDSEED\n  5\n" + h.toString(16).toUpperCase() + "\n");
}
// SVG path data (y flipped), inches.
function pathD(res) {
  const H = res.height; let s = "";
  for (const p of polysOf(res.geom)) for (const r of [p.getExteriorRing(), ...interiors(p)]) {
    const c = ringXY(r); s += "M" + c.slice(0, -1).map(([x, y]) => x.toFixed(4) + " " + (H - y).toFixed(4)).join("L") + "Z";
  }
  return s;
}

const DXF_TEMPLATE = "  0\nSECTION\n  2\nHEADER\n  9\n$ACADVER\n  1\nAC1024\n  9\n$ACADMAINTVER\n 70\n6\n  9\n$DWGCODEPAGE\n  3\nANSI_1252\n  9\n$LASTSAVEDBY\n  1\nezdxf\n  9\n$INSBASE\n 10\n0.0\n 20\n0.0\n 30\n0.0\n  9\n$EXTMIN\n 10\n1e+20\n 20\n1e+20\n 30\n1e+20\n  9\n$EXTMAX\n 10\n-1e+20\n 20\n-1e+20\n 30\n-1e+20\n  9\n$LIMMIN\n 10\n0.0\n 20\n0.0\n  9\n$LIMMAX\n 10\n420.0\n 20\n297.0\n  9\n$ORTHOMODE\n 70\n0\n  9\n$REGENMODE\n 70\n1\n  9\n$FILLMODE\n 70\n1\n  9\n$QTEXTMODE\n 70\n0\n  9\n$MIRRTEXT\n 70\n1\n  9\n$LTSCALE\n 40\n1.0\n  9\n$ATTMODE\n 70\n1\n  9\n$TEXTSIZE\n 40\n2.5\n  9\n$TRACEWID\n 40\n1.0\n  9\n$TEXTSTYLE\n  7\nStandard\n  9\n$CLAYER\n  8\n0\n  9\n$CELTYPE\n  6\nByLayer\n  9\n$CECOLOR\n 62\n256\n  9\n$CELTSCALE\n 40\n1.0\n  9\n$DISPSILH\n 70\n0\n  9\n$DIMSCALE\n 40\n1.0\n  9\n$DIMASZ\n 40\n2.5\n  9\n$DIMEXO\n 40\n0.625\n  9\n$DIMDLI\n 40\n3.75\n  9\n$DIMRND\n 40\n0.0\n  9\n$DIMDLE\n 40\n0.0\n  9\n$DIMEXE\n 40\n1.25\n  9\n$DIMTP\n 40\n0.0\n  9\n$DIMTM\n 40\n0.0\n  9\n$DIMTXT\n 40\n2.5\n  9\n$DIMCEN\n 40\n2.5\n  9\n$DIMTSZ\n 40\n0.0\n  9\n$DIMTOL\n 70\n0\n  9\n$DIMLIM\n 70\n0\n  9\n$DIMTIH\n 70\n0\n  9\n$DIMTOH\n 70\n0\n  9\n$DIMSE1\n 70\n0\n  9\n$DIMSE2\n 70\n0\n  9\n$DIMTAD\n 70\n1\n  9\n$DIMZIN\n 70\n8\n  9\n$DIMBLK\n  1\n\n  9\n$DIMASO\n 70\n1\n  9\n$DIMSHO\n 70\n1\n  9\n$DIMPOST\n  1\n\n  9\n$DIMAPOST\n  1\n\n  9\n$DIMALT\n 70\n0\n  9\n$DIMALTD\n 70\n3\n  9\n$DIMALTF\n 40\n0.03937007874\n  9\n$DIMLFAC\n 40\n1.0\n  9\n$DIMTOFL\n 70\n1\n  9\n$DIMTVP\n 40\n0.0\n  9\n$DIMTIX\n 70\n0\n  9\n$DIMSOXD\n 70\n0\n  9\n$DIMSAH\n 70\n0\n  9\n$DIMBLK1\n  1\n\n  9\n$DIMBLK2\n  1\n\n  9\n$DIMSTYLE\n  2\nISO-25\n  9\n$DIMCLRD\n 70\n0\n  9\n$DIMCLRE\n 70\n0\n  9\n$DIMCLRT\n 70\n0\n  9\n$DIMTFAC\n 40\n1.0\n  9\n$DIMGAP\n 40\n0.625\n  9\n$DIMJUST\n 70\n0\n  9\n$DIMSD1\n 70\n0\n  9\n$DIMSD2\n 70\n0\n  9\n$DIMTOLJ\n 70\n0\n  9\n$DIMTZIN\n 70\n8\n  9\n$DIMALTZ\n 70\n0\n  9\n$DIMALTTZ\n 70\n0\n  9\n$DIMUPT\n 70\n0\n  9\n$DIMDEC\n 70\n2\n  9\n$DIMTDEC\n 70\n2\n  9\n$DIMALTU\n 70\n2\n  9\n$DIMALTTD\n 70\n3\n  9\n$DIMTXSTY\n  7\nStandard\n  9\n$DIMAUNIT\n 70\n0\n  9\n$DIMADEC\n 70\n0\n  9\n$DIMALTRND\n 40\n0.0\n  9\n$DIMAZIN\n 70\n0\n  9\n$DIMDSEP\n 70\n44\n  9\n$DIMATFIT\n 70\n3\n  9\n$DIMFRAC\n 70\n0\n  9\n$DIMLDRBLK\n  1\n\n  9\n$DIMLUNIT\n 70\n2\n  9\n$DIMLWD\n 70\n-2\n  9\n$DIMLWE\n 70\n-2\n  9\n$DIMTMOVE\n 70\n0\n  9\n$DIMFXL\n 40\n1.0\n  9\n$DIMFXLON\n 70\n0\n  9\n$DIMJOGANG\n 40\n0.785398163397\n  9\n$DIMTFILL\n 70\n0\n  9\n$DIMTFILLCLR\n 70\n0\n  9\n$DIMARCSYM\n 70\n0\n  9\n$DIMLTYPE\n  6\n\n  9\n$DIMLTEX1\n  6\n\n  9\n$DIMLTEX2\n  6\n\n  9\n$DIMTXTDIRECTION\n 70\n0\n  9\n$LUNITS\n 70\n2\n  9\n$LUPREC\n 70\n4\n  9\n$SKETCHINC\n 40\n1.0\n  9\n$FILLETRAD\n 40\n10.0\n  9\n$AUNITS\n 70\n0\n  9\n$AUPREC\n 70\n2\n  9\n$MENU\n  1\n.\n  9\n$ELEVATION\n 40\n0.0\n  9\n$PELEVATION\n 40\n0.0\n  9\n$THICKNESS\n 40\n0.0\n  9\n$LIMCHECK\n 70\n0\n  9\n$CHAMFERA\n 40\n0.0\n  9\n$CHAMFERB\n 40\n0.0\n  9\n$CHAMFERC\n 40\n0.0\n  9\n$CHAMFERD\n 40\n0.0\n  9\n$SKPOLY\n 70\n0\n  9\n$TDCREATE\n 40\n2461362.5789699075\n  9\n$TDUCREATE\n 40\n2458532.153996898\n  9\n$TDUPDATE\n 40\n2461362.5789699075\n  9\n$TDUUPDATE\n 40\n2458532.1544311\n  9\n$TDINDWG\n 40\n0.0\n  9\n$TDUSRTIMER\n 40\n0.0\n  9\n$USRTIMER\n 70\n1\n  9\n$ANGBASE\n 50\n0.0\n  9\n$ANGDIR\n 70\n0\n  9\n$PDMODE\n 70\n0\n  9\n$PDSIZE\n 40\n0.0\n  9\n$PLINEWID\n 40\n0.0\n  9\n$SPLFRAME\n 70\n0\n  9\n$SPLINETYPE\n 70\n6\n  9\n$SPLINESEGS\n 70\n8\n  9\n$HANDSEED\n  5\n38\n  9\n$SURFTAB1\n 70\n6\n  9\n$SURFTAB2\n 70\n6\n  9\n$SURFTYPE\n 70\n6\n  9\n$SURFU\n 70\n6\n  9\n$SURFV\n 70\n6\n  9\n$UCSBASE\n  2\n\n  9\n$UCSNAME\n  2\n\n  9\n$UCSORG\n 10\n0.0\n 20\n0.0\n 30\n0.0\n  9\n$UCSXDIR\n 10\n1.0\n 20\n0.0\n 30\n0.0\n  9\n$UCSYDIR\n 10\n0.0\n 20\n1.0\n 30\n0.0\n  9\n$UCSORTHOREF\n  2\n\n  9\n$UCSORTHOVIEW\n 70\n0\n  9\n$UCSORGTOP\n 10\n0.0\n 20\n0.0\n 30\n0.0\n  9\n$UCSORGBOTTOM\n 10\n0.0\n 20\n0.0\n 30\n0.0\n  9\n$UCSORGLEFT\n 10\n0.0\n 20\n0.0\n 30\n0.0\n  9\n$UCSORGRIGHT\n 10\n0.0\n 20\n0.0\n 30\n0.0\n  9\n$UCSORGFRONT\n 10\n0.0\n 20\n0.0\n 30\n0.0\n  9\n$UCSORGBACK\n 10\n0.0\n 20\n0.0\n 30\n0.0\n  9\n$PUCSBASE\n  2\n\n  9\n$PUCSNAME\n  2\n\n  9\n$PUCSORG\n 10\n0.0\n 20\n0.0\n 30\n0.0\n  9\n$PUCSXDIR\n 10\n1.0\n 20\n0.0\n 30\n0.0\n  9\n$PUCSYDIR\n 10\n0.0\n 20\n1.0\n 30\n0.0\n  9\n$PUCSORTHOREF\n  2\n\n  9\n$PUCSORTHOVIEW\n 70\n0\n  9\n$PUCSORGTOP\n 10\n0.0\n 20\n0.0\n 30\n0.0\n  9\n$PUCSORGBOTTOM\n 10\n0.0\n 20\n0.0\n 30\n0.0\n  9\n$PUCSORGLEFT\n 10\n0.0\n 20\n0.0\n 30\n0.0\n  9\n$PUCSORGRIGHT\n 10\n0.0\n 20\n0.0\n 30\n0.0\n  9\n$PUCSORGFRONT\n 10\n0.0\n 20\n0.0\n 30\n0.0\n  9\n$PUCSORGBACK\n 10\n0.0\n 20\n0.0\n 30\n0.0\n  9\n$USERI1\n 70\n0\n  9\n$USERI2\n 70\n0\n  9\n$USERI3\n 70\n0\n  9\n$USERI4\n 70\n0\n  9\n$USERI5\n 70\n0\n  9\n$USERR1\n 40\n0.0\n  9\n$USERR2\n 40\n0.0\n  9\n$USERR3\n 40\n0.0\n  9\n$USERR4\n 40\n0.0\n  9\n$USERR5\n 40\n0.0\n  9\n$WORLDVIEW\n 70\n1\n  9\n$SHADEDGE\n 70\n3\n  9\n$SHADEDIF\n 70\n70\n  9\n$TILEMODE\n 70\n1\n  9\n$MAXACTVP\n 70\n64\n  9\n$PINSBASE\n 10\n0.0\n 20\n0.0\n 30\n0.0\n  9\n$PLIMCHECK\n 70\n0\n  9\n$PEXTMIN\n 10\n1e+20\n 20\n1e+20\n 30\n1e+20\n  9\n$PEXTMAX\n 10\n-1e+20\n 20\n-1e+20\n 30\n-1e+20\n  9\n$PLIMMIN\n 10\n0.0\n 20\n0.0\n  9\n$PLIMMAX\n 10\n420.0\n 20\n297.0\n  9\n$UNITMODE\n 70\n0\n  9\n$VISRETAIN\n 70\n1\n  9\n$PLINEGEN\n 70\n0\n  9\n$PSLTSCALE\n 70\n1\n  9\n$TREEDEPTH\n 70\n3020\n  9\n$CMLSTYLE\n  2\nStandard\n  9\n$CMLJUST\n 70\n0\n  9\n$CMLSCALE\n 40\n20.0\n  9\n$PROXYGRAPHICS\n 70\n1\n  9\n$MEASUREMENT\n 70\n0\n  9\n$CELWEIGHT\n370\n-1\n  9\n$ENDCAPS\n280\n0\n  9\n$JOINSTYLE\n280\n0\n  9\n$LWDISPLAY\n290\n0\n  9\n$INSUNITS\n 70\n1\n  9\n$HYPERLINKBASE\n  1\n\n  9\n$STYLESHEET\n  1\n\n  9\n$XEDIT\n290\n1\n  9\n$CEPSNTYPE\n380\n0\n  9\n$PSTYLEMODE\n290\n1\n  9\n$FINGERPRINTGUID\n  2\n{6B9B42CA-964A-4335-8BC9-7B76D51CBB0A}\n  9\n$VERSIONGUID\n  2\n{CF2830BD-4F90-4B3F-8304-882485F6EFF3}\n  9\n$EXTNAMES\n290\n1\n  9\n$PSVPSCALE\n 40\n0.0\n  9\n$OLESTARTUP\n290\n0\n  9\n$SORTENTS\n280\n127\n  9\n$INDEXCTL\n280\n0\n  9\n$HIDETEXT\n280\n1\n  9\n$XCLIPFRAME\n280\n1\n  9\n$HALOGAP\n280\n0\n  9\n$OBSCOLOR\n 70\n257\n  9\n$OBSLTYPE\n280\n0\n  9\n$INTERSECTIONDISPLAY\n280\n0\n  9\n$INTERSECTIONCOLOR\n 70\n257\n  9\n$DIMASSOC\n280\n2\n  9\n$PROJECTNAME\n  1\n\n  9\n$CAMERADISPLAY\n290\n0\n  9\n$LENSLENGTH\n 40\n50.0\n  9\n$CAMERAHEIGHT\n 40\n0.0\n  9\n$STEPSPERSEC\n 40\n24.0\n  9\n$STEPSIZE\n 40\n100.0\n  9\n$3DDWFPREC\n 40\n2.0\n  9\n$PSOLWIDTH\n 40\n0.005\n  9\n$PSOLHEIGHT\n 40\n0.08\n  9\n$LOFTANG1\n 40\n1.570796326795\n  9\n$LOFTANG2\n 40\n1.570796326795\n  9\n$LOFTMAG1\n 40\n0.0\n  9\n$LOFTMAG2\n 40\n0.0\n  9\n$LOFTPARAM\n 70\n7\n  9\n$LOFTNORMALS\n280\n1\n  9\n$LATITUDE\n 40\n37.795\n  9\n$LONGITUDE\n 40\n-122.394\n  9\n$NORTHDIRECTION\n 40\n0.0\n  9\n$TIMEZONE\n 70\n-8000\n  9\n$LIGHTGLYPHDISPLAY\n280\n1\n  9\n$TILEMODELIGHTSYNCH\n280\n1\n  9\n$CMATERIAL\n347\n20\n  9\n$SOLIDHIST\n280\n0\n  9\n$SHOWHIST\n280\n1\n  9\n$DWFFRAME\n280\n2\n  9\n$DGNFRAME\n280\n2\n  9\n$REALWORLDSCALE\n290\n1\n  9\n$INTERFERECOLOR\n 62\n256\n  9\n$CSHADOW\n280\n0\n  9\n$SHADOWPLANELOCATION\n 40\n0.0\n  0\nENDSEC\n  0\nSECTION\n  2\nCLASSES\n  0\nCLASS\n  1\nACDBDICTIONARYWDFLT\n  2\nAcDbDictionaryWithDefault\n  3\nObjectDBX Classes\n 90\n0\n 91\n0\n280\n0\n281\n0\n  0\nCLASS\n  1\nSUN\n  2\nAcDbSun\n  3\nSCENEOE\n 90\n1153\n 91\n0\n280\n0\n281\n0\n  0\nCLASS\n  1\nVISUALSTYLE\n  2\nAcDbVisualStyle\n  3\nObjectDBX Classes\n 90\n4095\n 91\n0\n280\n0\n281\n0\n  0\nCLASS\n  1\nMATERIAL\n  2\nAcDbMaterial\n  3\nObjectDBX Classes\n 90\n1153\n 91\n0\n280\n0\n281\n0\n  0\nCLASS\n  1\nSCALE\n  2\nAcDbScale\n  3\nObjectDBX Classes\n 90\n1153\n 91\n0\n280\n0\n281\n0\n  0\nCLASS\n  1\nTABLESTYLE\n  2\nAcDbTableStyle\n  3\nObjectDBX Classes\n 90\n4095\n 91\n0\n280\n0\n281\n0\n  0\nCLASS\n  1\nMLEADERSTYLE\n  2\nAcDbMLeaderStyle\n  3\nACDB_MLEADERSTYLE_CLASS\n 90\n4095\n 91\n0\n280\n0\n281\n0\n  0\nCLASS\n  1\nDICTIONARYVAR\n  2\nAcDbDictionaryVar\n  3\nObjectDBX Classes\n 90\n0\n 91\n0\n280\n0\n281\n0\n  0\nCLASS\n  1\nCELLSTYLEMAP\n  2\nAcDbCellStyleMap\n  3\nObjectDBX Classes\n 90\n1152\n 91\n0\n280\n0\n281\n0\n  0\nCLASS\n  1\nMENTALRAYRENDERSETTINGS\n  2\nAcDbMentalRayRenderSettings\n  3\nSCENEOE\n 90\n1024\n 91\n0\n280\n0\n281\n0\n  0\nCLASS\n  1\nACDBDETAILVIEWSTYLE\n  2\nAcDbDetailViewStyle\n  3\nObjectDBX Classes\n 90\n1025\n 91\n0\n280\n0\n281\n0\n  0\nCLASS\n  1\nACDBSECTIONVIEWSTYLE\n  2\nAcDbSectionViewStyle\n  3\nObjectDBX Classes\n 90\n1025\n 91\n0\n280\n0\n281\n0\n  0\nCLASS\n  1\nRASTERVARIABLES\n  2\nAcDbRasterVariables\n  3\nISM\n 90\n0\n 91\n0\n280\n0\n281\n0\n  0\nCLASS\n  1\nLAYOUT\n  2\nAcDbLayout\n  3\nObjectDBX Classes\n 90\n0\n 91\n0\n280\n0\n281\n0\n  0\nCLASS\n  1\nACDBPLACEHOLDER\n  2\nAcDbPlaceHolder\n  3\nObjectDBX Classes\n 90\n0\n 91\n0\n280\n0\n281\n0\n  0\nENDSEC\n  0\nSECTION\n  2\nTABLES\n  0\nTABLE\n  2\nVPORT\n  5\n8\n330\n0\n100\nAcDbSymbolTable\n 70\n1\n  0\nVPORT\n  5\n23\n330\n8\n100\nAcDbSymbolTableRecord\n100\nAcDbViewportTableRecord\n  2\n*Active\n 70\n0\n 10\n0.0\n 20\n0.0\n 11\n1.0\n 21\n1.0\n 12\n0.0\n 22\n0.0\n 13\n0.0\n 23\n0.0\n 14\n0.5\n 24\n0.5\n 15\n0.5\n 25\n0.5\n 16\n0.0\n 26\n0.0\n 36\n1.0\n 17\n0.0\n 27\n0.0\n 37\n0.0\n 40\n1000.0\n 41\n1.34\n 42\n50.0\n 43\n0.0\n 44\n0.0\n 50\n0.0\n 51\n0.0\n 71\n0\n 72\n1000\n 73\n1\n 74\n3\n 75\n0\n 76\n0\n 77\n0\n 78\n0\n281\n0\n 65\n0\n146\n0.0\n  0\nENDTAB\n  0\nTABLE\n  2\nLTYPE\n  5\n2\n330\n0\n100\nAcDbSymbolTable\n 70\n3\n  0\nLTYPE\n  5\n24\n330\n2\n100\nAcDbSymbolTableRecord\n100\nAcDbLinetypeTableRecord\n  2\nByBlock\n 70\n0\n  3\n\n 72\n65\n 73\n0\n 40\n0.0\n  0\nLTYPE\n  5\n25\n330\n2\n100\nAcDbSymbolTableRecord\n100\nAcDbLinetypeTableRecord\n  2\nByLayer\n 70\n0\n  3\n\n 72\n65\n 73\n0\n 40\n0.0\n  0\nLTYPE\n  5\n26\n330\n2\n100\nAcDbSymbolTableRecord\n100\nAcDbLinetypeTableRecord\n  2\nContinuous\n 70\n0\n  3\n\n 72\n65\n 73\n0\n 40\n0.0\n  0\nENDTAB\n  0\nTABLE\n  2\nLAYER\n  5\n1\n330\n0\n100\nAcDbSymbolTable\n 70\n8\n  0\nLAYER\n  5\n27\n330\n1\n100\nAcDbSymbolTableRecord\n100\nAcDbLayerTableRecord\n  2\n0\n 70\n0\n 62\n7\n  6\nContinuous\n370\n-3\n390\n13\n347\n21\n  0\nLAYER\n  5\n28\n330\n1\n100\nAcDbSymbolTableRecord\n100\nAcDbLayerTableRecord\n  2\nDefpoints\n 70\n0\n 62\n7\n  6\nContinuous\n290\n0\n370\n-3\n390\n13\n347\n21\n  0\nLAYER\n  5\n2F\n330\n1\n100\nAcDbSymbolTableRecord\n100\nAcDbLayerTableRecord\n  2\nPROFILE_CUT\n 70\n0\n 62\n7\n  6\nContinuous\n370\n-3\n390\n13\n347\n21\n  0\nLAYER\n  5\n30\n330\n1\n100\nAcDbSymbolTableRecord\n100\nAcDbLayerTableRecord\n  2\nLINE_ENGRAVE\n 70\n0\n 62\n5\n  6\nContinuous\n370\n-3\n390\n13\n347\n21\n  0\nLAYER\n  5\n31\n330\n1\n100\nAcDbSymbolTableRecord\n100\nAcDbLayerTableRecord\n  2\nTEXT_VCARVE\n 70\n0\n 62\n1\n  6\nContinuous\n370\n-3\n390\n13\n347\n21\n  0\nLAYER\n  5\n32\n330\n1\n100\nAcDbSymbolTableRecord\n100\nAcDbLayerTableRecord\n  2\nART_VCARVE\n 70\n0\n 62\n3\n  6\nContinuous\n370\n-3\n390\n13\n347\n21\n  0\nLAYER\n  5\n33\n330\n1\n100\nAcDbSymbolTableRecord\n100\nAcDbLayerTableRecord\n  2\nHOLE_DRILL\n 70\n0\n 62\n6\n  6\nContinuous\n370\n-3\n390\n13\n347\n21\n  0\nLAYER\n  5\n34\n330\n1\n100\nAcDbSymbolTableRecord\n100\nAcDbLayerTableRecord\n  2\nGROOVE_CENTER\n 70\n0\n 62\n30\n  6\nContinuous\n370\n-3\n390\n13\n347\n21\n  0\nENDTAB\n  0\nTABLE\n  2\nSTYLE\n  5\n5\n330\n0\n100\nAcDbSymbolTable\n 70\n1\n  0\nSTYLE\n  5\n29\n330\n5\n100\nAcDbSymbolTableRecord\n100\nAcDbTextStyleTableRecord\n  2\nStandard\n 70\n0\n 40\n0.0\n 41\n1.0\n 50\n0.0\n 71\n0\n 42\n2.5\n  3\ntxt\n  4\n\n  0\nENDTAB\n  0\nTABLE\n  2\nVIEW\n  5\n7\n330\n0\n100\nAcDbSymbolTable\n 70\n0\n  0\nENDTAB\n  0\nTABLE\n  2\nUCS\n  5\n6\n330\n0\n100\nAcDbSymbolTable\n 70\n0\n  0\nENDTAB\n  0\nTABLE\n  2\nAPPID\n  5\n3\n330\n0\n100\nAcDbSymbolTable\n 70\n3\n  0\nAPPID\n  5\n2A\n330\n3\n100\nAcDbSymbolTableRecord\n100\nAcDbRegAppTableRecord\n  2\nACAD\n 70\n0\n  0\nAPPID\n  5\n35\n330\n3\n100\nAcDbSymbolTableRecord\n100\nAcDbRegAppTableRecord\n  2\nHATCHBACKGROUNDCOLOR\n 70\n0\n  0\nAPPID\n  5\n36\n330\n3\n100\nAcDbSymbolTableRecord\n100\nAcDbRegAppTableRecord\n  2\nEZDXF\n 70\n0\n  0\nENDTAB\n  0\nTABLE\n  2\nDIMSTYLE\n  5\n4\n330\n0\n100\nAcDbSymbolTable\n 70\n1\n100\nAcDbDimStyleTable\n  0\nDIMSTYLE\n105\n2B\n330\n4\n100\nAcDbSymbolTableRecord\n100\nAcDbDimStyleTableRecord\n  2\nStandard\n 70\n0\n 40\n1.0\n 41\n2.5\n 42\n0.625\n 43\n3.75\n 44\n1.25\n 45\n0.0\n 46\n0.0\n 47\n0.0\n 48\n0.0\n 49\n2.5\n140\n2.5\n141\n2.5\n142\n0.0\n143\n0.03937007874\n144\n1.0\n145\n0.0\n146\n1.0\n147\n0.625\n148\n0.0\n 69\n0\n 70\n0\n 71\n0\n 72\n0\n 73\n0\n 74\n0\n 75\n0\n 76\n0\n 77\n1\n 78\n8\n 79\n3\n170\n0\n171\n3\n172\n1\n173\n0\n174\n0\n175\n0\n176\n0\n177\n0\n178\n0\n179\n2\n271\n2\n272\n2\n273\n2\n274\n3\n275\n0\n276\n0\n277\n2\n278\n44\n279\n0\n280\n0\n281\n0\n282\n0\n283\n0\n284\n8\n285\n0\n286\n0\n288\n0\n289\n3\n290\n0\n371\n-2\n372\n-2\n  0\nENDTAB\n  0\nTABLE\n  2\nBLOCK_RECORD\n  5\n9\n330\n0\n100\nAcDbSymbolTable\n 70\n2\n  0\nBLOCK_RECORD\n  5\n17\n330\n9\n100\nAcDbSymbolTableRecord\n100\nAcDbBlockTableRecord\n  2\n*Model_Space\n340\n1A\n 70\n0\n280\n1\n281\n0\n  0\nBLOCK_RECORD\n  5\n1B\n330\n9\n100\nAcDbSymbolTableRecord\n100\nAcDbBlockTableRecord\n  2\n*Paper_Space\n340\n1E\n 70\n0\n280\n1\n281\n0\n  0\nENDTAB\n  0\nENDSEC\n  0\nSECTION\n  2\nBLOCKS\n  0\nBLOCK\n  5\n18\n330\n17\n100\nAcDbEntity\n  8\n0\n100\nAcDbBlockBegin\n  2\n*Model_Space\n 70\n0\n 10\n0.0\n 20\n0.0\n 30\n0.0\n  3\n*Model_Space\n  1\n\n  0\nENDBLK\n  5\n19\n330\n17\n100\nAcDbEntity\n  8\n0\n100\nAcDbBlockEnd\n  0\nBLOCK\n  5\n1C\n330\n1B\n100\nAcDbEntity\n  8\n0\n100\nAcDbBlockBegin\n  2\n*Paper_Space\n 70\n0\n 10\n0.0\n 20\n0.0\n 30\n0.0\n  3\n*Paper_Space\n  1\n\n  0\nENDBLK\n  5\n1D\n330\n1B\n100\nAcDbEntity\n  8\n0\n100\nAcDbBlockEnd\n  0\nENDSEC\n  0\nSECTION\n  2\nENTITIES\n  0\nENDSEC\n  0\nSECTION\n  2\nOBJECTS\n  0\nDICTIONARY\n  5\nA\n330\n0\n100\nAcDbDictionary\n281\n1\n  3\nACAD_COLOR\n350\nB\n  3\nACAD_GROUP\n350\nC\n  3\nACAD_LAYOUT\n350\nD\n  3\nACAD_MATERIAL\n350\nE\n  3\nACAD_MLEADERSTYLE\n350\nF\n  3\nACAD_MLINESTYLE\n350\n10\n  3\nACAD_PLOTSETTINGS\n350\n11\n  3\nACAD_PLOTSTYLENAME\n350\n12\n  3\nACAD_SCALELIST\n350\n14\n  3\nACAD_TABLESTYLE\n350\n15\n  3\nACAD_VISUALSTYLE\n350\n16\n  3\nEZDXF_META\n350\n2D\n  0\nDICTIONARY\n  5\nB\n330\nA\n100\nAcDbDictionary\n281\n1\n  0\nDICTIONARY\n  5\nC\n330\nA\n100\nAcDbDictionary\n281\n1\n  0\nDICTIONARY\n  5\nD\n330\nA\n100\nAcDbDictionary\n281\n1\n  3\nModel\n350\n1A\n  3\nLayout1\n350\n1E\n  0\nDICTIONARY\n  5\nE\n330\nA\n100\nAcDbDictionary\n281\n1\n  3\nByBlock\n350\n1F\n  3\nByLayer\n350\n20\n  3\nGlobal\n350\n21\n  0\nDICTIONARY\n  5\nF\n330\nA\n100\nAcDbDictionary\n281\n1\n  3\nStandard\n350\n2C\n  0\nDICTIONARY\n  5\n10\n330\nA\n100\nAcDbDictionary\n281\n1\n  3\nStandard\n350\n22\n  0\nDICTIONARY\n  5\n11\n330\nA\n100\nAcDbDictionary\n281\n1\n  0\nACDBDICTIONARYWDFLT\n  5\n12\n330\nA\n100\nAcDbDictionary\n281\n1\n  3\nNormal\n350\n13\n100\nAcDbDictionaryWithDefault\n340\n13\n  0\nACDBPLACEHOLDER\n  5\n13\n330\n12\n  0\nDICTIONARY\n  5\n14\n330\nA\n100\nAcDbDictionary\n281\n1\n  0\nDICTIONARY\n  5\n15\n330\nA\n100\nAcDbDictionary\n281\n1\n  0\nDICTIONARY\n  5\n16\n330\nA\n100\nAcDbDictionary\n281\n1\n  0\nLAYOUT\n  5\n1A\n330\nD\n100\nAcDbPlotSettings\n  1\n\n  4\nA3\n  6\n\n 40\n7.5\n 41\n20.0\n 42\n7.5\n 43\n20.0\n 44\n420.0\n 45\n297.0\n 46\n0.0\n 47\n0.0\n 48\n0.0\n 49\n0.0\n140\n0.0\n141\n0.0\n142\n1.0\n143\n1.0\n 70\n1024\n 72\n1\n 73\n0\n 74\n5\n  7\n\n 75\n16\n 76\n0\n 77\n2\n 78\n300\n147\n1.0\n148\n0.0\n149\n0.0\n100\nAcDbLayout\n  1\nModel\n 70\n1\n 71\n0\n 10\n0.0\n 20\n0.0\n 11\n420.0\n 21\n297.0\n 12\n0.0\n 22\n0.0\n 32\n0.0\n 14\n1e+20\n 24\n1e+20\n 34\n1e+20\n 15\n-1e+20\n 25\n-1e+20\n 35\n-1e+20\n146\n0.0\n 13\n0.0\n 23\n0.0\n 33\n0.0\n 16\n1.0\n 26\n0.0\n 36\n0.0\n 17\n0.0\n 27\n1.0\n 37\n0.0\n 76\n1\n330\n17\n  0\nLAYOUT\n  5\n1E\n330\nD\n100\nAcDbPlotSettings\n  1\n\n  4\nA3\n  6\n\n 40\n7.5\n 41\n20.0\n 42\n7.5\n 43\n20.0\n 44\n420.0\n 45\n297.0\n 46\n0.0\n 47\n0.0\n 48\n0.0\n 49\n0.0\n140\n0.0\n141\n0.0\n142\n1.0\n143\n1.0\n 70\n0\n 72\n1\n 73\n0\n 74\n5\n  7\n\n 75\n16\n 76\n0\n 77\n2\n 78\n300\n147\n1.0\n148\n0.0\n149\n0.0\n100\nAcDbLayout\n  1\nLayout1\n 70\n1\n 71\n1\n 10\n0.0\n 20\n0.0\n 11\n420.0\n 21\n297.0\n 12\n0.0\n 22\n0.0\n 32\n0.0\n 14\n1e+20\n 24\n1e+20\n 34\n1e+20\n 15\n-1e+20\n 25\n-1e+20\n 35\n-1e+20\n146\n0.0\n 13\n0.0\n 23\n0.0\n 33\n0.0\n 16\n1.0\n 26\n0.0\n 36\n0.0\n 17\n0.0\n 27\n1.0\n 37\n0.0\n 76\n1\n330\n1B\n  0\nMATERIAL\n  5\n1F\n102\n{ACAD_REACTORS\n330\nE\n102\n}\n330\nE\n100\nAcDbMaterial\n  1\nByBlock\n  2\n\n 70\n0\n 40\n1.0\n 71\n1\n 41\n1.0\n 91\n-1023410177\n 42\n1.0\n 72\n1\n  3\n\n 73\n1\n 74\n1\n 75\n1\n 44\n0.5\n 73\n0\n 45\n1.0\n 46\n1.0\n 77\n1\n  4\n\n 78\n1\n 79\n1\n170\n1\n 48\n1.0\n171\n1\n  6\n\n172\n1\n173\n1\n174\n1\n140\n1.0\n141\n1.0\n175\n1\n  7\n\n176\n1\n177\n1\n178\n1\n143\n1.0\n179\n1\n  8\n\n270\n1\n271\n1\n272\n1\n145\n1.0\n146\n1.0\n273\n1\n  9\n\n274\n1\n275\n1\n276\n1\n 42\n1.0\n 72\n1\n  3\n\n 73\n1\n 74\n1\n 75\n1\n 94\n63\n  0\nMATERIAL\n  5\n20\n102\n{ACAD_REACTORS\n330\nE\n102\n}\n330\nE\n100\nAcDbMaterial\n  1\nByLayer\n  2\n\n 70\n0\n 40\n1.0\n 71\n1\n 41\n1.0\n 91\n-1023410177\n 42\n1.0\n 72\n1\n  3\n\n 73\n1\n 74\n1\n 75\n1\n 44\n0.5\n 73\n0\n 45\n1.0\n 46\n1.0\n 77\n1\n  4\n\n 78\n1\n 79\n1\n170\n1\n 48\n1.0\n171\n1\n  6\n\n172\n1\n173\n1\n174\n1\n140\n1.0\n141\n1.0\n175\n1\n  7\n\n176\n1\n177\n1\n178\n1\n143\n1.0\n179\n1\n  8\n\n270\n1\n271\n1\n272\n1\n145\n1.0\n146\n1.0\n273\n1\n  9\n\n274\n1\n275\n1\n276\n1\n 42\n1.0\n 72\n1\n  3\n\n 73\n1\n 74\n1\n 75\n1\n 94\n63\n  0\nMATERIAL\n  5\n21\n102\n{ACAD_REACTORS\n330\nE\n102\n}\n330\nE\n100\nAcDbMaterial\n  1\nGlobal\n  2\n\n 70\n0\n 40\n1.0\n 71\n1\n 41\n1.0\n 91\n-1023410177\n 42\n1.0\n 72\n1\n  3\n\n 73\n1\n 74\n1\n 75\n1\n 44\n0.5\n 73\n0\n 45\n1.0\n 46\n1.0\n 77\n1\n  4\n\n 78\n1\n 79\n1\n170\n1\n 48\n1.0\n171\n1\n  6\n\n172\n1\n173\n1\n174\n1\n140\n1.0\n141\n1.0\n175\n1\n  7\n\n176\n1\n177\n1\n178\n1\n143\n1.0\n179\n1\n  8\n\n270\n1\n271\n1\n272\n1\n145\n1.0\n146\n1.0\n273\n1\n  9\n\n274\n1\n275\n1\n276\n1\n 42\n1.0\n 72\n1\n  3\n\n 73\n1\n 74\n1\n 75\n1\n 94\n63\n  0\nMLINESTYLE\n  5\n22\n102\n{ACAD_REACTORS\n330\n10\n102\n}\n330\n10\n100\nAcDbMlineStyle\n  2\nStandard\n 70\n0\n  3\n\n 62\n256\n 51\n90.0\n 52\n90.0\n 71\n2\n 49\n0.5\n 62\n256\n  6\nBYLAYER\n 49\n-0.5\n 62\n256\n  6\nBYLAYER\n  0\nMLEADERSTYLE\n  5\n2C\n102\n{ACAD_REACTORS\n330\nF\n102\n}\n330\nF\n100\nAcDbMLeaderStyle\n179\n2\n170\n2\n171\n1\n172\n0\n 90\n2\n 40\n0.0\n 41\n0.0\n173\n1\n 91\n-1056964608\n 92\n-2\n290\n1\n 42\n2.0\n291\n1\n 43\n8.0\n  3\nStandard\n 44\n4.0\n300\n\n342\n29\n174\n1\n175\n1\n176\n0\n178\n1\n 93\n-1056964608\n 45\n4.0\n292\n0\n297\n0\n 46\n4.0\n 94\n-1056964608\n 47\n1.0\n 49\n1.0\n140\n1.0\n294\n1\n141\n0.0\n177\n0\n142\n1.0\n295\n0\n296\n0\n143\n3.75\n271\n0\n272\n9\n273\n9\n  0\nDICTIONARY\n  5\n2D\n330\nA\n100\nAcDbDictionary\n280\n1\n281\n1\n  3\nCREATED_BY_EZDXF\n350\n2E\n  3\nWRITTEN_BY_EZDXF\n350\n37\n  0\nDICTIONARYVAR\n  5\n2E\n330\n2D\n100\nDictionaryVariables\n280\n0\n  1\n1.4.5 @ 2026-11-17T18:53:43.728390+00:00\n  0\nDICTIONARYVAR\n  5\n37\n330\n2D\n100\nDictionaryVariables\n280\n0\n  1\n1.4.5 @ 2026-11-17T18:53:43.729295+00:00\n  0\nENDSEC\n  0\nEOF\n";
root.SieName = { STOCK, RULES, CutError, addFont, design, makeDXF: r => makeDXF(r, DXF_TEMPLATE), pathD, version: "1.0.0" };
})(typeof self !== "undefined" ? self : globalThis);
