/**
 * The stylesheet, boot script and behaviour script inlined into every
 * human-facing HTML page, plus the inline SVG icon set they reference.
 *
 * Everything here is deliberately dependency-free and self-contained: a
 * generated handbook has to open from `file://` on a machine with no network,
 * no build step and no package manager, which rules out a framework, a CDN, an
 * icon font and a web font. So the visual language of a modern docs site
 * (sidebar + content + table of contents, ⌘K search, tri-state theme, mobile
 * drawer) is hand-written here instead.
 *
 * Two hard rules for this file:
 *
 * 1. **No backslashes in the CSS or JS strings.** They live in TypeScript
 *    template literals, where `\w` silently becomes `w` — a regex escape would
 *    be corrupted on the way out. Character classes are written out in full.
 * 2. **No `${` in the CSS or JS strings**, for the same reason: it would be
 *    read as an interpolation.
 */

/** Inline SVG sprites — `currentColor` throughout so buttons style them. */
export const ICONS = {
  logo: '<svg class="logo" viewBox="0 0 24 24" aria-hidden="true"><rect x="2" y="3" width="9" height="18" rx="2" fill="#2dd4bf"/><rect x="13" y="3" width="9" height="18" rx="2" fill="#a78bfa"/><path d="M12 5.5v13" stroke="currentColor" stroke-width="1.5" opacity=".35"/></svg>',
  search:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>',
  sun: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4"/></svg>',
  moon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5Z"/></svg>',
  auto: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M12 3.5v17" /><path d="M12 3.5a8.5 8.5 0 0 1 0 17Z" fill="currentColor" stroke="none"/></svg>',
  menu: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16"/></svg>',
  close:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>',
  caret:
    '<svg class="caret" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>',
  expand:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="m7 10 5 5 5-5"/><path d="M4 5h16" opacity=".45"/></svg>',
  collapse:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="m7 14 5-5 5 5"/><path d="M4 19h16" opacity=".45"/></svg>',
  copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M15 5.5A2.5 2.5 0 0 0 12.5 3H6a3 3 0 0 0-3 3v6.5A2.5 2.5 0 0 0 5.5 15"/></svg>',
  check:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 13 4.5 4.5L19 7"/></svg>',
  link: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M10 13.5a4 4 0 0 0 5.7 0l2.8-2.8a4 4 0 0 0-5.7-5.7l-1.2 1.2"/><path d="M14 10.5a4 4 0 0 0-5.7 0l-2.8 2.8a4 4 0 0 0 5.7 5.7l1.2-1.2"/></svg>',
  up: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 14 6-6 6 6"/></svg>',
  prev: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m14 6-6 6 6 6"/></svg>',
  next: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m10 6 6 6-6 6"/></svg>',
} as const;

/**
 * Read the stored preference and resolve it before first paint, so a dark-mode
 * reader never sees a white flash. Kept tiny and inline for that reason — an
 * external file would load too late.
 */
export const THEME_BOOT = `
(function(){try{var p=localStorage.getItem('hb-theme')||'auto';var d=p==='dark'||(p!=='light'&&window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)').matches);document.documentElement.setAttribute('data-theme',d?'dark':'light');document.documentElement.setAttribute('data-pref',p);}catch(e){}})();
`;

export const CSS = `
:root{
color-scheme:light;
--bg:#ffffff;--fg:#12161c;--muted:#586170;--faint:#8b95a3;
--border:#e6e9ef;--border-2:#d3d9e2;--card:#f8f9fb;--code:#f4f6f9;--glass:rgba(255,255,255,.78);
--accent:#0d9488;--accent-weak:#e8fbf6;--accent-fg:#ffffff;
--warn:#a25b06;--warn-weak:#fdf7ea;
--sh-1:0 1px 2px rgba(18,22,28,.05);--sh-2:0 4px 16px rgba(18,22,28,.09);--sh-3:0 24px 64px rgba(18,22,28,.22);
--sans:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,"PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;
--mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,"Liberation Mono",monospace;
--sidebar:290px;--toc:238px;--measure:45rem;--bar:52px;
}
:root[data-theme="dark"]{
color-scheme:dark;
--bg:#0b1020;--fg:#e8eef7;--muted:#9aa6ba;--faint:#6d7889;
--border:#1d2740;--border-2:#2c3852;--card:#111830;--code:#0e1527;--glass:rgba(11,16,32,.76);
--accent:#2dd4bf;--accent-weak:#0e2c2b;--accent-fg:#04201c;
--warn:#f3b53f;--warn-weak:#251d0d;
--sh-1:0 1px 2px rgba(0,0,0,.5);--sh-2:0 4px 16px rgba(0,0,0,.55);--sh-3:0 24px 64px rgba(0,0,0,.7);
}
*,*::before,*::after{box-sizing:border-box}
html{-webkit-text-size-adjust:100%;scroll-behavior:smooth;scroll-padding-top:calc(var(--bar) + 18px)}
body{margin:0;background:var(--bg);color:var(--fg);font:15.5px/1.72 var(--sans);-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}
a{color:var(--accent);text-decoration:none}
a:hover{text-decoration:underline}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:4px}
svg{display:block}

/* ---------- shell ---------- */
.layout{display:flex;align-items:flex-start;min-height:100vh}
.sidebar{position:sticky;top:0;height:100vh;width:var(--sidebar);flex:none;display:flex;flex-direction:column;border-right:1px solid var(--border);background:var(--bg);z-index:30}
.sb-head{padding:15px 15px 12px;border-bottom:1px solid var(--border)}
.brand{display:flex;align-items:center;gap:9px;color:var(--fg);font-size:15px;font-weight:650;letter-spacing:-.012em;text-decoration:none;min-width:0}
.brand:hover{text-decoration:none;color:var(--accent)}
.brand .logo{width:20px;height:20px;flex:none;border-radius:4px}
.brand span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sb-sub{margin:7px 0 0;color:var(--faint);font-size:11px;font-weight:600;letter-spacing:.06em;text-transform:uppercase}
.sb-find{display:flex;align-items:center;gap:7px;width:100%;margin:12px 0 0;padding:0 9px;height:32px;border:1px solid var(--border);border-radius:9px;background:var(--card);color:var(--faint);font:inherit;font-size:13px;cursor:pointer;text-align:left}
.sb-find:hover{border-color:var(--border-2);color:var(--muted)}
.sb-find svg{width:14px;height:14px;flex:none}
.sb-find .grow{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
kbd{font:inherit;font-family:var(--mono);font-size:10.5px;color:var(--faint);border:1px solid var(--border);border-bottom-width:2px;border-radius:5px;padding:1px 4px;background:var(--bg);white-space:nowrap}
.sb-nav{flex:1;overflow-y:auto;overscroll-behavior:contain;padding:10px 9px 48px;font-size:13.5px}
.sb-label{margin:13px 9px 5px;color:var(--faint);font-size:10.5px;font-weight:700;letter-spacing:.08em;text-transform:uppercase}
.sb-nav ul{list-style:none;margin:0;padding:0}
.sb-nav ul ul{margin:1px 0 3px 12px;padding-left:9px;border-left:1px solid var(--border)}
.sb-nav a{display:flex;gap:7px;align-items:baseline;padding:5px 9px;border-radius:7px;color:var(--muted);line-height:1.45;text-decoration:none}
.sb-nav a:hover{background:var(--card);color:var(--fg);text-decoration:none}
.sb-nav a.cur{background:var(--accent-weak);color:var(--accent);font-weight:640}
.sb-num{flex:none;min-width:1.7em;color:var(--faint);font-size:11.5px;font-variant-numeric:tabular-nums}
.sb-nav a.cur .sb-num,.sb-nav a:hover .sb-num{color:inherit;opacity:.7}
.sb-dot{flex:none;width:6px;height:6px;margin-top:.5em;border-radius:50%;background:var(--warn);opacity:.8}

.doc{flex:1;min-width:0}
.topbar{position:sticky;top:0;z-index:20;display:flex;align-items:center;gap:9px;height:var(--bar);padding:0 clamp(16px,2.6vw,40px);border-bottom:1px solid var(--border);background:var(--glass);backdrop-filter:saturate(1.7) blur(12px);-webkit-backdrop-filter:saturate(1.7) blur(12px)}
.crumb{flex:1;min-width:0;display:flex;align-items:center;gap:6px;color:var(--faint);font-size:12.5px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.crumb a{color:var(--muted)}
.crumb a:hover{color:var(--accent);text-decoration:none}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:30px;padding:0 10px;border:1px solid var(--border);border-radius:8px;background:var(--bg);color:var(--muted);font:inherit;font-size:12.5px;cursor:pointer;white-space:nowrap}
.btn:hover{color:var(--fg);border-color:var(--border-2);background:var(--card)}
.btn svg{width:15px;height:15px;flex:none}
.btn-i{width:30px;padding:0}
.only-mobile{display:none}
@media (max-width:1080px){.btn .wide{display:none}.btn:has(.wide){width:30px;padding:0}}
.doc-body{display:flex;justify-content:center;gap:clamp(20px,3vw,40px);padding:0 clamp(16px,2.6vw,40px)}
.content{flex:1;min-width:0;max-width:var(--measure);padding:26px 0 108px}
.toc{position:sticky;top:var(--bar);width:var(--toc);flex:none;align-self:flex-start;max-height:calc(100vh - var(--bar) - 24px);overflow-y:auto;overscroll-behavior:contain;padding:30px 0 40px;font-size:12.8px}
.toc-t{margin:0 0 9px;color:var(--faint);font-size:10.5px;font-weight:700;letter-spacing:.08em;text-transform:uppercase}
.toc ul{list-style:none;margin:0;padding:0}
.toc li.d2 a{padding-left:22px;font-size:12.2px}
.toc a{display:block;padding:3.5px 10px;border-left:2px solid var(--border);color:var(--muted);line-height:1.45;text-decoration:none}
.toc a:hover{color:var(--fg);text-decoration:none;border-color:var(--border-2)}
.toc a.on{color:var(--accent);border-color:var(--accent);font-weight:600}

/* ---------- page head ---------- */
.head{padding-bottom:20px;border-bottom:1px solid var(--border);margin-bottom:6px}
h1{margin:0;font-size:31px;line-height:1.22;font-weight:700;letter-spacing:-.024em}
.head h1 .chip{vertical-align:.28em}
.lede{margin:11px 0 0;color:var(--muted);font-size:16px;line-height:1.62}
.chips{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin:14px 0 0}
.chip{display:inline-flex;align-items:center;gap:5px;height:22px;padding:0 8px;border:1px solid var(--border);border-radius:999px;background:var(--card);color:var(--muted);font-size:11.5px;line-height:1;white-space:nowrap}
.chip-mono{font-family:var(--mono);font-size:11px}
.chip.crosscut{color:var(--warn);border-color:var(--warn);background:var(--warn-weak)}
.role{--h:220;color:hsl(var(--h) 42% 36%);border-color:hsl(var(--h) 38% 84%);background:hsl(var(--h) 62% 97%);font-size:11px;letter-spacing:.01em}
:root[data-theme="dark"] .role{color:hsl(var(--h) 58% 74%);border-color:hsl(var(--h) 28% 30%);background:hsl(var(--h) 38% 13%)}
.role-entrypoint{--h:158}.role-orchestration{--h:266}.role-domain_logic{--h:214}.role-io_transport{--h:190}
.role-data_model{--h:36}.role-config{--h:246}.role-util{--h:222}.role-test{--h:340}.role-generated{--h:288}.role-other{--h:220}

/* ---------- prose ---------- */
.prose{font-size:15.5px}
.prose>p{margin:15px 0}
.prose li{margin:5px 0}
.prose ul,.prose ol{padding-left:24px}
.prose blockquote{margin:16px 0;padding:2px 0 2px 15px;border-left:3px solid var(--border-2);color:var(--muted)}
.prose img{max-width:100%;height:auto;border-radius:8px}
h2{margin:44px 0 0;padding-top:16px;border-top:1px solid var(--border);font-size:21px;font-weight:670;letter-spacing:-.016em;line-height:1.3}
h3{margin:30px 0 0;font-size:16.5px;font-weight:650;letter-spacing:-.01em}
h4{margin:24px 0 0;font-size:14px;font-weight:650;color:var(--muted);letter-spacing:.01em}
h2+*,h3+*,h4+*{margin-top:10px}
.anchor{margin-left:7px;color:var(--faint);opacity:0;vertical-align:.06em}
.anchor svg{width:13px;height:13px;display:inline-block}
h2:hover .anchor,h3:hover .anchor,.anchor:focus-visible{opacity:1;text-decoration:none}
code{font-family:var(--mono);font-size:.875em;background:var(--code);border:1px solid var(--border);border-radius:5px;padding:.08em .35em}
pre{position:relative;margin:14px 0;background:var(--code);border:1px solid var(--border);border-radius:10px;padding:12px 14px;overflow-x:auto;font-size:12.6px;line-height:1.62}
pre code{background:none;border:none;padding:0;font-size:inherit}
.copy{position:absolute;top:7px;right:7px;width:26px;height:26px;padding:0;opacity:0;transition:opacity .12s}
pre:hover .copy,.copy:focus-visible{opacity:1}
.copy.done{color:var(--accent);border-color:var(--accent)}
.tablewrap{margin:16px 0;overflow-x:auto;border:1px solid var(--border);border-radius:10px}
table{border-collapse:collapse;width:100%;font-size:13.6px}
th,td{padding:9px 12px;text-align:left;vertical-align:top;border-bottom:1px solid var(--border)}
th{position:sticky;top:0;background:var(--card);color:var(--muted);font-size:11.5px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;white-space:nowrap;z-index:1}
tbody tr:last-child td{border-bottom:none}
tbody tr:hover{background:var(--card)}
td code{white-space:nowrap}
hr{border:none;border-top:1px solid var(--border);margin:28px 0}
.callout{display:flex;gap:10px;margin:18px 0;padding:12px 14px;border:1px solid var(--warn);border-left-width:3px;border-radius:9px;background:var(--warn-weak);color:var(--fg);font-size:13.6px;line-height:1.6}
.callout b{color:var(--warn)}

/* ---------- cards ---------- */
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,258px),1fr));gap:11px;margin:16px 0 0;padding:0;list-style:none}
.card{position:relative;display:flex;flex-direction:column;gap:5px;padding:13px 14px;border:1px solid var(--border);border-radius:12px;background:var(--bg);box-shadow:var(--sh-1);transition:border-color .13s,box-shadow .13s}
.card:hover{border-color:var(--accent);box-shadow:var(--sh-2)}
.card-t{display:inline-flex;align-items:baseline;gap:6px;color:var(--fg);font-size:14.5px;font-weight:640;letter-spacing:-.008em;text-decoration:none}
.card:hover .card-t{color:var(--accent)}
.card-t::after{content:"";position:absolute;inset:0;border-radius:12px}
.card-n{color:var(--faint);font-size:11.5px;font-variant-numeric:tabular-nums}
.card-m{color:var(--faint);font-size:11px;font-family:var(--mono)}
.card p{margin:3px 0 0;color:var(--muted);font-size:13px;line-height:1.6}

/* ---------- files & functions ---------- */
.files{margin:14px 0 0;border:1px solid var(--border);border-radius:11px;background:var(--bg);overflow:hidden}
.file+.file{border-top:1px solid var(--border)}
.file>summary{display:flex;align-items:center;gap:9px;padding:9px 13px;cursor:pointer;list-style:none}
.file>summary::-webkit-details-marker{display:none}
.file>summary::marker{content:""}
.file>summary:hover{background:var(--card)}
.file[open]>summary{background:var(--card);border-bottom:1px solid var(--border)}
.caret{width:13px;height:13px;flex:none;color:var(--faint);transition:transform .16s}
details[open]>summary .caret{transform:rotate(90deg)}
.path{background:none;border:none;padding:0;font-family:var(--mono);font-size:12.6px;color:var(--fg);overflow-wrap:anywhere}
a:hover .path{color:var(--accent)}
.spacer{flex:1}
.file-body{padding:12px 15px 15px 35px}
.file-body>.prose>p:first-child{margin-top:0}
.fns{margin:16px 0 0}
.fn{margin:7px 0;border:1px solid var(--border);border-radius:9px;background:var(--bg)}
.fn>summary{display:flex;align-items:center;gap:8px;padding:7px 10px;cursor:pointer;list-style:none}
.fn>summary::-webkit-details-marker{display:none}
.fn>summary::marker{content:""}
.fn>summary:hover{background:var(--card)}
.fn-n{font-family:var(--mono);font-size:12.4px;color:var(--fg);overflow-wrap:anywhere}
.fn-l{flex:none;color:var(--faint);font-size:11px;font-variant-numeric:tabular-nums}
.fn-body{padding:2px 11px 12px}
.fn-body pre{margin:9px 0 0}
.field{margin:11px 0 0;font-size:13.6px;line-height:1.62}
.field-l{display:block;margin-bottom:1px;color:var(--faint);font-size:10.5px;font-weight:700;letter-spacing:.075em;text-transform:uppercase}
.facts{margin:11px 0 0;padding-top:9px;border-top:1px dashed var(--border);color:var(--faint);font-size:12.4px}
:target>summary{box-shadow:inset 3px 0 0 var(--accent)}

/* ---------- footer nav ---------- */
.pager{display:grid;grid-template-columns:1fr 1fr;gap:11px;margin:52px 0 0}
.pager a{display:flex;align-items:center;gap:9px;padding:12px 14px;border:1px solid var(--border);border-radius:11px;color:var(--fg);text-decoration:none;background:var(--bg)}
.pager a:hover{border-color:var(--accent);text-decoration:none;box-shadow:var(--sh-1)}
.pager svg{width:16px;height:16px;flex:none;color:var(--faint)}
.pager .pg-n{display:block;color:var(--faint);font-size:11px;font-weight:700;letter-spacing:.07em;text-transform:uppercase}
.pager .pg-t{display:block;margin-top:2px;font-size:14px;font-weight:620;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pager .nx{grid-column:2;justify-content:flex-end;text-align:right}
.totop{position:fixed;right:22px;bottom:22px;z-index:15;width:36px;height:36px;padding:0;border-radius:50%;box-shadow:var(--sh-2);background:var(--bg);opacity:0;pointer-events:none;transition:opacity .18s}
.totop.on{opacity:1;pointer-events:auto}

/* ---------- search ---------- */
.sdim{position:fixed;inset:0;z-index:60;display:none;padding:11vh 16px 16px;background:rgba(10,14,22,.5);backdrop-filter:blur(3px)}
.sdim.on{display:block}
.spanel{max-width:620px;margin:0 auto;background:var(--bg);border:1px solid var(--border);border-radius:14px;box-shadow:var(--sh-3);overflow:hidden}
.srow{display:flex;align-items:center;gap:9px;padding:12px 14px;border-bottom:1px solid var(--border)}
.srow svg{width:16px;height:16px;flex:none;color:var(--faint)}
#hb-q{flex:1;min-width:0;border:none;background:none;color:var(--fg);font:inherit;font-size:15px;outline:none}
#hb-q::placeholder{color:var(--faint)}
.sout{max-height:min(58vh,460px);overflow-y:auto;padding:6px}
.sout:empty{display:none}
.shit{display:flex;align-items:baseline;gap:9px;width:100%;padding:8px 10px;border:none;border-radius:9px;background:none;color:var(--fg);font:inherit;font-size:13.6px;text-align:left;cursor:pointer;text-decoration:none}
.shit:hover,.shit.on{background:var(--card);text-decoration:none}
.shit.on{box-shadow:inset 2px 0 0 var(--accent)}
.shit .k{flex:none;min-width:66px;color:var(--faint);font-size:10.5px;font-weight:700;letter-spacing:.07em;text-transform:uppercase}
.shit .l{flex:1;min-width:0;overflow-wrap:anywhere}
.shit .l.mono{font-family:var(--mono);font-size:12.4px}
.shit mark{background:var(--accent-weak);color:var(--accent);border-radius:3px;padding:0 1px}
.shit .s{flex:none;max-width:38%;color:var(--faint);font-size:11.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.snil{padding:26px 14px;color:var(--faint);font-size:13.5px;text-align:center}
.sfoot{display:flex;gap:14px;padding:8px 14px;border-top:1px solid var(--border);background:var(--card);color:var(--faint);font-size:11px}

/* ---------- single-page stage sections ---------- */
.stage{margin:16px 0;border:1px solid var(--border);border-radius:12px;background:var(--bg)}
.stage>summary{display:flex;align-items:center;gap:10px;padding:13px 15px;cursor:pointer;list-style:none;font-size:17px;font-weight:650;letter-spacing:-.014em}
.stage>summary::-webkit-details-marker{display:none}
.stage>summary::marker{content:""}
.stage>summary:hover{background:var(--card)}
.stage[open]>summary{border-bottom:1px solid var(--border)}
.stage-b{padding:4px 18px 20px}
.stage-b>h2:first-child{margin-top:22px}

/* ---------- responsive ---------- */
@media (max-width:1180px){.toc{display:none}}
@media (max-width:900px){
:root{--sidebar:284px}
.only-mobile{display:inline-flex}
.sidebar{position:fixed;top:0;left:0;transform:translateX(-100%);transition:transform .2s ease;box-shadow:var(--sh-3)}
body.nav-open .sidebar{transform:none}
.scrim{position:fixed;inset:0;z-index:25;display:none;background:rgba(10,14,22,.45)}
body.nav-open .scrim{display:block}
.content{padding-top:20px}
h1{font-size:26px}
.pager{grid-template-columns:1fr}
.pager .nx{grid-column:1}
.file-body{padding-left:15px}
}
@media print{
.sidebar,.topbar,.toc,.totop,.sdim,.pager,.copy{display:none!important}
.doc-body{padding:0}
.content{max-width:none;padding:0}
details{border:none}
details>summary{list-style:none}
details:not([open])>*:not(summary){display:revert}
}
@media (prefers-reduced-motion:reduce){*{transition:none!important;scroll-behavior:auto!important}}
`;

/**
 * Behaviour. Everything degrades: with JS disabled the page is still a complete
 * document — every `<details>` can be opened by hand, links work, and the theme
 * falls back to the OS preference.
 */
export const SCRIPT = `
function hbTheme(){var r=document.documentElement;var order=['auto','light','dark'];
var cur=r.getAttribute('data-pref')||'auto';var next=order[(order.indexOf(cur)+1)%3];
r.setAttribute('data-pref',next);
var dark=next==='dark'||(next!=='light'&&window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)').matches);
r.setAttribute('data-theme',dark?'dark':'light');
try{localStorage.setItem('hb-theme',next);}catch(e){}
hbThemeBtn();}
function hbThemeBtn(){var b=document.getElementById('hb-theme');if(!b)return;
var p=document.documentElement.getAttribute('data-pref')||'auto';
var i=b.querySelectorAll('svg');for(var n=0;n<i.length;n++){i[n].style.display=i[n].getAttribute('data-m')===p?'block':'none';}
b.setAttribute('title',b.getAttribute('data-t-'+p)||'');
b.setAttribute('aria-label',b.getAttribute('data-t-'+p)||'');}
function hbAll(open){var d=document.querySelectorAll('.content details, .stage-b details');for(var i=0;i<d.length;i++){d[i].open=open;}}
function hbNav(on){document.body.classList.toggle('nav-open',on);}

/* Open every ancestor <details> of the hash target, then bring it into view.
   Search results and cross-page links point at files and functions that live
   inside collapsed disclosures; without this they would land on a closed row. */
function hbReveal(){var h=location.hash;if(h.length<2)return;
var el=null;try{el=document.getElementById(decodeURIComponent(h.slice(1)));}catch(e){el=null;}
if(!el)return;var p=el;while(p){if(p.tagName==='DETAILS')p.open=true;p=p.parentElement;}
requestAnimationFrame(function(){el.scrollIntoView({block:'start'});});}

/* Scroll-spy for the table of contents. Compares live rects rather than cached
   offsets so it stays correct after a <details> above it opens. */
function hbSpy(){var links=[].slice.call(document.querySelectorAll('.toc a'));if(!links.length)return;
var tick=false;
function upd(){tick=false;var best=-1;
for(var i=0;i<links.length;i++){var id=links[i].getAttribute('href').slice(1);var t=document.getElementById(id);
if(t&&t.getBoundingClientRect().top<=Math.max(120,window.innerHeight*0.28))best=i;}
if(best<0)best=0;
for(var j=0;j<links.length;j++){if(j===best)links[j].classList.add('on');else links[j].classList.remove('on');}}
function req(){if(!tick){tick=true;requestAnimationFrame(upd);}}
window.addEventListener('scroll',req,{passive:true});window.addEventListener('resize',req);
document.addEventListener('toggle',req,true);upd();}

function hbCopyBtns(){var pres=document.querySelectorAll('.content pre, .stage-b pre');
for(var i=0;i<pres.length;i++){(function(pre){
var b=document.createElement('button');b.className='btn btn-i copy';b.type='button';
b.setAttribute('aria-label',hbT.copy);b.setAttribute('title',hbT.copy);b.innerHTML=hbIcon.copy;
b.addEventListener('click',function(){var code=pre.querySelector('code');var text=code?code.textContent:pre.textContent;
var done=function(){b.classList.add('done');b.innerHTML=hbIcon.check;b.setAttribute('title',hbT.copied);
setTimeout(function(){b.classList.remove('done');b.innerHTML=hbIcon.copy;b.setAttribute('title',hbT.copy);},1400);};
if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(text).then(done,function(){});}
else{var ta=document.createElement('textarea');ta.value=text;document.body.appendChild(ta);ta.select();
try{document.execCommand('copy');done();}catch(e){}document.body.removeChild(ta);}});
pre.appendChild(b);})(pres[i]);}}

function hbTop(){var b=document.getElementById('hb-top');if(!b)return;
var tick=false;function upd(){tick=false;if(window.scrollY>640)b.classList.add('on');else b.classList.remove('on');}
window.addEventListener('scroll',function(){if(!tick){tick=true;requestAnimationFrame(upd);}},{passive:true});upd();}

/* ---- search ---------------------------------------------------------------
   Entries are [kind, label, sublabel, url]. Matching is a plain case-folded
   substring scan ranked by where the hit lands: start of the label beats start
   of a word beats anywhere. No fuzzy library, because an extra dependency
   cannot be shipped into a file:// page.

   Results are assembled with createElement + textContent, NEVER innerHTML:
   labels are model-written prose and file paths, so building markup from them
   would reintroduce the injection the server-side escaping just closed. */
function hbFind(q){var idx=window.HB_INDEX||[];var out=[];q=q.toLowerCase();
if(!q)return out;
for(var i=0;i<idx.length;i++){var e=idx[i];var lab=e[1].toLowerCase();var p=lab.indexOf(q);var where=1;
if(p<0){var sub=(e[2]||'').toLowerCase();p=sub.indexOf(q);where=2;}
if(p<0)continue;
var prev=p>0?(where===1?lab:(e[2]||'').toLowerCase()).charAt(p-1):'';
var boundary=p===0||prev==='.'||prev==='/'||prev==='_'||prev==='-'||prev===' '||prev===':';
out.push([where*400+(boundary?0:200)+Math.min(p,120)+e[0],i,where,p]);
if(out.length>6000)break;}
out.sort(function(a,b){return a[0]-b[0]||a[1]-b[1];});
return out.slice(0,50).map(function(r){var e=idx[r[1]];return{k:e[0],label:e[1],sub:e[2]||'',url:e[3],on:r[2],at:r[3],len:q.length};});}

function hbRender(hits,q){var box=document.getElementById('hb-out');box.textContent='';
if(!q){return;}
if(!hits.length){var n=document.createElement('p');n.className='snil';n.textContent=hbT.noHits;box.appendChild(n);return;}
for(var i=0;i<hits.length;i++){var h=hits[i];
var a=document.createElement('a');a.className='shit'+(i===0?' on':'');a.href=h.url;a.setAttribute('role','option');
var k=document.createElement('span');k.className='k';k.textContent=hbT.kinds[h.k]||'';a.appendChild(k);
var l=document.createElement('span');l.className='l'+(h.k===1||h.k===2?' mono':'');
if(h.on===1){l.appendChild(document.createTextNode(h.label.slice(0,h.at)));
var m=document.createElement('mark');m.textContent=h.label.slice(h.at,h.at+h.len);l.appendChild(m);
l.appendChild(document.createTextNode(h.label.slice(h.at+h.len)));}
else{l.textContent=h.label;}
a.appendChild(l);
if(h.sub){var s=document.createElement('span');s.className='s';s.textContent=h.sub;a.appendChild(s);}
box.appendChild(a);}}

function hbSearch(open){var dim=document.getElementById('hb-dim');if(!dim)return;
if(open){dim.classList.add('on');var q=document.getElementById('hb-q');q.value='';hbRender([],'');q.focus();}
else{dim.classList.remove('on');}}

function hbSearchInit(){var dim=document.getElementById('hb-dim');if(!dim)return;
var q=document.getElementById('hb-q');var box=document.getElementById('hb-out');
if(!window.HB_INDEX){var t=document.querySelectorAll('[data-find]');for(var i=0;i<t.length;i++)t[i].style.display='none';return;}
q.addEventListener('input',function(){hbRender(hbFind(q.value.trim()),q.value.trim());});
dim.addEventListener('click',function(e){if(e.target===dim)hbSearch(false);});
function move(step){var all=[].slice.call(box.querySelectorAll('.shit'));if(!all.length)return;
var at=-1;for(var i=0;i<all.length;i++){if(all[i].classList.contains('on'))at=i;}
if(at>=0)all[at].classList.remove('on');
var nx=at<0?0:(at+step+all.length)%all.length;all[nx].classList.add('on');
all[nx].scrollIntoView({block:'nearest'});}
q.addEventListener('keydown',function(e){
if(e.key==='ArrowDown'){e.preventDefault();move(1);}
else if(e.key==='ArrowUp'){e.preventDefault();move(-1);}
else if(e.key==='Enter'){var on=box.querySelector('.shit.on');if(on){e.preventDefault();hbSearch(false);
if(on.getAttribute('href').charAt(0)==='#'){location.hash=on.getAttribute('href');hbReveal();}
else{location.href=on.getAttribute('href');}}}
else if(e.key==='Escape'){e.preventDefault();hbSearch(false);}});}

document.addEventListener('keydown',function(e){
var dim=document.getElementById('hb-dim');var openNow=dim&&dim.classList.contains('on');
if(e.key==='Escape'){if(openNow)hbSearch(false);else if(document.body.classList.contains('nav-open'))hbNav(false);return;}
if((e.key==='k'||e.key==='K')&&(e.metaKey||e.ctrlKey)){e.preventDefault();hbSearch(!openNow);return;}
if(openNow)return;
var el=e.target;var typing=el&&(el.tagName==='INPUT'||el.tagName==='TEXTAREA'||el.isContentEditable);
if(typing||e.metaKey||e.ctrlKey||e.altKey)return;
if(e.key==='/'){e.preventDefault();hbSearch(true);}});

window.addEventListener('hashchange',hbReveal);
document.addEventListener('DOMContentLoaded',function(){
hbThemeBtn();hbSearchInit();hbCopyBtns();hbSpy();hbTop();hbReveal();
var cur=document.querySelector('.sb-nav a.cur');if(cur)cur.scrollIntoView({block:'center'});
if(window.matchMedia){var mq=window.matchMedia('(prefers-color-scheme: dark)');
var onmq=function(){if((document.documentElement.getAttribute('data-pref')||'auto')==='auto')
document.documentElement.setAttribute('data-theme',mq.matches?'dark':'light');};
if(mq.addEventListener)mq.addEventListener('change',onmq);}});
`;
