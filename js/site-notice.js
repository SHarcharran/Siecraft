/* Site-wide "under construction" note. Small floating card; the visitor can close it (remembered for 7 days).
   To remove it everywhere: set ON = false (or delete this file and its <script> tags). */
(function () {
  var ON = false;
  var TEXT = "We're still building siecraft.com, so a few things may change. Orders and quotes work. Questions? Text (321) 364-3719.";
  if (!ON) return;
  try { var t = +localStorage.getItem("sc_notice_closed") || 0; if (Date.now() - t < 7 * 864e5) return; } catch (e) {}
  function show() {
    var el = document.createElement("div");
    el.setAttribute("role", "status");
    el.style.cssText = "position:fixed;left:12px;right:12px;bottom:calc(92px + env(safe-area-inset-bottom));z-index:9999;max-width:460px;margin:0 auto;" +
      "display:flex;gap:10px;align-items:flex-start;padding:12px 12px 12px 14px;border-radius:14px;background:rgba(20,16,8,.96);" +
      "border:1px solid #f59e0b88;color:#fde68a;font:500 13.5px/1.45 'DM Sans',system-ui,sans-serif;box-shadow:0 10px 30px rgba(0,0,0,.45)";
    el.innerHTML = '<span style="font-size:18px;line-height:1.2">🚧</span><span style="flex:1"><b style="color:#fff">Under construction.</b> ' + TEXT +
      '</span><button type="button" aria-label="Close" style="background:none;border:0;color:#fde68a;font-size:20px;line-height:1;cursor:pointer;padding:0 2px">×</button>';
    el.querySelector("button").onclick = function () { el.remove(); try { localStorage.setItem("sc_notice_closed", String(Date.now())); } catch (e) {} };
    document.body.appendChild(el);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", show); else show();
})();
