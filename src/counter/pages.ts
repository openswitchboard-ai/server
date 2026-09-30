/**
 * The main pages — server-rendered HTML, no framework, no build step.
 *
 * PHONE FIRST. Almost everyone who lands here has tapped a link in an email on
 * a phone, and they are here to make one decision. So every page in this file
 * follows the same shape:
 *
 *   ask → act → detail
 *
 * The ask is one short heading saying what is being decided. The act is one or
 * two full-width buttons, close enough to the top of a 375px screen that the
 * thumb reaches them without a scroll. The supporting detail sits underneath,
 * and anything that is genuinely secondary goes inside a <details>.
 *
 * The visual system lives in one CSS block below: a spacing scale, a type
 * scale, one accent (Patch's purple), and four buttons — primary, secondary,
 * approve and danger. Every page shares the same header and the same footer,
 * and the header carries Patch himself (see patchAsset.ts) rather than an
 * emoji standing in for him.
 *
 * Brand: Sora (display) / Newsreader (body) / IBM Plex Mono (data), light and
 * dark both designed, aligned with the public site's tokens.
 *
 * Those three faces used to be pulled from Google Fonts. They are not any
 * more, and nothing on these pages reaches any origin but our own. The URL of
 * a main page carries a one-use token in its path, and a stylesheet link
 * hands that URL to a third party in the Referer of every page load. The type
 * stacks below fall back to the reader's own system faces, which cost a
 * round trip to nobody.
 */
import { MANDATE_NOTE_MAX } from '../domain/negotiation.js';
import { PHOTO_SCRUB_JS } from './photoScrub.js';
import { isMoneyAction } from './credentials.js';
import { sealedScriptTag } from './sealedScript.js';

export function esc(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}

/** Where the two Patch images are served from. Long-cached and immutable. */
export const PATCH_HEADER_URL = '/assets/patch.png';
export const PATCH_FAVICON_URL = '/assets/favicon.png';

const CSS = `
  /* PIN boxes show their digits. Safari treats any masked box (type=password
     or -webkit-text-security) as a password: it offers to invent one and asks
     to save it on submit. A six-digit PIN typed on your own device is shown,
     the way a bank app shows it. */
  .pinbox{letter-spacing:.3em;font-variant-numeric:tabular-nums;}
  /* The attribute must win over any display rule below, or a hidden button shows. */
  [hidden]{display:none!important;}

:root {
  /* Palette — the public site's tokens, light first. */
  --paper:#F6F8F7; --ink:#1C2523; --line:#D3DBD8; --wash:#ECEFEE;
  --want:#B45309; --have:#0E7268; --accent:#6D28D9; --match:#6D28D9;
  --muted:#5C6A66; --card:#FFFFFF; --danger:#A3271F;
  --on-solid:#FFFFFF;
  /* Spacing scale. */
  --s1:.25rem; --s2:.5rem; --s3:.75rem; --s4:1rem; --s5:1.5rem; --s6:2rem; --s7:3rem;
  /* Type scale. */
  --t-xs:.78rem; --t-sm:.88rem; --t-md:1rem; --t-lg:1.18rem; --t-xl:1.5rem; --t-2xl:1.9rem;
  /* Shape. */
  --r-sm:10px; --r:14px; --r-pill:999px;
  --sans:'Sora',ui-sans-serif,system-ui,-apple-system,'Segoe UI',sans-serif;
  --serif:'Newsreader',ui-serif,Georgia,'Times New Roman',serif;
  --mono:'IBM Plex Mono',ui-monospace,'SF Mono',Menlo,Consolas,monospace;
  color-scheme: light dark;
}
@media (prefers-color-scheme: dark) {
  :root {
    --paper:#101614; --ink:#E6ECE9; --line:#2A3733; --wash:#141C19;
    --want:#E0A24A; --have:#45B8A9; --accent:#A78BFA; --match:#A78BFA;
    --muted:#93A49F; --card:#17201D; --danger:#E2564C;
    --on-solid:#0F1412;
  }
}
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; background: var(--paper); }
body {
  margin:0; background:var(--paper); color:var(--ink);
  font-family:var(--serif); font-size:1.06rem; line-height:1.55;
  -webkit-font-smoothing:antialiased;
  overflow-wrap:break-word;
}
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { transition-duration:.01ms !important; animation-duration:.01ms !important; }
}
.wrap { max-width: 30rem; margin: 0 auto; padding: var(--s4) var(--s4) var(--s7); }

/* ---- Header & footer, the same on every page ---- */
header.site { display:flex; align-items:center; gap:var(--s3); padding: var(--s3) 0 var(--s6); }
header.site img.patch { width:63px; height:48px; flex:none; display:block; }
header.site a { color:var(--ink); text-decoration:none; display:block; }
header.site a:hover .brand { text-decoration:underline; text-underline-offset:3px; }
header.site .brand { font-family:var(--sans); font-weight:700; font-size:var(--t-md); letter-spacing:.01em; display:block; }
header.site .sub { color:var(--muted); font-size:var(--t-xs); font-family:var(--sans); font-weight:600;
  display:block; text-transform:uppercase; letter-spacing:.07em; margin-top:1px; }
footer { margin-top:var(--s7); padding-top:var(--s4); border-top:1px solid var(--line);
  color:var(--muted); font-size:var(--t-xs); font-family:var(--sans); line-height:1.5; }

/* ---- Type ---- */
h1 { font-family:var(--sans); font-weight:700; font-size:var(--t-2xl); line-height:1.15;
  letter-spacing:-.015em; margin:0 0 var(--s3); text-wrap:balance; }
h2 { font-family:var(--sans); font-weight:600; font-size:var(--t-lg); line-height:1.25;
  margin:var(--s6) 0 var(--s3); }
h3 { font-family:var(--sans); font-weight:600; font-size:var(--t-sm); text-transform:uppercase;
  letter-spacing:.07em; color:var(--muted); margin:var(--s5) 0 var(--s2); }
p { margin:var(--s2) 0 var(--s4); }
.muted { color:var(--muted); } .small { font-size:var(--t-sm); }
.lead { font-size:var(--t-lg); line-height:1.4; }
a { color:var(--accent); text-underline-offset:3px; }
:focus-visible { outline:3px solid var(--accent); outline-offset:2px; border-radius:4px; }
hr { border:0; border-top:1px solid var(--line); margin:var(--s6) 0; }

/* ---- Forms ---- */
form { margin:var(--s5) 0 0; }
label { display:block; font-family:var(--sans); font-weight:600; font-size:var(--t-sm);
  margin:var(--s4) 0 var(--s2); }
input[type=email], input[type=text], input[type=password], input[type=number], input[type=file],
select, textarea {
  width:100%; padding:.7rem .75rem; font-size:1.05rem; color:var(--ink);
  background:var(--card); border:1.5px solid var(--line); border-radius:var(--r-sm);
  font-family:var(--mono); }
input:focus-visible, select:focus-visible, textarea:focus-visible { border-color:var(--accent); }
textarea { min-height:6rem; line-height:1.5; }
input.code { font-size:1.7rem; letter-spacing:.4em; text-align:center; }
.field-help { font-size:var(--t-sm); color:var(--muted); margin:var(--s2) 0 0; }

/* ---- Buttons: primary, secondary, approve, danger ---- */
button, .btn { display:block; width:100%; margin-top:var(--s4); padding:.85rem 1rem;
  border:1.5px solid var(--ink); border-radius:var(--r-pill); background:var(--ink); color:var(--paper);
  font-family:var(--sans); font-weight:600; font-size:var(--t-md); line-height:1.3;
  cursor:pointer; text-align:center; text-decoration:none; }
button:hover, .btn:hover { opacity:.88; }
button:disabled { opacity:.6; cursor:default; }
button.secondary, .btn.secondary { background:transparent; color:var(--ink); border-color:var(--line); }
button.danger, .btn.danger { background:var(--danger); color:var(--on-solid); border-color:var(--danger); }
button.approve, .btn.approve { background:var(--have); color:var(--on-solid); border-color:var(--have); }
.btn.quiet { background:transparent; color:var(--ink); border-color:transparent;
  text-align:left; padding:.7rem 0; font-weight:600; }
.actions { display:flex; flex-direction:column; gap:var(--s2); margin:var(--s5) 0 0; }
.actions > form { margin:0; } .actions button, .actions .btn { margin-top:0; }

/* ---- Boxes ---- */
.err { background:color-mix(in srgb, var(--danger) 12%, var(--paper)); border:1.5px solid var(--danger);
  border-radius:var(--r-sm); padding:var(--s3) var(--s4); font-size:var(--t-sm); margin:var(--s4) 0; }
.note { border:1px solid var(--line); background:var(--wash); border-radius:var(--r-sm);
  padding:var(--s3) var(--s4); font-size:var(--t-sm); color:var(--muted); margin:var(--s4) 0; }
.note strong, .err strong { color:var(--ink); }
.panel { border:1px solid var(--line); background:var(--card); border-radius:var(--r);
  padding:var(--s4); margin:var(--s4) 0; }

/* ---- Facts: the numbers a decision turns on ---- */
.facts { margin:var(--s5) 0; }
.fact { border:1px solid var(--line); background:var(--card); border-radius:var(--r);
  padding:var(--s4); margin:var(--s3) 0; }
.fact .k { font-family:var(--sans); font-weight:600; font-size:var(--t-xs); color:var(--muted);
  text-transform:uppercase; letter-spacing:.06em; }
.fact .v { font-family:var(--mono); font-size:1.4rem; margin-top:2px; overflow-wrap:anywhere; }
.headline { border:2px solid var(--accent); background:var(--card); border-radius:var(--r);
  padding:var(--s4); margin:var(--s4) 0; }
.headline .k { font-family:var(--sans); font-weight:600; font-size:var(--t-xs); color:var(--muted);
  text-transform:uppercase; letter-spacing:.06em; }
.headline .v { font-family:var(--mono); font-size:2rem; line-height:1.15; margin-top:var(--s1);
  overflow-wrap:anywhere; }

/* ---- Rows: wants and haves, keys, offers ---- */
.card-row { border:1px solid var(--line); background:var(--card); border-radius:var(--r);
  padding:var(--s4); margin:var(--s3) 0; }
.card-row .top { display:flex; gap:var(--s2); align-items:center; flex-wrap:wrap; }
.badge { font-family:var(--sans); font-weight:700; font-size:.7rem; letter-spacing:.05em;
  padding:.2rem .55rem; border-radius:var(--r-pill); color:var(--on-solid); white-space:nowrap; }
.badge.want { background:var(--want); } .badge.have { background:var(--have); }
.badge.state { background:transparent; color:var(--muted); border:1px solid var(--line); font-weight:600; }
.badge.match { background:var(--accent); }
.cat { font-family:var(--mono); font-size:var(--t-sm); overflow-wrap:anywhere; min-width:0; }
.kv { font-family:var(--mono); font-size:var(--t-sm); color:var(--muted); margin-top:var(--s2);
  overflow-wrap:anywhere; }
.row-actions { display:flex; gap:var(--s2); margin-top:var(--s3); flex-wrap:wrap; }
.row-actions form { margin:0; flex:1 1 7rem; }
.row-actions > .btn { flex:1 1 7rem; }
.row-actions .btn, .row-actions button { margin-top:0; padding:.5rem .7rem; font-size:var(--t-sm);
  white-space:nowrap; min-height:44px; }

/* ---- Waiting-on-you action tiles (the dashboard's first screen) ---- */
.todo { display:block; border:1.5px solid var(--line); background:var(--card); border-radius:var(--r);
  padding:var(--s4); margin:var(--s3) 0; text-decoration:none; color:var(--ink); }
.todo:hover { border-color:var(--accent); }
.todo.urgent { border-color:var(--accent); }
.todo .what { font-family:var(--sans); font-weight:600; font-size:var(--t-md); line-height:1.35;
  margin-top:var(--s2); }
.todo .figure { font-family:var(--mono); font-size:1.35rem; margin-top:var(--s1); }
.todo .go { font-family:var(--sans); font-weight:600; font-size:var(--t-sm); color:var(--accent);
  margin-top:var(--s3); }
.todo .go::after { content:' →'; }
.empty { color:var(--muted); font-size:var(--t-sm); border:1px dashed var(--line);
  border-radius:var(--r); padding:var(--s4); margin:var(--s3) 0; }

/* ---- One box per match: its story as a timeline, its buttons underneath ---- */
.matchbox { border:1.5px solid var(--accent); background:var(--card); border-radius:var(--r);
  padding:var(--s4); margin:var(--s3) 0; }
h3.mb-title { font-family:var(--sans); font-weight:700; font-size:var(--t-lg); line-height:1.3;
  text-transform:none; letter-spacing:0; color:var(--ink); margin:var(--s2) 0 var(--s3);
  overflow-wrap:anywhere; }
ol.story { list-style:none; margin:0; padding:0; }
ol.story > li { position:relative; padding:0 0 var(--s3) 1.6rem; }
ol.story > li:last-child { padding-bottom:0; }
/* The line down the left: from this dot to the next one. */
ol.story > li::before { content:''; position:absolute; left:calc(.45rem - 1px); top:.55rem;
  bottom:-.45rem; width:2px; background:var(--line); }
ol.story > li:last-child::before { display:none; }
ol.story .dot { position:absolute; left:.1rem; top:.4rem; width:.7rem; height:.7rem;
  border-radius:50%; background:var(--line); border:2px solid var(--line); box-sizing:border-box; }
ol.story li.now .dot { background:var(--card); border-color:var(--accent); border-width:2.5px; }
.st-line { font-family:var(--sans); font-size:var(--t-sm); line-height:1.4; }
ol.story li.past .st-line { color:var(--muted); }
ol.story li.now .st-line { color:var(--ink); font-weight:600; }
.st-tag { display:inline-block; font-family:var(--sans); font-weight:600; font-size:.7rem;
  letter-spacing:.03em; padding:.05rem .45rem; border-radius:var(--r-pill);
  border:1px solid var(--line); color:var(--muted); white-space:nowrap; vertical-align:1px; }
ol.story li.now .st-tag { border-color:var(--accent); color:var(--accent); }
.st-quote { margin:var(--s1) 0 0; padding-left:var(--s3); border-left:2px solid var(--line);
  font-style:italic; font-size:var(--t-sm); color:var(--ink); overflow-wrap:anywhere; }
ol.story li.past .st-quote { color:var(--muted); }
.st-when { font-family:var(--mono); font-size:var(--t-xs); color:var(--muted); margin-top:2px; }
.story-more { font-family:var(--sans); font-size:var(--t-xs); color:var(--muted); margin:0 0 var(--s2); }
.mb-actions { display:flex; flex-wrap:wrap; gap:var(--s2); margin-top:var(--s4); }
.mb-actions .btn { flex:1 1 11rem; margin-top:0; padding:.7rem 1rem; font-size:var(--t-sm); }

/* ---- Past connections: finished, filed away, kept for retrieval ---- */
.past-connections { border-top:1px solid var(--line); margin:var(--s5) 0 0; padding-top:var(--s4); }
.small-head { font-family:var(--sans); font-weight:700; font-size:var(--t-md); margin:0 0 var(--s2); }
.card-row.past { background:transparent; border-style:dashed; opacity:.85; }

/* ---- Quiet navigation, below the decisions ---- */
.navlist { border-top:1px solid var(--line); margin:var(--s5) 0 0; }
.navlist > a { display:block; border-bottom:1px solid var(--line); padding:var(--s3) 0;
  text-decoration:none; color:var(--ink); }
.navlist > a:hover .nav-t { text-decoration:underline; text-underline-offset:3px; }
.navlist .nav-t { display:block; font-family:var(--sans); font-weight:600; font-size:var(--t-md); }
.navlist .nav-t::after { content:' →'; color:var(--muted); }
.navlist .nav-d { display:block; font-size:var(--t-sm); color:var(--muted); margin-top:2px; line-height:1.4; }
/* A row that is a fact rather than a door: same rule, no arrow, no hover. */
.navlist .row { display:block; border-bottom:1px solid var(--line); padding:var(--s3) 0; color:var(--ink); }
.navlist .row .nav-t::after { content:none; }

/* ---- Collapsible supporting detail ---- */
details.more { border:1px solid var(--line); border-radius:var(--r); background:var(--card);
  margin:var(--s4) 0; }
details.more > summary { font-family:var(--sans); font-weight:600; font-size:var(--t-sm);
  padding:var(--s3) var(--s4); cursor:pointer; list-style:none; }
details.more > summary::-webkit-details-marker { display:none; }
details.more > summary::after { content:' +'; color:var(--muted); }
details.more[open] > summary::after { content:' –'; }
details.more > .inner { padding:0 var(--s4) var(--s4); }
details.more > .inner > :first-child { margin-top:0; }
details.more form { margin-top:var(--s3); }

/* ---- A set of radio buttons under one question ---- */
fieldset.choice { border:0; padding:0; margin:var(--s4) 0 0; min-width:0; }
fieldset.choice > legend { font-family:var(--sans); font-weight:600; font-size:var(--t-sm);
  padding:0; margin:0 0 var(--s2); }
fieldset.choice label { display:flex; gap:var(--s3); align-items:flex-start; margin:var(--s2) 0;
  font-family:var(--serif); font-weight:400; font-size:var(--t-md); }
fieldset.choice input { width:1.2rem; height:1.2rem; margin-top:.25rem; flex:none; }

/* ---- Consent checkboxes ---- */
.consent-box { border:1.5px solid var(--line); background:var(--card); border-radius:var(--r);
  padding:var(--s4); margin:var(--s4) 0; }
.consent-box label { display:flex; gap:var(--s3); align-items:flex-start; margin:var(--s3) 0;
  font-family:var(--serif); font-weight:400; font-size:var(--t-md); line-height:1.5; }
.consent-box input { width:1.2rem; height:1.2rem; margin-top:.25rem; flex:none; }

/* ---- Radio options (negotiation mode) ---- */
label.modeopt { display:grid; grid-template-columns:1.2rem 1fr; gap:var(--s2) var(--s3);
  align-items:start; border:1.5px solid var(--line); background:var(--card);
  border-radius:var(--r); padding:var(--s4); margin:var(--s3) 0; font-weight:400; }
label.modeopt input { width:1.2rem; height:1.2rem; margin:.2rem 0 0; grid-row:span 2; }
label.modeopt strong { font-family:var(--sans); font-size:var(--t-md); }
label.modeopt span { grid-column:2; }
/* The same two options side by side once there is room for them. */
.modegrid { display:grid; grid-template-columns:1fr; gap:var(--s2); }
.modegrid label.modeopt { margin:0; }
@media (min-width: 27rem) { .modegrid { grid-template-columns:1fr 1fr; } }

/* ---- The shelf page: a search box over every shelf, rows to tap ---- */
.searchrow { display:flex; gap:var(--s2); align-items:stretch; }
.searchrow input { flex:1 1 auto; min-width:0; }
.searchrow button { width:auto; flex:none; margin-top:0; padding:.7rem 1rem; }
.shelves { list-style:none; margin:var(--s3) 0 0; padding:0; }
.shelves li { margin:var(--s2) 0; }
button.shelf { margin-top:0; text-align:left; background:var(--card); color:var(--ink);
  border:1.5px solid var(--line); border-radius:var(--r); padding:var(--s3) var(--s4); }
button.shelf:hover { opacity:1; border-color:var(--accent); }
button.shelf .sl { display:block; font-family:var(--sans); font-weight:600; font-size:var(--t-md); }
button.shelf .su { display:block; font-family:var(--serif); font-weight:400; font-size:var(--t-sm);
  color:var(--muted); margin-top:2px; }

/* ---- The kill switch keeps its own frame ---- */
.kill { border:2px solid var(--danger); border-radius:var(--r); padding:var(--s4); margin:var(--s6) 0 0; }
.kill h2 { margin-top:0; }
`;

/**
 * Every <time data-local> the pages print starts as UTC and ends up in the
 * reader's own timezone here. No suffix is added: once it is their clock, the
 * words are theirs too.
 */
const LOCAL_TIME_SCRIPT = `<script>
(function () {
  var shapes = {
    minute: { dateStyle: 'medium', timeStyle: 'short' },
    day: { weekday: 'long', day: 'numeric', month: 'long' },
    short: { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }
  };
  var nodes = document.querySelectorAll('time[data-local]');
  for (var i = 0; i < nodes.length; i++) {
    var el = nodes[i];
    var at = new Date(el.getAttribute('datetime'));
    if (isNaN(at.getTime())) continue;
    try {
      el.textContent = new Intl.DateTimeFormat(
        undefined,
        shapes[el.getAttribute('data-local')] || shapes.minute
      ).format(at);
    } catch (e) {}
  }
})();
</script>`;

/**
 * One press per form, on every page.
 *
 * A code filled in from the mail app submits the form by itself, and nothing
 * on the page said so: the button still looked ready, so people pressed it,
 * the second press arrived after the code had been used, and they were told
 * their code was no good when it had just worked. The same goes for any page
 * whose answer takes a moment.
 *
 * So the first submit of an ordinary form locks its buttons and says it is
 * working, and a second submit is dropped. The buttons are locked a tick
 * AFTER the submit, because a disabled button's name and value are left out
 * of what the browser sends and several forms here tell their buttons apart
 * that way. Nothing unlocks on failure because a failure is a fresh page. A
 * page brought back from the back-forward cache is unlocked again.
 * The one-question form is pressed in place by the script below and locks
 * its own buttons, so it is left alone here.
 */
const SUBMIT_ONCE_SCRIPT = `<script>
(function(){
  document.addEventListener('submit',function(e){
    var f=e.target;if(!f||f.nodeName!=='FORM'||f.id==='oneQuestion')return;
    if(f.getAttribute('data-sent')){e.preventDefault();return;}
    if(e.defaultPrevented)return;
    f.setAttribute('data-sent','1');f.setAttribute('aria-busy','true');
    var sub=e.submitter;
    setTimeout(function(){
      var b=f.querySelectorAll('button,input[type=submit]');
      for(var i=0;i<b.length;i++){b[i].disabled=true;}
      if(sub&&sub.nodeName==='BUTTON'){sub.setAttribute('data-label',sub.textContent);sub.textContent='Working\u2026';}
    },0);
  });
  window.addEventListener('pageshow',function(ev){
    if(!ev.persisted)return;
    var fs=document.querySelectorAll('form[data-sent]');
    for(var i=0;i<fs.length;i++){var f=fs[i];f.removeAttribute('data-sent');f.removeAttribute('aria-busy');
      var b=f.querySelectorAll('button,input[type=submit]');
      for(var j=0;j<b.length;j++){b[j].disabled=false;var l=b[j].getAttribute('data-label');if(l){b[j].textContent=l;b[j].removeAttribute('data-label');}}}
  });
})();
</script>`;

export function layout(
  title: string,
  body: string,
  opts: {
    head?: string;
    /**
     * A page that types or shows an address or a phone number (sealed contact
     * details). It carries none of the inline scripts below, because its
     * policy allows no inline script at all (app.ts, osbSealedPage): the only
     * script on it is the one it names itself, from this origin, with SRI.
     */
    sealed?: boolean;
  } = {},
): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(title)} — OpenSwitchboard</title>
<link rel="icon" type="image/png" href="${PATCH_FAVICON_URL}">
<link rel="apple-touch-icon" href="${PATCH_FAVICON_URL}">
<style>${CSS}</style>${opts.head ?? ''}</head><body>
<div class="wrap">
<header class="site">
  <img class="patch" src="${PATCH_HEADER_URL}" width="63" height="48" alt="" aria-hidden="true">
  <a href="/"><span class="brand">OpenSwitchboard</span><span class="sub">your main page</span></a>
</header>
<main id="page">
${body}
</main>
<footer>openswitchboard.ai</footer>
</div>
${opts.sealed ? '' : `${LOCAL_TIME_SCRIPT}${SUBMIT_ONCE_SCRIPT}${IN_PLACE_SCRIPT}`}</body></html>`;
}

export const errBox = (msg?: string) =>
  msg ? `<div class="err" role="alert">${esc(msg)}</div>` : '';

/** Supporting detail, folded away until someone wants it. */
export function foldedDetail(summary: string, inner: string, open = false): string {
  return `<details class="more"${open ? ' open' : ''}>
  <summary>${esc(summary)}</summary>
  <div class="inner">${inner}</div>
</details>`;
}

// ---------------------------------------------------------------------------

export function landingPage(): string {
  return layout('Your main page', `
<h1>Your main page.</h1>
<p class="lead">Your assistant works the switchboard. This page is where you do
everything it never can.</p>
<div class="actions">
  <a class="btn" href="/register">Open an account</a>
  <a class="btn secondary" href="/login">Sign in</a>
</div>
${foldedDetail(
  'What happens here',
  `<p class="small">Your assistant posts your wants and haves, checks matches and
negotiates. Opening the account, choosing how you approve things, approving what gets shared
or paid, reading the ledger and pulling the plug all happen on this page, with
you signed in.</p>`,
)}`);
}

export function registerEmailPage(error?: string): string {
  return layout('Open an account', `
<h1>Open an account.</h1>
<p class="lead">We'll email you a six-digit code to prove this address is yours.</p>
${errBox(error)}
<form method="POST" action="/register">
  <label for="email">Email</label>
  <input id="email" name="email" type="email" autocomplete="email" required autofocus>
  <button type="submit">Email me a code</button>
</form>
<p class="small muted">Already have an account? <a href="/login">Sign in</a>.</p>`);
}

export function codeEntryPage(params: {
  verificationId: string;
  action: string; // form target
  error?: string;
  heading?: string;
}): string {
  return layout('Enter your code', `
<h1>${esc(params.heading ?? 'Check your email.')}</h1>
<p class="lead">Enter the six-digit code we just sent. It works once and expires in 15 minutes.</p>
${errBox(params.error)}
<form method="POST" action="${esc(params.action)}">
  <input type="hidden" name="verification_id" value="${esc(params.verificationId)}">
  <label for="code">Code</label>
  <input id="code" name="code" type="text" class="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required autofocus>
  <button type="submit">Continue</button>
</form>`);
}

const PIN_FIELDS = `  <label for="pin">PIN</label>
  <input id="pin" name="pin" type="text" class="pinbox" inputmode="numeric" autocomplete="off" spellcheck="false" data-1p-ignore data-lpignore="true" data-bwignore pattern="[0-9]{6,12}" minlength="6" maxlength="12" aria-describedby="pin-help" required>
  <p class="field-help" id="pin-help">Six or more digits.</p>
  <label for="pin2">PIN again</label>
  <input id="pin2" name="pin2" type="text" class="pinbox" inputmode="numeric" autocomplete="off" spellcheck="false" data-1p-ignore data-lpignore="true" data-bwignore pattern="[0-9]{6,12}" minlength="6" maxlength="12" required>`;

export function pinSetPage(error?: string, v?: { hasPin?: boolean }): string {
  const title = v?.hasPin ? 'Change your PIN' : 'Set a PIN';
  return layout(title, `
<h1>${v?.hasPin ? 'Change your PIN.' : 'Set a PIN.'}</h1>
<p class="lead">Your PIN approves what you share and what you pay.</p>
${errBox(error)}
<form method="POST" action="/pin/set">
${PIN_FIELDS}
  <button type="submit">${v?.hasPin ? 'Change my PIN' : 'Set my PIN'}</button>
</form>
<p class="small muted">Sharing your name, payments and turning things back on all ask
for it. It never goes to your assistant.</p>
<p class="small muted">Keep this PIN to yourself. Do not give it to your assistant; the PIN is how we know it is you.</p>`);
}

const WEBAUTHN_HELPERS = `<script>
function b64uToBuf(s){s=s.replace(/-/g,'+').replace(/_/g,'/');const p=s.length%4?4-(s.length%4):0;
  const b=atob(s+'='.repeat(p));const a=new Uint8Array(b.length);for(let i=0;i<b.length;i++)a[i]=b.charCodeAt(i);return a.buffer;}
function bufToB64u(b){const a=new Uint8Array(b);let s='';for(const x of a)s+=String.fromCharCode(x);
  return btoa(s).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,'');}
async function postJson(url,body){const r=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},
  body:JSON.stringify(body||{}),credentials:'same-origin'});
  if(!r.ok)throw new Error((await r.text())||('HTTP '+r.status));return r.json();}
</script>`;

// ---------------------------------------------------------------------------
// The sensitive-action ceremony, in one place.
//
// A PIN is no longer the only way to hold an account (2026-09-16). A person
// can finish registration with a passkey and never set one, so every page that
// used to print a PIN box has to ask for whichever credential the account
// actually holds.
//
// WHY A PASSKEY ALONE IS ENOUGH, since the question comes up on every one of
// these pages:
//   - getting back in after losing everything is an emailed code either way,
//     so a PIN adds nothing to what recovery can do;
//   - a PIN is the only credential on the account a phishing page could ever
//     harvest, because it is the only one a person can read out and type;
//   - a passkey cannot be handed over, even by someone who wants to hand it
//     over, because the private half never leaves the device.
// A PIN stays on offer for a device that cannot make a passkey, and for the
// person who sets a passkey on a laptop and then presses an approval link on
// a phone that has never seen it.
//
// Three states, and the helpers below render all three:
//   elevated            — a ceremony already happened in the last few minutes;
//                         the form carries an empty PIN field and asks nothing.
//   a PIN on the account — the PIN box, plus a passkey button beside it where
//                         the account also holds a passkey.
//   a passkey and no PIN — no box at all: the action button IS the ceremony,
//                         and the emailed-code way through is written on the
//                         page for the device that has no passkey on it.
// ---------------------------------------------------------------------------
export interface CeremonyView {
  /** This account has a PIN set. */
  hasPin: boolean;
  /** This account holds at least one passkey. */
  hasPasskey: boolean;
  /** Inside a PIN or passkey ceremony's window: nothing more is asked. */
  elevated: boolean;
  /** A press that moves money (credentials.ts MONEY_ACTIONS). It never leans
   *  on the window, and a passkey rides along inside the form itself, so the
   *  server sees the ceremony at the moment of the press. */
  money?: boolean;
  /** A press that ignores the window without moving money: deleting the
   *  account. It behaves as a money press does and says so in its own words. */
  fresh?: boolean;
}

/**
 * The ceremony a money press shows: whatever the account holds, asked for now,
 * whatever window a sign-in or an earlier press opened.
 */
export function moneyCeremony(v: CeremonyView): CeremonyView {
  return { hasPin: v.hasPin, hasPasskey: v.hasPasskey, elevated: false, money: true };
}

/** The same, for a press that moves no money: deleting the account. */
export function freshCeremony(v: CeremonyView): CeremonyView {
  return { hasPin: v.hasPin, hasPasskey: v.hasPasskey, elevated: false, fresh: true };
}

/** True where the button itself has to run the passkey ceremony first. */
export function passkeyOnlyCeremony(v: CeremonyView): boolean {
  return !v.elevated && !v.hasPin && v.hasPasskey;
}

/**
 * The PIN box, the hidden field an elevated session needs, or nothing at all
 * on a passkey-only account.
 *
 * `which` makes the id unique, because two of these can stand on one page: a
 * seller looking at a returned item they can close AND a split the buyer has
 * put up are both money-moving and both theirs to press. Two inputs sharing an
 * id would leave the second one's label pointing at the first one's box.
 */
export function ceremonyField(v: CeremonyView, which: string): string {
  if (v.elevated) return `<input type="hidden" name="pin" value="">`;
  if (!v.hasPin) return `<input type="hidden" name="pin" value="">`;
  return `<label for="pin-${which}">Confirm with your PIN</label>
         <input id="pin-${which}" name="pin" type="text" class="pinbox" inputmode="numeric" autocomplete="off" spellcheck="false" data-1p-ignore data-lpignore="true" data-bwignore pattern="[0-9]{6,12}" maxlength="12" required>`;
}

/**
 * The button that carries the action. On a passkey-only account it runs the
 * passkey ceremony and then submits the form it belongs to; everywhere else it
 * is an ordinary submit button and the PIN box beside it does the work.
 */
export function ceremonySubmit(
  v: CeremonyView,
  opts: {
    formId: string;
    label: string;
    className?: string;
    name?: string;
    value?: string;
    /** Where the submission should land, for a form that opens a new tab. */
    formTarget?: string;
    /** A press an emailed code cannot stand behind, so a failed passkey is
     *  not told to have one emailed. */
    strong?: boolean;
  },
): string {
  const cls = opts.className ? ` class="${esc(opts.className)}"` : '';
  const nv = opts.name ? ` name="${esc(opts.name)}" value="${esc(opts.value ?? '')}"` : '';
  const tgt = opts.formTarget ? ` formtarget="${esc(opts.formTarget)}"` : '';
  const inline = v.money || v.fresh ? ' data-pk-inline="1"' : '';
  if (!passkeyOnlyCeremony(v)) {
    return `<button type="submit"${nv}${tgt}${cls}>${esc(opts.label)}</button>`;
  }
  const data = opts.name
    ? ` data-pk-name="${esc(opts.name)}" data-pk-value="${esc(opts.value ?? '')}"`
    : '';
  const pkTgt = opts.formTarget ? ` data-pk-target="${esc(opts.formTarget)}"` : '';
  const fallback = opts.strong ? 'retry' : 'code';
  return `<button type="button" data-pk-form="${esc(opts.formId)}" data-pk-fallback="${fallback}"${data}${pkTgt}${inline}${cls}>${esc(opts.label)}</button><div class="err-slot" data-pk-err role="alert" hidden></div>`;
}

/**
 * The passkey button beside a PIN box, for an account that holds both. It
 * submits the same form the PIN box belongs to, so where that form has more
 * than one thing it could be saying — approve or deny — it has to carry the
 * same name and value the button it stands in for would have sent.
 */
export function ceremonyAlt(
  v: CeremonyView,
  formId: string,
  opts: { name?: string; value?: string; formTarget?: string } = {},
): string {
  if (v.elevated || !v.hasPasskey || !v.hasPin) return '';
  const data = opts.name
    ? ` data-pk-name="${esc(opts.name)}" data-pk-value="${esc(opts.value ?? '')}"`
    : '';
  const tgt = opts.formTarget ? ` data-pk-target="${esc(opts.formTarget)}"` : '';
  const inline = v.money || v.fresh ? ' data-pk-inline="1"' : '';
  return `<button type="button" class="secondary" data-pk-form="${esc(formId)}" data-pk-fallback="pin"${data}${tgt}${inline}>Use your passkey instead</button><div class="err-slot" data-pk-err role="alert" hidden></div>`;
}

/**
 * The plain line under a ceremony: what this press takes, and — on a passkey
 * with no PIN — the way through on a device that has never seen that passkey.
 * The emailed code is the same code that signs a person in, so nobody is left
 * staring at a box they cannot fill.
 */
export function ceremonyNote(v: CeremonyView): string {
  const t = ceremonyNoteInner(v);
  return t ? `<p class="small muted">${t}</p>` : '';
}

/** The same line without its paragraph, for a page that puts it beside
 *  another short line. Server-built HTML: it may carry a link. */
export function ceremonyNoteInner(v: CeremonyView): string {
  if (v.elevated) return '';
  if (v.money) {
    if (passkeyOnlyCeremony(v)) {
      return `Money takes your passkey every time. On a device that does
not have it, open this on one that does, or <a href="/pin">set a PIN</a> to use here.`;
    }
    if (v.hasPin && v.hasPasskey) return 'Money takes your PIN or your passkey every time.';
    return 'Money takes your PIN every time.';
  }
  if (v.fresh) {
    if (passkeyOnlyCeremony(v)) {
      return `This takes your passkey every time. On a device that does
not have it, open this on one that does, or <a href="/pin">set a PIN</a> to use here.`;
    }
    if (v.hasPin && v.hasPasskey) return 'This takes your PIN or your passkey every time.';
    return 'This takes your PIN every time.';
  }
  if (passkeyOnlyCeremony(v)) {
    return `This takes your passkey. On a device that does not
have it, <a href="/confirm/code">have a code emailed to you</a> and press it from your own
page once you are back in.`;
  }
  if (v.hasPin && v.hasPasskey) return 'This takes your PIN or your passkey.';
  return 'This takes your PIN.';
}

/**
 * What a passkey button says when the passkey did not come through. The
 * browser's own words ("NotAllowedError: The operation either timed out or
 * was not allowed") mean nothing to a person, so they are never shown; the
 * line says what to do instead, and the way out depends on what else the
 * account holds.
 */
export const PASSKEY_FAILED_PIN = "That didn't work. Try again, or use your PIN.";
export const PASSKEY_FAILED_CODE = "That didn't work. Try again, or have a code emailed.";
export const PASSKEY_FAILED_RETRY = "That didn't work. Try again.";

/**
 * The one passkey handler for a whole page. Any number of buttons can carry
 * `data-pk-form`; the click runs the assertion, elevates the session, and
 * submits that button's form with whatever the button was going to send.
 */
export const CEREMONY_SCRIPT = `${WEBAUTHN_HELPERS}<script>
document.addEventListener('click', async function(ev){
  var btn = ev.target && ev.target.closest && ev.target.closest('button[data-pk-form]');
  if(!btn) return;
  ev.preventDefault();
  var form = document.getElementById(btn.getAttribute('data-pk-form'));
  if(!form) return;
  var slot = btn.nextElementSibling && btn.nextElementSibling.hasAttribute('data-pk-err')
    ? btn.nextElementSibling : null;
  // The PIN box is the only field a passkey replaces; everything else on the
  // form still has to be filled in before a ceremony is worth running.
  var pins = form.querySelectorAll('input[name="pin"]');
  for (var i=0;i<pins.length;i++) pins[i].removeAttribute('required');
  if (form.reportValidity && !form.reportValidity()) return;
  btn.disabled = true;
  try {
    var opts = await postJson('/login/passkey/options');
    opts.challenge = b64uToBuf(opts.challenge);
    (opts.allowCredentials||[]).forEach(function(c){c.id=b64uToBuf(c.id);});
    var cred = await navigator.credentials.get({ publicKey: opts });
    var assertion = { id: cred.id, rawId: bufToB64u(cred.rawId), type: cred.type,
      response: { clientDataJSON: bufToB64u(cred.response.clientDataJSON),
                  authenticatorData: bufToB64u(cred.response.authenticatorData),
                  signature: bufToB64u(cred.response.signature),
                  userHandle: cred.response.userHandle ? bufToB64u(cred.response.userHandle) : null },
      clientExtensionResults: cred.getClientExtensionResults() };
    if (btn.getAttribute('data-pk-inline')) {
      // A money press: the assertion goes with the form and is checked at the
      // press itself, because a window opened earlier does not count for money.
      var pk = document.createElement('input'); pk.type='hidden';
      pk.name = 'passkey'; pk.value = JSON.stringify(assertion);
      form.appendChild(pk);
    } else {
      assertion.elevate_only = true;
      await postJson('/login/passkey/verify', assertion);
    }
    if (btn.getAttribute('data-pk-name')) {
      var h = document.createElement('input'); h.type='hidden';
      h.name = btn.getAttribute('data-pk-name'); h.value = btn.getAttribute('data-pk-value')||'';
      form.appendChild(h);
    }
    // form.submit() ignores a button's formtarget, so a form that was going
    // to open a new tab has to be told on the form itself.
    if (btn.getAttribute('data-pk-target')) form.target = btn.getAttribute('data-pk-target');
    form.submit();
  } catch (e) {
    btn.disabled = false;
    for (var j=0;j<pins.length;j++) pins[j].setAttribute('required','');
    if (slot) { slot.hidden = false; slot.innerHTML = '<div class="err">'
      + (btn.getAttribute('data-pk-fallback') === 'pin' ? ${JSON.stringify(PASSKEY_FAILED_PIN)}
        : btn.getAttribute('data-pk-fallback') === 'retry' ? ${JSON.stringify(PASSKEY_FAILED_RETRY)}
        : ${JSON.stringify(PASSKEY_FAILED_CODE)})
      + '</div>'; }
  }
});
</script>`;

/** The script goes on a page only where something on it can use a passkey. */
export function ceremonyScript(...views: CeremonyView[]): string {
  return views.some((v) => !v.elevated && v.hasPasskey) ? CEREMONY_SCRIPT : '';
}

/**
 * The enrolment ceremony, as a script. `ENROL_SCRIPT(buttonId)` wires one
 * button to /passkey/options + /passkey/verify and follows the `next` the
 * server hands back, so the same block serves the registration choice and the
 * add-one-later page.
 */
const ENROL_SCRIPT = (buttonId: string, errId: string, failed: string) => `${WEBAUTHN_HELPERS}<script>
document.getElementById('${buttonId}').addEventListener('click', async () => {
  try {
    const opts = await postJson('/passkey/options');
    opts.challenge = b64uToBuf(opts.challenge);
    opts.user.id = b64uToBuf(opts.user.id);
    (opts.excludeCredentials||[]).forEach(c=>c.id=b64uToBuf(c.id));
    const cred = await navigator.credentials.create({ publicKey: opts });
    const body = { id: cred.id, rawId: bufToB64u(cred.rawId), type: cred.type,
      response: { clientDataJSON: bufToB64u(cred.response.clientDataJSON),
                  attestationObject: bufToB64u(cred.response.attestationObject),
                  transports: cred.response.getTransports ? cred.response.getTransports() : [] },
      clientExtensionResults: cred.getClientExtensionResults() };
    const r = await postJson('/passkey/verify', body);
    location.href = r.next || '/';
  } catch (e) {
    document.getElementById('${errId}').innerHTML = '<div class="err">' + ${JSON.stringify(failed)} + '</div>';
  }
});
</script>`;

/**
 * Only the browser knows whether this device can make a passkey, so the offer
 * is hidden markup until it says so. Where the answer is no, or where the
 * question cannot be asked at all, the page stands as the PIN alone: a button
 * that cannot work is worse than a button that was never there.
 */
const PLATFORM_AUTHENTICATOR_PROBE = `<script>
(function(){
  var box = document.getElementById('pkoffer');
  if (!box) return;
  if (!window.PublicKeyCredential || !PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable) return;
  PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()
    .then(function(available){ if (available) { box.hidden = false; document.body.setAttribute('data-passkey','yes'); } })
    .catch(function(){});
})();
</script>`;

/**
 * The step that used to demand a PIN and nothing else (2026-09-16).
 *
 * A person picks how they will approve things: a passkey, where the device in
 * their hand can make one, or a PIN. Whichever they pick finishes registration
 * on its own — an account with a passkey needs no PIN, and the pages that ask
 * for a sensitive-action ceremony ask for whichever one the account holds.
 *
 * The passkey half is hidden until the browser reports a platform
 * authenticator, so a device that cannot make one is offered the PIN alone.
 */
export function credentialChoicePage(error?: string): string {
  return layout('How you approve things', `
<h1>How will you approve things?</h1>
<p class="lead">Sharing your details, accepting a figure and moving money all come
back to you. Pick how you say yes.</p>
${errBox(error)}
<div id="pkoffer" hidden>
  <h2>A passkey</h2>
  <p>A passkey uses the fingerprint or face check your device already has, so there is
  nothing for you to remember and nothing for you to type. We recommend it.</p>
  <div id="pkerr" role="alert"></div>
  <button id="enrol">Use a passkey</button>
</div>
<h2>A PIN</h2>
<p>A PIN is six or more digits you type. Every device can use one.</p>
<form method="POST" action="/pin/set">
${PIN_FIELDS}
  <button type="submit" class="secondary">Set my PIN</button>
</form>
<p class="small muted">You can add the other one later on your own page. Signing in on a
new device uses a code we email you either way.</p>
${PLATFORM_AUTHENTICATOR_PROBE}
${ENROL_SCRIPT('enrol', 'pkerr', PASSKEY_FAILED_PIN)}`);
}

export function passkeyOfferPage(v?: { hasPasskey?: boolean; skipLabel?: string; hasPin?: boolean }): string {
  return layout('Add a passkey', `
<h1>Add a passkey${v?.hasPasskey ? '' : '?'}</h1>
<p class="lead">${
    v?.hasPasskey
      ? 'You already have one. Do this on a device that does not, so that device can approve things too.'
      : 'Sign in and approve with Face ID, a fingerprint, or your device passcode. There is nothing to remember and nothing to type.'
  }</p>
<div id="pkerr" role="alert"></div>
<div class="actions">
  <button id="enrol">Add a passkey</button>
  <form method="POST" action="/passkey/skip"><button class="secondary" type="submit">${esc(v?.skipLabel ?? 'Skip for now')}</button></form>
</div>
${ENROL_SCRIPT('enrol', 'pkerr', v?.hasPin === false ? PASSKEY_FAILED_CODE : PASSKEY_FAILED_PIN)}`);
}

/**
 * Confirm it is you, before changing how you approve things. Adding or
 * changing either credential takes a fresh ceremony of whatever the account
 * holds now, so a borrowed session cannot quietly fit itself a key.
 */
export function confirmItsYouPage(v: CeremonyView, next: string, error?: string): string {
  // An emailed code does not change how you approve things (28 September
  // 2026), so a passkey-only account is not pointed at one here. The way
  // through for a lost passkey is its own page, which says what it does.
  const note = passkeyOnlyCeremony(v)
    ? `<p class="small muted">This takes your passkey. Lost it? <a href="/pin/recover">Set a PIN with a code we email you</a>.</p>`
    : ceremonyNote(v);
  return layout('Confirm it is you', `
<h1>Confirm it is you.</h1>
<p class="lead">Changing how you approve things takes the way you approve things now.</p>
${errBox(error)}
<form method="POST" action="/confirm" id="confirmForm">
  <input type="hidden" name="next" value="${esc(next)}">
  ${ceremonyField(v, 'confirm')}
  <div class="actions">
  ${ceremonySubmit(v, { formId: 'confirmForm', label: 'Confirm', className: 'approve' })}
  ${ceremonyAlt(v, 'confirmForm')}
  </div>
</form>
${note}
<a class="btn secondary" href="/security">Back</a>
${ceremonyScript(v)}`);
}

// ---------------------------------------------------------------------------
// Lost your passkey (28 September 2026).
//
// An account holding a passkey and no PIN, on a device that cannot produce the
// passkey. An emailed code sets a PIN here, and the page says plainly what that
// PIN can do and when: the everyday presses straight away, money and new ways
// in after 24 hours. We email the person the moment it is set.
// ---------------------------------------------------------------------------
export const RECOVERY_WAIT_LINE =
  'Straight away it can share your first name and suburb and keep conversations going. Money, a new passkey and a new assistant wait 24 hours.';

export function pinRecoverStartPage(): string {
  return layout('Lost your passkey?', `
<h1>Lost your passkey?</h1>
<p class="lead">Set a PIN with a code we email you.</p>
<p class="small muted">${esc(RECOVERY_WAIT_LINE)}</p>
<form method="POST" action="/pin/recover/code"><button type="submit">Email me a code</button></form>
<p class="small muted">We email you as soon as the PIN is set, so you will know if it was not you.
Your passkey keeps working.</p>
<a class="btn secondary" href="/">Back</a>`);
}

export function pinRecoverPage(error?: string): string {
  return layout('Set a PIN', `
<h1>Set a PIN.</h1>
<p class="lead">${esc(RECOVERY_WAIT_LINE)}</p>
${errBox(error)}
<form method="POST" action="/pin/recover">
${PIN_FIELDS}
  <button type="submit">Set my PIN</button>
</form>
<p class="small muted">Keep this PIN to yourself. Do not give it to your assistant; the PIN is how we know it is you.</p>`);
}

/** `from` is already the person's own clock, as plain text. */
export function pinRecoveredPage(from: string): string {
  return messagePage(
    'PIN set',
    `<p class="lead">A new PIN can move money from ${esc(from)}. Your passkey works now.</p>
<p>We have emailed you to say a PIN was set.</p>`,
    '/',
    'Back to your main page',
  );
}

/**
 * How you approve things, on your own page.
 *
 * A passkey that is set is a FACT, not a door: one approves everything here,
 * and a second only ever exists because a second device needs one. So it is
 * stated with the date it was set, and the way to enrol another device sits
 * inside that row rather than standing as a choice of its own.
 */
export function securityPage(
  v: {
    hasPin: boolean;
    passkeyCount: number;
    passkeySetOn?: string;
    passkeyKind?: string;
    /** Browsers set up to receive contact details, where the page is on. */
    receivers?: { keyId: string; setOn: string; lastSeen: string }[];
  },
  notice?: string,
): string {
  const receivers = v.receivers
    ? `<h2>Browsers that receive contact details</h2>
${
  v.receivers.length
    ? v.receivers
        .map(
          (r) => `<div class="row"><span class="nav-t">Set up ${esc(r.setOn)}</span>
<span class="nav-d">Last used ${esc(r.lastSeen)}</span>
<form method="POST" action="/contact-keys/remove"><input type="hidden" name="key_id" value="${esc(r.keyId)}"><button type="submit" class="secondary">Remove</button></form></div>`,
        )
        .join('\n')
    : '<p class="small muted">None yet. A browser is set up the first time someone sends you their details, or from your main page.</p>'
}`
    : '';
  const detail = [v.passkeyKind, v.passkeySetOn].filter(Boolean).join(', ');
  return layout('How you approve things', `
<h1>How you approve things.</h1>
${notice ? `<div class="note">${esc(notice)}</div>` : ''}
<div class="navlist">
${v.passkeyCount
    ? `<div class="row"><span class="nav-t">Passkey saved</span>
${detail ? `<span class="nav-d">${esc(detail)}</span>` : ''}
<span class="nav-d"><a href="/passkey">Add one on another device</a></span></div>`
    : `<a href="/passkey"><span class="nav-t">Add a passkey</span>
<span class="nav-d">Face, fingerprint or device passcode. Nothing to remember.</span></a>`}
<a href="/pin"><span class="nav-t">${v.hasPin ? 'Change your PIN' : 'Set a PIN'}</span>
<span class="nav-d">Six or more digits you type.</span></a>
</div>
<p class="small muted">Lost both? A code we email you signs you back in.</p>
${receivers}
<a class="btn secondary" href="/">Back</a>`);
}

export function loginEmailPage(error?: string): string {
  return layout('Sign in', `
<h1>Sign in.</h1>
${errBox(error)}
<div id="pkerr" role="alert"></div>
<button id="pk" class="secondary">Sign in with a passkey</button>
<form method="POST" action="/login">
  <label for="email">Or use email</label>
  <input id="email" name="email" type="email" autocomplete="email" required>
  <button type="submit">Email me a code</button>
</form>
<p class="small muted">New here? <a href="/register">Open an account</a>.</p>
${WEBAUTHN_HELPERS}
<script>
document.getElementById('pk').addEventListener('click', async () => {
  try {
    const opts = await postJson('/login/passkey/options');
    opts.challenge = b64uToBuf(opts.challenge);
    (opts.allowCredentials||[]).forEach(c=>c.id=b64uToBuf(c.id));
    const cred = await navigator.credentials.get({ publicKey: opts });
    const body = { id: cred.id, rawId: bufToB64u(cred.rawId), type: cred.type,
      response: { clientDataJSON: bufToB64u(cred.response.clientDataJSON),
                  authenticatorData: bufToB64u(cred.response.authenticatorData),
                  signature: bufToB64u(cred.response.signature),
                  userHandle: cred.response.userHandle ? bufToB64u(cred.response.userHandle) : null },
      clientExtensionResults: cred.getClientExtensionResults() };
    const r = await postJson('/login/passkey/verify', body);
    location.href = r.next || '/';
  } catch (e) {
    document.getElementById('pkerr').innerHTML = '<div class="err">' + ${JSON.stringify(PASSKEY_FAILED_CODE)} + '</div>';
  }
});
</script>`);
}

/** The one place safety can be written to about an account that was stopped. */
export const SAFETY_ADDRESS = 'safety@openswitchboard.ai';

/**
 * What a suspended person meets at every door on this surface.
 *
 * It says the one thing that is true and the one thing they can do. There is
 * no Back button: there is nowhere on these pages for them to go, and a button
 * offering one would just bring them back here.
 */
export function suspendedPage(): string {
  return layout('Account suspended', `<h1>This account is suspended.</h1>
<p class="lead">Nothing can be posted, sent or collected from it, and your wants
and haves have come down.</p>
<p>If you think this is wrong, write to <a href="mailto:${SAFETY_ADDRESS}">${SAFETY_ADDRESS}</a>
and a person will read it.</p>`);
}

export function messagePage(title: string, html: string, backHref = '/', backLabel = 'Back'): string {
  return layout(title, `<h1>${esc(title)}</h1>${html}
<a class="btn secondary" href="${esc(backHref)}">${esc(backLabel)}</a>`);
}

/**
 * The end of a page reached from a link the assistant handed over. There is
 * nothing else to do here and nowhere else to go: the conversation is back in
 * the assistant, so the page says so. No Close button: a page may only close
 * a tab a script opened, and a link handed over by a chat client is opened by
 * the browser itself, so the button failed almost every time it was pressed.
 */
const DONE_BLOCK = `<p class="lead" data-done>Done. Close this tab and carry on with your assistant.</p>
<button type="button" id="closeTab" hidden>Close</button>
<p class="small muted" id="closeHint" hidden>Your browser kept this tab open. Close it yourself and carry on with your assistant.</p>`;

/**
 * Two things, both about the tab a link opened.
 *
 * A one-question form is pressed in place: the answer is fetched and the page
 * body swapped, so the tab never gains a second history entry. That matters
 * because Chrome and Edge let a page close a tab that has no history behind
 * it, and a pressed link is exactly that. Where the swap cannot happen the
 * form submits the ordinary way and the sentence stands.
 *
 * On the finished page, if the tab has no history behind it, a Close button
 * appears beside the sentence. Safari and Firefox refuse the close whatever
 * the history, so if the tab is still here a beat later the hint takes over.
 */
/** The line a one-question page shows after a wrong PIN. */
export const PIN_WRONG_SENTENCE = 'That PIN is not right. Try again.';
/** What the in-place script says for a JSON refusal that carries no sentence. */
export const PRESS_FAILED_SENTENCE = 'That did not go through. Try again.';

const IN_PLACE_SCRIPT = `<script>
(function(){
  function armDone(){
    var b=document.getElementById('closeTab'),s=document.querySelector('[data-done]'),h=document.getElementById('closeHint');
    if(!b||!s||history.length!==1)return;
    s.textContent='Done. Back to your assistant.';b.hidden=false;
    b.addEventListener('click',function(){try{window.close();}catch(e){}
      setTimeout(function(){if(!document.hidden){b.hidden=true;h.hidden=false;s.textContent='Done. Close this tab and carry on with your assistant.';}},300);});
  }
  document.addEventListener('submit',function(e){
    var f=e.target;if(!f||f.id!=='oneQuestion'||!window.fetch||!window.DOMParser)return;
    e.preventDefault();
    var fd=new FormData(f);var sub=e.submitter;if(sub&&sub.name)fd.append(sub.name,sub.value);
    var btns=f.querySelectorAll('button');for(var i=0;i<btns.length;i++)btns[i].disabled=true;
    function showErr(j){
      var msg=j&&j.error==='pin_incorrect'?${JSON.stringify(PIN_WRONG_SENTENCE)}
        :(j&&j.error_description)||${JSON.stringify(PRESS_FAILED_SENTENCE)};
      var p=document.getElementById('page');var box=p&&p.querySelector('.err[role="alert"]');
      if(!box){box=document.createElement('div');box.className='err';box.setAttribute('role','alert');f.parentNode.insertBefore(box,f);}
      box.textContent=msg;
      var pins=f.querySelectorAll('input.pinbox');for(var k=0;k<pins.length;k++)pins[k].value='';
      for(var i=0;i<btns.length;i++)btns[i].disabled=false;
    }
    fetch(f.action,{method:'POST',body:new URLSearchParams(fd),credentials:'same-origin',headers:{'accept':'text/html'}})
      .then(function(r){var ct=r.headers.get('content-type')||'';
        if(/json/i.test(ct))return r.json().then(function(j){showErr(j);return null;});
        return r.text();})
      .then(function(html){if(html===null)return;var d=new DOMParser().parseFromString(html,'text/html');var n=d.getElementById('page');var p=document.getElementById('page');
        if(!n||!p)throw new Error('no page');p.innerHTML=n.innerHTML;document.title=d.title||document.title;window.scrollTo(0,0);
        var h=p.querySelector('h1');if(h){h.setAttribute('tabindex','-1');h.focus();}armDone();})
      .catch(function(){for(var i=0;i<btns.length;i++)btns[i].disabled=false;f.submit();});
  },true);
  armDone();
})();
</script>`;

export function donePage(title: string, html: string, backHref?: string, backLabel?: string): string {
  if (backHref) return messagePage(title, html, backHref, backLabel);
  return layout(title, `<h1>${esc(title)}</h1>${html}
${DONE_BLOCK}`);
}

/**
 * A link opened while signed out. The link is still good and the path is kept
 * (session.ts), so signing in comes straight back here.
 */
export function signInToSeePage(): string {
  return layout('Sign in to see this', `<h1>Sign in to see this</h1>
<p>You'll come straight back here.</p>
<a class="btn" href="/login">Sign in</a>`);
}

/**
 * A link opened while signed in as a different account. The link is still
 * good; the session is the wrong one. Sign-out is a POST (routes.ts), so the
 * button is a form rather than a link.
 */
export function wrongAccountPage(): string {
  return layout(
    'This link is for a different account',
    `<h1>This link is for a different account</h1>
<p>You are signed in here as somebody else. Sign out, sign in as the person your assistant works for, then open the link again. The link stays good.</p>
<form method="post" action="/logout"><button class="btn" type="submit">Sign out</button></form>`,
  );
}

/**
 * A link that no longer opens.
 *
 * Run of 27 September 2026: an assistant kept telling its human "the link's
 * here" after its fifteen minutes were up, and the page said only that links
 * live fifteen minutes. So the page says what to do in one line, and offers
 * the main page, where every open request is listed while it is still good.
 */
export const FRESH_LINK_ON_MAIN_PAGE =
  'A fresh one also shows on your main page when you are signed in.';

export function linkDeadPage(reason: 'used' | 'expired' | 'invalid'): string {
  const title = { used: 'Already used', expired: 'Link run out', invalid: 'Not a valid link' }[reason];
  const text = {
    used: `<h1>This link has already been used.</h1>
<p class="lead">Each link works once. Ask your assistant for a fresh one.</p>`,
    expired: `<h1>This link has run out.</h1>
<p class="lead">Ask your assistant for a fresh one.</p>`,
    invalid: `<h1>This link isn't valid.</h1>
<p class="lead">Ask your assistant for a fresh one.</p>`,
  }[reason];
  return layout(title, `${text}
<p>${esc(FRESH_LINK_ON_MAIN_PAGE)}</p>
<a class="btn secondary" href="/">Go to your main page</a>`);
}

/**
 * A photo's short link once its fifteen minutes are up (routes.ts, /p/:token).
 * There is no fresh copy of a photo to fetch, so the page says what is true:
 * it was handed over once, and the other person can send it again.
 */
export function photoLinkDeadPage(): string {
  return layout('Photo link run out', `<h1>This photo link has run out.</h1>
<p class="lead">A photo can be opened for fifteen minutes after it is passed on, and then it is gone.</p>
<p>If you still need it, ask the other person to send it again.</p>`);
}

// ---------------------------------------------------------------------------
// The one-question page.
//
// The assistant does the talking. Where a formality is needed it hands its
// human a single-use link, and the link opens this: one sentence, two buttons,
// and the credential ceremony on every press that is the human's own to make —
// identity, money, or ending a conversation for good. Nothing else is on the
// page — no navigation, no second decision, no detail to weigh up, because the
// weighing already happened in the conversation the person was having.
//
// The press is what consumes the link, so the figures the page asks about are
// read back out of the signed row at that moment rather than carried in the
// form where a person could edit them.
// ---------------------------------------------------------------------------
export interface OneQuestionView {
  /** The link this page was opened with; the form posts it straight back.
   *  Absent on the main page's road, which carries `session` instead. */
  token?: string;
  /** Set when the page was opened from the main page through the signed-in
   *  session (/approvals/offer/:id, /approvals/match/:id). The form posts to
   *  /approve with the decision's action and ref, and no link is involved. */
  session?: { action: string; refId: string };
  /** The one sentence. Mostly a question; where the two buttons already ask it
   *  — Accept or Not now on a figure — the sentence states the figure instead. */
  question: string;
  /** Supporting lines, at most a couple, under the question. */
  detail?: string[];
  yesLabel: string;
  noLabel: string;
  /** True where the press is the human's own to make — identity, money, or
   *  ending a conversation for good: the ceremony rides along. */
  needsPin: boolean;
  /** This account has a PIN. False on a passkey-only account, where the press
   *  itself runs the passkey ceremony and no box is printed. */
  hasPin: boolean;
  hasPasskey: boolean;
  elevated: boolean;
  /** The press moves money: the ceremony is asked for now, window or no. */
  money?: boolean;
  /** Set on the names question when this account has no first name or area on
   *  file yet: the page asks for them right here, in the same form, and the
   *  press stores them. Nothing was ever asked for at sign-up. */
  collectProfile?: { firstName: string; locality: string };
  /** Set on the report question: one short line in the person's own words
   *  about what happened. Optional to fill in — a report with nothing typed in
   *  it still stands, because the thing that matters is that somebody said so. */
  collectReason?: { label: string; hint: string; value: string; maxLength: number };
}

export function oneQuestionPage(v: OneQuestionView, error?: string): string {
  // The ceremony rides along on every press the human alone may make; a
  // question that asks for no credential is two buttons and nothing else.
  const c: CeremonyView = !v.needsPin
    ? { hasPin: false, hasPasskey: false, elevated: true }
    : v.money
      ? moneyCeremony(v)
      : { hasPin: v.hasPin, hasPasskey: v.hasPasskey, elevated: v.elevated };
  const collect = v.collectProfile
    ? `<h2>What should we share?</h2>
       <p class="small">The other side sees a first name and a suburb. That is the whole of it.
       You can change both any time on <a href="/profile">what you share on a match</a>.</p>
       ${sharedFieldsFieldset(v.collectProfile)}`
    : '';
  const reason = v.collectReason
    ? `<label for="reason">${esc(v.collectReason.label)}</label>
       <textarea id="reason" name="reason" rows="3" maxlength="${v.collectReason.maxLength}">${esc(v.collectReason.value)}</textarea>
       <p class="small muted">${esc(v.collectReason.hint)}</p>`
    : '';
  const detail = (v.detail ?? []).map((d) => `<p class="small muted">${esc(d)}</p>`).join('');
  // Two roads to one page. The link posts itself back; the main page's road
  // posts the decision to /approve and has no link to spend.
  const action = v.session ? '/approve' : `/a/${encodeURIComponent(v.token ?? '')}`;
  const hidden = v.session
    ? `<input type="hidden" name="action" value="${esc(v.session.action)}">
  <input type="hidden" name="ref_id" value="${esc(v.session.refId)}">`
    : '';
  // One short line at the foot: the link's one use, and what the press takes.
  const foot = [v.session ? '' : 'This link works once.', v.needsPin ? ceremonyNoteInner(c) : '']
    .filter(Boolean)
    .join(' ');
  return layout(v.question, `
<h1>${esc(v.question)}</h1>
${errBox(error)}
${detail}
<form method="POST" action="${action}" id="oneQuestion">
  ${hidden}
  ${collect}
  ${reason}
  ${v.needsPin ? ceremonyField(c, 'q') : ''}
  <div class="actions">
  ${ceremonySubmit(c, { formId: 'oneQuestion', label: v.yesLabel, className: 'approve', name: 'decision', value: 'yes' })}
  <a class="btn secondary" href="/">${esc(v.noLabel)}</a>
  </div>
</form>
${ceremonyAlt(c, 'oneQuestion', { name: 'decision', value: 'yes' })}
${foot ? `<p class="small muted">${foot}</p>` : ''}
${ceremonyScript(c)}`);
}

// ---------------------------------------------------------------------------
// The shelf page (SHELF_PICK, domain/shelfPick.ts).
//
// The human said none of the shelves their assistant offered fit. This page is
// a search box over every open shelf the catalogue has, with the matching ones
// as rows to tap, and two ways out at the bottom: the general shelf, or leaving
// it unposted for now.
//
// IT WORKS WITH SCRIPTS OFF. Every row is printed, and the ones the words in
// the box do not fit carry `hidden`, so a search submitted the ordinary way
// (GET ?q=) comes back as a filtered list from the server. With scripts on, the
// same rule runs as the person types and the search button is never needed.
// The two filters are one rule written twice: domain/shelfPick.ts searchShelves
// and the fold below, held together by test/unit/shelfPick.test.ts.
//
// NO CEREMONY. A shelf discloses nothing and spends nothing, so the press is a
// tap. The press is still what burns the link, so the rows are one form with
// one button each, pressed in place like every one-question page.
// ---------------------------------------------------------------------------
export interface ShelfPickView {
  token: string;
  /** The poster's own words for the thing, where they gave any. */
  kind: string | null;
  /** What is in the search box. */
  q: string;
  /** How many words of it the search runs on (domain/shelfPick.ts searchWords). */
  wordCount: number;
  /** Every shelf, in the catalogue's order. */
  shelves: { category: string; label: string; under: string; haystack: string }[];
  /** The ones the words fit: the rest are printed hidden. */
  shown: Set<string>;
  /** The general shelf at the bottom: its path and its words. */
  general: { category: string; words: string };
}

/** The line under the search box, identical on the server and in the script. */
export function shelfCountLine(words: number, fits: number): string {
  if (!words) return 'Type a word or two about what it is.';
  if (!fits) return 'Nothing fits those words. Try another word, or use the general shelf below.';
  return fits === 1 ? 'One shelf fits.' : `${fits} shelves fit.`;
}

const SHELF_FILTER_SCRIPT = `<script>
(function(){
  var q=document.getElementById('q'),list=document.getElementById('shelves'),count=document.getElementById('shelfCount'),go=document.getElementById('searchGo');
  if(!q||!list||!count)return;
  var rows=list.querySelectorAll('li[data-s]');
  function fold(s){return String(s||'').normalize('NFKD').replace(/[\\u0300-\\u036f]/g,'').toLowerCase().replace(/&/g,' and ').replace(/[^a-z0-9]+/g,' ').trim();}
  function words(s){return fold(s).split(' ').filter(Boolean).map(function(w){return w.length>3&&/s$/.test(w)&&!/ss$/.test(w)?w.slice(0,-1):w;});}
  function line(w,n){if(!w)return 'Type a word or two about what it is.';if(!n)return 'Nothing fits those words. Try another word, or use the general shelf below.';return n===1?'One shelf fits.':n+' shelves fit.';}
  function run(){var w=words(q.value),n=0;
    for(var i=0;i<rows.length;i++){var h=rows[i].getAttribute('data-s'),ok=w.length>0;
      for(var j=0;ok&&j<w.length;j++){if(h.indexOf(w[j])<0)ok=false;}
      rows[i].hidden=!ok;if(ok)n++;}
    count.textContent=line(w.length,n);}
  q.addEventListener('input',run);
  if(q.form)q.form.addEventListener('submit',function(e){e.preventDefault();run();});
  if(go)go.hidden=true;
})();
</script>`;

export function shelfPickPage(v: ShelfPickView, error?: string): string {
  const thing = v.kind ? `your ${v.kind}` : 'it';
  const rows = v.shelves
    .map(
      (s) => `<li data-s="${esc(s.haystack)}"${v.shown.has(s.category) ? '' : ' hidden'}>
<button type="submit" name="category" value="${esc(s.category)}" class="shelf"><span class="sl">${esc(s.label)}</span>${
        s.under ? `<span class="su">${esc(s.under)}</span>` : ''
      }</button></li>`,
    )
    .join('\n');
  return layout(`Pick a shelf for ${thing}`, `
<h1>Pick a shelf for ${esc(thing)}.</h1>
${errBox(error)}
<p class="small muted">None of the shelves your assistant offered fit. Search for the one that does and tap it. Your assistant then puts it up there.</p>
<form method="GET" action="/a/${encodeURIComponent(v.token)}" role="search">
  <label for="q">What is it?</label>
  <div class="searchrow">
    <input type="text" id="q" name="q" value="${esc(v.q)}" inputmode="search" enterkeyhint="search"
           autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="sim racing pedals">
    <button type="submit" id="searchGo" class="secondary">Search</button>
  </div>
</form>
<p class="small muted" id="shelfCount" aria-live="polite">${esc(shelfCountLine(v.wordCount, v.shown.size))}</p>
<form method="POST" action="/a/${encodeURIComponent(v.token)}" id="oneQuestion">
  <ul class="shelves" id="shelves">
${rows}
  </ul>
  <div class="actions">
  <button type="submit" name="category" value="${esc(v.general.category)}" class="secondary">Put it under ${esc(v.general.words)}</button>
  <button type="submit" name="decision" value="no" class="secondary" formnovalidate>Leave it unposted for now</button>
  </div>
</form>
<p class="small muted">This link works once. Choosing a shelf shares nothing about you and costs nothing, so it needs no PIN.</p>
${SHELF_FILTER_SCRIPT}`);
}

// ---------------------------------------------------------------------------
// The photo page.
//
// The same one-page shape as every other step, with one difference that earns
// itself: a person picks a file before they press. The picture goes straight
// from this phone into the store on a link signed for that one file — it never
// passes through the service — and the press is what sends it.
//
// WHO IT GOES TO IS NOT A QUESTION HERE. The link was bound to one conversation
// when the assistant fetched it, so the page states the person and the thing
// and gives nobody a choice to get wrong.
//
// THE PAGE IS WHERE THE LOCATION COMES OUT OF THE PICTURE (16 September 2026).
// counter/photoScrub.ts is inlined below and runs on the sender's own device:
// the file is rebuilt with every metadata block dropped, the result is checked
// again, and only then is an upload link asked for. A sideways photo is redrawn
// the right way up through a canvas first, because the tag that said which way
// up it went is one of the things being dropped. Where any of that fails, the
// page says so and no link is ever minted, so nothing is uploaded.
//
// What the page tells the truth about, in the person's own words: what is taken
// out of the file and what is kept, that nothing here opens the picture, that
// the other side gets it once, and that it deletes itself.
// ---------------------------------------------------------------------------
export interface PhotoView {
  token: string;
  /** Who it goes to, once both have shared a first name; "the other side" before. */
  who: string;
  /** The thing they are talking about, in the words a person uses for it. */
  thing: string;
  /** Megabytes, whole. */
  maxMb: number;
  /** Days a photo waits if the other side never looks. */
  ttlDays: number;
  captionMax: number;
  /** What they typed last time, when the press came back with a refusal. */
  caption?: string;
  /** The photo already uploaded, carried back through a refused press so that
   *  a price typed in the line beside it costs a rewrite rather than a second
   *  trip to the camera roll. */
  photoId?: string;
}

export function photoPage(v: PhotoView, error?: string): string {
  // The title is escaped by layout, so it takes the name raw; every other
  // place on this page puts it into markup and escapes it here.
  const title = `Send a photo to ${v.who}`;
  return layout(title, `
<h1>Send ${esc(v.who)} a photo of the ${esc(v.thing)}.</h1>
${errBox(error)}
<noscript><p class="small muted">This page needs scripts switched on to prepare the photo on your device.</p></noscript>
<div id="perr" role="alert"></div>
<label for="photo">Your photo</label>
<input type="file" id="photo" accept="image/jpeg,image/png,image/webp">
<p class="field-help">JPEG, PNG or WebP, up to ${v.maxMb} MB. Where and when it was taken, and the
camera details, are removed on your device before it is sent.</p>
<form method="POST" action="/a/${encodeURIComponent(v.token)}" id="photoForm">
  <input type="hidden" name="photo_id" id="photo_id" value="${esc(v.photoId ?? '')}">
  <label for="caption">Description (optional)</label>
  <input id="caption" name="caption" type="text" maxlength="${v.captionMax}"
         value="${esc(v.caption ?? '')}">
  <div class="consent-box">
    <label><input type="checkbox" name="confirm" value="yes" required>
    This photo shows nothing sexual, violent or illegal, and no one else's personal details.</label>
  </div>
  <div class="actions">
  <button type="submit" name="decision" value="yes" class="approve" id="sendBtn"${v.photoId ? '' : ' disabled'}>Send the photo</button>
  <a class="btn secondary" href="/">Not now</a>
  </div>
</form>
<p class="small muted">This link works once.</p>
<script>
${PHOTO_SCRUB_JS}
const pf = document.getElementById('photo');
const sendBtn = document.getElementById('sendBtn');
const perr = document.getElementById('perr');

/** A sideways photo, turned. The tag that said which way up it went has already
 *  been dropped by the scrub, so the browser draws the raw pixels and the plan
 *  decides the turn; the redrawn file is then scrubbed again, because a canvas
 *  writes a fresh file and a fresh file gets the same treatment as any other. */
async function osbRedraw(clean) {
  const blob = new Blob([clean.bytes], { type: clean.type });
  const src = URL.createObjectURL(blob);
  try {
    const img = await new Promise((ok, no) => {
      const im = new Image();
      im.onload = () => ok(im);
      im.onerror = () => no(new Error(OSB_SCRUB_UNREADABLE));
      im.src = src;
    });
    const plan = __osbPhotoScrub.drawPlan(clean.orientation, img.naturalWidth, img.naturalHeight);
    const c = document.createElement('canvas');
    c.width = plan.width;
    c.height = plan.height;
    const ctx = c.getContext('2d');
    if (!ctx) throw new Error(OSB_SCRUB_UNREADABLE);
    ctx.setTransform.apply(ctx, plan.transform);
    ctx.drawImage(img, 0, 0);
    const out = await new Promise((ok) => c.toBlob(ok, clean.type, 0.92));
    if (!out) throw new Error(OSB_SCRUB_UNREADABLE);
    return __osbPhotoScrub.scrub(new Uint8Array(await out.arrayBuffer()));
  } finally {
    URL.revokeObjectURL(src);
  }
}

pf.addEventListener('change', async () => {
  const file = pf.files[0];
  if (!file) return;
  sendBtn.disabled = true;
  document.getElementById('photo_id').value = '';
  perr.innerHTML = '';
  try {
    let clean = __osbPhotoScrub.scrub(new Uint8Array(await file.arrayBuffer()));
    if (clean.orientation > 1) clean = await osbRedraw(clean);
    // The proof, before a link to upload with is even asked for.
    __osbPhotoScrub.assertClean(clean.bytes);
    const digest = await crypto.subtle.digest('SHA-256', clean.bytes);
    const sha = btoa(String.fromCharCode(...new Uint8Array(digest)));
    const r = await fetch('/a/${encodeURIComponent(v.token)}/photo', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filename: file.name, content_type: clean.type,
        size: clean.bytes.length, sha256_b64: sha, metadata_removed: true }),
    });
    if (!r.ok) throw new Error(((await r.json().catch(() => ({}))).error) || ('HTTP ' + r.status));
    const { url, photo_id } = await r.json();
    const put = await fetch(url, { method: 'PUT', body: clean.bytes,
      headers: { 'content-type': clean.type, 'x-amz-checksum-sha256': sha } });
    if (!put.ok) throw new Error('the upload did not finish (HTTP ' + put.status + ')');
    document.getElementById('photo_id').value = photo_id;
    sendBtn.disabled = false;
  } catch (e) {
    perr.innerHTML = '<div class="err">' + String(e.message || e).replace(/[<>&]/g, '') + '</div>';
  }
});
</script>`);
}

// ---------------------------------------------------------------------------
// SEALED CONTACT DETAILS (domain/sealedContact.ts, counter/sealedScript.ts).
//
// Two pages, and neither has a form that can send anything readable. The boxes
// on the send page carry no `name`, the form is `method="dialog"`, and it stays
// hidden until the script has shown it: with scripts off there is nothing to
// fill in, and a press sends nothing. The script scrambles the details in this
// browser and posts only the scrambled copies.
//
// Both pages are layout(..., { sealed: true }): no inline script, and the
// response carries the stricter policy (app.ts). The one script is ours, from
// this origin, pinned by its SRI hash.
// ---------------------------------------------------------------------------

/** The line that says what happens to the details, the same on both pages. */
export const SEALED_HOW_LINE = (who: string) =>
  `They go from this page to ${who}'s own browser, scrambled so only that browser can read them. Neither assistant sees them, and we can't read them.`;

/** The warning before anything is shown, in the words an API key page uses. */
export const SEALED_ONCE_LINE =
  "This works once. Write it down or save it somewhere safe now — once you leave this page it's gone.";

export interface ContactSendView {
  token: string;
  /** Their first name, or "the other person". */
  who: string;
  matchId: string;
  /** This person's own key slot in the browser (domain/sealedContact.ts keySlot). */
  slot: string;
  /** The recipient's browser keys, public halves only. */
  keys: { key_id: string; public_key: string }[];
  ttlDays: number;
  hasPin: boolean;
  hasPasskey: boolean;
  elevated: boolean;
}

export function contactSendPage(v: ContactSendView): string {
  // A FRESH CEREMONY every send, like money: the window is never enough.
  const pinBox = v.hasPin;
  const passkeyOnly = !v.hasPin && v.hasPasskey;
  const passkeyAlt = v.hasPin && v.hasPasskey;
  const takes =
    v.hasPin && v.hasPasskey
      ? 'Sending takes your PIN or your passkey every time.'
      : v.hasPin
        ? 'Sending takes your PIN every time.'
        : 'Sending takes your passkey every time.';
  const title = `Send your contact details to ${v.who}?`;
  return layout(
    title,
    `
<h1>${esc(title)}</h1>
<p class="lead">Type them here yourself. ${esc(SEALED_HOW_LINE(v.who))}</p>
<noscript><p class="small muted">This page needs scripts switched on. It scrambles your details on this device before they leave it.</p></noscript>
<p class="small muted" id="snoscript" hidden>This browser cannot scramble them. Open the link in an up-to-date browser.</p>
<div id="serr" role="alert"></div>
<div id="sealed" data-mode="send" data-slot="${esc(v.slot)}" data-match="${esc(v.matchId)}"
     data-action="/a/${esc(encodeURIComponent(v.token))}/contact" data-passkey-only="${passkeyOnly ? '1' : '0'}"
     data-keys="${esc(JSON.stringify(v.keys))}"></div>
<form id="sealedForm" method="dialog" hidden>
  <label for="c_address">Your address</label>
  <textarea id="c_address" rows="3" maxlength="500" autocomplete="street-address"></textarea>
  <label for="c_phone">Your phone number</label>
  <input id="c_phone" type="tel" maxlength="40" autocomplete="tel">
  <p class="field-help">Fill in one or both. Send only what you want ${esc(v.who)} to have.</p>
  <div class="consent-box">
    <label><input type="checkbox" id="c_remember"> Remember on this device</label>
    <p class="field-help">Keeps them scrambled in this browser only, so the boxes are filled in next time. Untick it and send to forget them.</p>
  </div>
  ${
    pinBox
      ? `<label for="c_pin">Confirm with your PIN</label>
  <input id="c_pin" type="text" class="pinbox" inputmode="numeric" autocomplete="off" spellcheck="false" data-1p-ignore data-lpignore="true" data-bwignore pattern="[0-9]{6,12}" maxlength="12" required>`
      : ''
  }
  <div class="actions">
  <button type="submit" class="approve" id="c_send">Send to ${esc(v.who)}</button>
  <a class="btn secondary" href="/">Not now</a>
  </div>
  ${passkeyAlt ? '<button type="button" class="secondary" id="c_passkey">Use your passkey instead</button>' : ''}
</form>
<p class="small muted">${esc(v.who)} can open them once, within ${v.ttlDays} days. This link works once.${takes ? ` ${esc(takes)}` : ''}</p>
${sealedScriptTag()}`,
    { sealed: true },
  );
}

export interface ContactReceiveView {
  id: string;
  who: string;
  matchId: string;
  slot: string;
  /** The keys this send has a copy for. */
  keyIds: string[];
}

export function contactReceivePage(v: ContactReceiveView): string {
  const title = `${v.who} has sent you their contact details`;
  return layout(
    title,
    `
<h1>${esc(title)}.</h1>
<p class="lead">${esc(SEALED_ONCE_LINE)}</p>
<noscript><p class="small muted">This page needs scripts switched on. Your browser unscrambles the details itself.</p></noscript>
<p class="small muted" id="snoscript" hidden>This browser cannot unscramble them. Open the link in an up-to-date browser.</p>
<div id="serr" role="alert"></div>
<div id="sealed" data-mode="receive" data-id="${esc(v.id)}" data-slot="${esc(v.slot)}"
     data-match="${esc(v.matchId)}" data-keyids="${esc(JSON.stringify(v.keyIds))}"></div>
<div id="r_ready" hidden>
  <p>They were scrambled so only your browser can read them. Neither assistant has seen them.</p>
  <button type="button" class="approve" id="r_reveal">Show them now</button>
</div>
<div id="r_shown" hidden>
  <h2>Their details</h2>
  <p class="lead sealed-shown" id="r_address" hidden></p>
  <p class="lead sealed-shown" id="r_phone" hidden></p>
  <button type="button" class="secondary" id="r_copy" hidden>Copy</button>
  <p class="small muted">Our scrambled copy is deleted. This is the only time they show here.</p>
</div>
<div id="r_nokey" hidden>
  <p>This browser can't open them. They were scrambled for the browsers you had signed in on before they were sent.</p>
  <p>If you use the switchboard on another device, open this link there. Otherwise <a href="/contact-keys/setup">set up this browser</a> and ask ${esc(v.who)} to send them again.</p>
</div>
<style>.sealed-shown { white-space:pre-wrap; overflow-wrap:anywhere; font-weight:600; }</style>
${sealedScriptTag()}`,
    { sealed: true },
  );
}

/**
 * The main page's quiet check: this browser's receiving key, touched where it
 * is already registered. A browser that is not set up is shown one small line
 * offering to set it up, because that takes a ceremony and a quiet check never
 * runs one.
 */
export function sealedKeysTag(slot: string): string {
  return `<div id="sealed" data-mode="keys" data-slot="${esc(slot)}" hidden></div>
<p class="small muted" id="sealed-setup" hidden>This browser is not set up to receive contact details. <a href="/contact-keys/setup">Set it up</a></p>
${sealedScriptTag()}`;
}

export interface ContactSetupView {
  slot: string;
  hasPin: boolean;
  hasPasskey: boolean;
  /** Inside a strong window (a PIN or a passkey): the button asks nothing more. */
  elevated: boolean;
}

/** Set this browser up to receive contact details. */
export function contactSetupPage(v: ContactSetupView): string {
  const pinBox = !v.elevated && v.hasPin;
  const passkeyOnly = !v.elevated && !v.hasPin && v.hasPasskey;
  const passkeyAlt = !v.elevated && v.hasPin && v.hasPasskey;
  return layout(
    'Set up this browser',
    `
<h1>Set up this browser to receive contact details.</h1>
<p class="lead">When someone sends you their address or phone number, it is scrambled so only your own browsers can read it. This makes this browser one of them.</p>
<noscript><p class="small muted">This page needs scripts switched on.</p></noscript>
<p class="small muted" id="snoscript" hidden>This browser cannot do this. Open the page in an up-to-date browser.</p>
<div id="serr" role="alert"></div>
<div id="sealed" data-mode="setup" data-slot="${esc(v.slot)}" data-passkey-only="${passkeyOnly ? '1' : '0'}"></div>
<form id="sealedForm" method="dialog" hidden>
  ${
    pinBox
      ? `<label for="c_pin">Confirm with your PIN</label>
  <input id="c_pin" type="text" class="pinbox" inputmode="numeric" autocomplete="off" spellcheck="false" data-1p-ignore data-lpignore="true" data-bwignore pattern="[0-9]{6,12}" maxlength="12" required>`
      : ''
  }
  <div class="actions">
  <button type="submit" class="approve" id="c_send">Set up this browser</button>
  <a class="btn secondary" href="/">Not now</a>
  </div>
  ${passkeyAlt ? '<button type="button" class="secondary" id="c_passkey">Use your passkey instead</button>' : ''}
</form>
<p class="small muted">We email you when a browser is set up. You can remove it on your <a href="/security">security page</a>.</p>
${sealedScriptTag()}`,
    { sealed: true },
  );
}

/** Opened already. The page says whether it was this browser that opened them. */
export function contactOpenedPage(v: { who: string; when: string; slot: string; openedKeyId: string }): string {
  return layout(
    'Already opened',
    `
<h1>Already opened.</h1>
<p class="lead">${esc(v.who)}'s contact details were opened ${esc(v.when)}. They open once, so they are gone from here now.</p>
<div id="sealed" data-mode="opened" data-slot="${esc(v.slot)}" data-opened="${esc(v.openedKeyId)}"></div>
<p id="o_here" hidden>They were opened on this browser.</p>
<div id="o_elsewhere" hidden>
  <p>They were opened on another of your browsers.</p>
  <p class="small muted">If that was not you, remove the browsers you do not recognise on your <a href="/security">security page</a>, and press Stop all wants and haves on your main page.</p>
</div>
<p class="small muted">If you need them again, ask ${esc(v.who)} to send them again.</p>
${sealedScriptTag()}`,
    { sealed: true },
  );
}

/**
 * The payment approval: one question in the same shape as the one-question
 * pages, the money written out in two or three plain sentences, and the
 * ceremony at the press. Reached from the assistant's link (which it carries
 * back, so the press is what spends it) or from the main page.
 */
export interface SettlementApprovalView {
  refId: string;
  /** "Agree to pay $421 AUD for the Trek?" */
  question: string;
  /** The money in sentences, and any anomaly line after them. */
  detail: string[];
  hasPin: boolean;
  hasPasskey: boolean;
  elevated: boolean;
  /** Set when this page was reached by a one-use link that has NOT been spent
   *  yet: the form carries it back so the press is what spends it. */
  linkToken?: string;
}

/** A number the agent brought back, ready for its human to check and send. */
export interface OfferDraftView {
  amount: string;
  ccy: string;
  note?: string;
}

/** The one line that says where a prefilled figure came from. */
export const DRAFT_LINE = 'Your assistant brought this number from you. Check it and send.';

/**
 * Reply with your own number. This control is where a human's side of a
 * negotiation comes from on a want or have set to Pass on. Sending a figure is
 * money, so from 27 September 2026 it asks for the PIN or the passkey at the
 * press, like accepting one (credentials.ts MONEY_ACTIONS). `ceremony` is what
 * the account holds; absent, the form asks nothing, which is what the page
 * renderers in the tests want. The page it stands on carries ceremonyScript.
 */
export function counterOfferForm(
  matchId: string,
  opts: {
    ccy?: string;
    amount?: string;
    note?: string;
    heading?: string;
    draft?: boolean;
    ceremony?: CeremonyView;
  } = {},
): string {
  const heading = opts.heading ?? 'Reply with your number';
  const c: CeremonyView = opts.ceremony
    ? moneyCeremony(opts.ceremony)
    : { hasPin: false, hasPasskey: false, elevated: true };
  return `${heading ? `<h2>${esc(heading)}</h2>` : ''}
${opts.draft ? `<div class="note"><strong>${esc(DRAFT_LINE)}</strong></div>` : ''}
<p class="small muted">What you type here goes to the other side as your offer.
It binds nothing — either of you can still say no — and accepting anything
still comes back to this page.</p>
<form method="POST" action="/matches/${esc(matchId)}/offer" id="offerForm">
  <label for="amount">Your number</label>
  <input id="amount" name="amount" type="number" step="0.01" min="0" required value="${esc(opts.amount ?? '')}" placeholder="amount">
  <label for="ccy">Currency</label>
  <input id="ccy" name="ccy" type="text" maxlength="3" pattern="[A-Za-z]{3}" required value="${esc(opts.ccy ?? 'AUD')}">
  <label for="note">A line to go with it (optional)</label>
  <input id="note" name="note" type="text" maxlength="${MANDATE_NOTE_MAX}" value="${esc(opts.note ?? '')}" placeholder="A line to go with it, e.g. can collect Saturday">
  <p class="field-help">About the terms. Keep ways of reaching you out of it.</p>
  <label for="good_for">Good for</label>
  <select id="good_for" name="good_for">
    <option value="3">3 days</option>
    <option value="7" selected>7 days</option>
    <option value="14">14 days</option>
  </select>
  ${opts.ceremony ? ceremonyField(c, 'offer') : ''}
  ${ceremonySubmit(c, { formId: 'offerForm', label: 'Send this number' })}
</form>
${ceremonyAlt(c, 'offerForm')}
${opts.ceremony ? ceremonyNote(c) : ''}`;
}

/**
 * The one line under the area box. Run 8 (13 September 2026): a human had
 * "Australian Capital Territory" on file, the other side's assistant read it
 * back to him as where the seller was, and it told him nothing about whether
 * the bike was ten minutes away or two hours — so it read as dodging the
 * question. The posting itself had matched on a suburb, so the switchboard
 * knew better than the answer it was handing over. The box asks for a suburb
 * now and says why; a wider answer is still taken exactly as typed.
 */
export const AREA_HELP =
  'The other person is working out whether you are ten minutes away or two hours, ' +
  'so a suburb tells them far more than a state does. Type a few letters and pick ' +
  'yours from the list, and what you post goes out under the same area. ' +
  'Wider is fine if you would rather, and anything you type yourself is kept as you wrote it.';

/** The word the area box asks for, used wherever the box appears. */
export const AREA_LABEL = 'Your suburb';

/** An example that reads as a suburb rather than as a city or a state. */
export const AREA_PLACEHOLDER = 'e.g. Braddon';

/**
 * The suggestions under the area box.
 *
 * A datalist rather than a typeahead of our own: the browser draws it, the
 * keyboard and the screen reader already know it, and it is three lines of
 * script instead of a widget. With the script off — or before it runs — the
 * box is what it always was, a text box that takes anything typed into it and
 * saves it. Nothing here rewrites an answer; picking from the list is the only
 * way the box ever changes, and a person who types past it keeps every letter.
 *
 * The names come from the switchboard's own offline gazetteer over `/areas`,
 * which needs this human's session. No third party sees a keystroke.
 */
const AREA_SUGGEST_SCRIPT = `<script>
(function(){
  var box = document.getElementById('locality');
  var list = document.getElementById('area-options');
  if (!box || !list || !window.fetch) return;
  var timer, seq = 0;
  box.addEventListener('input', function(){
    var q = box.value.trim();
    clearTimeout(timer);
    if (q.length < 3) { list.innerHTML = ''; return; }
    timer = setTimeout(function(){
      var mine = ++seq;
      fetch('/areas?q=' + encodeURIComponent(q), { credentials: 'same-origin' })
        .then(function(r){ return r.ok ? r.json() : { places: [] }; })
        .then(function(d){
          if (mine !== seq) return;
          list.innerHTML = '';
          (d.places || []).forEach(function(p){
            var o = document.createElement('option');
            o.value = p.value;
            o.textContent = p.country;
            list.appendChild(o);
          });
        })
        .catch(function(){});
    }, 180);
  });
})();
</script>`;

/** The two boxes that make up everything a match ever sees about a person. */
export function sharedFieldsFieldset(v: { firstName: string; locality: string }): string {
  return `<label for="first_name">First name</label>
  <input id="first_name" name="first_name" type="text" maxlength="40" autocomplete="given-name"
    value="${esc(v.firstName)}" required>
  <label for="locality">${AREA_LABEL}</label>
  <input id="locality" name="locality" type="text" maxlength="60" autocomplete="address-level2"
    list="area-options" autocorrect="off" spellcheck="false"
    placeholder="${AREA_PLACEHOLDER}" value="${esc(v.locality)}" required>
  <datalist id="area-options"></datalist>
  <p class="field-help">${AREA_HELP}</p>${AREA_SUGGEST_SCRIPT}`;
}

/*
 * NOT NOW IS A WAY BACK, NOTHING MORE (Lachlan, 27 September 2026). On every
 * page that asks one thing, "Not now" is a plain link to the main page: it
 * spends no link, records no decision and tells nobody anything, and the same
 * question is still waiting there. Saying no is for the person to tell their
 * assistant.
 */
/** Under an Accept button: everything else about a number goes to the assistant. */
export const OFFER_ELSEWHERE_LINE = 'To offer a different amount or say no, tell your assistant.';

export function settlementApprovalPage(v: SettlementApprovalView, error?: string): string {
  // Money never leans on the window: the ceremony is asked for at the press.
  const c = moneyCeremony(v);
  const detail = v.detail.map((d) => `<p class="small muted">${esc(d)}</p>`).join('');
  const foot = [v.linkToken ? 'This link works once.' : '', ceremonyNoteInner(c)]
    .filter(Boolean)
    .join(' ');
  return layout(v.question, `
<h1>${esc(v.question)}</h1>
${errBox(error)}
${detail}
<form method="POST" action="/approve" id="approveForm">
  <input type="hidden" name="ref_id" value="${esc(v.refId)}">
  <input type="hidden" name="action" value="settlement-approve">
  ${v.linkToken ? `<input type="hidden" name="link_token" value="${esc(v.linkToken)}">` : ''}
  ${ceremonyField(c, 'approve')}
  <div class="actions">
  ${ceremonySubmit(c, { formId: 'approveForm', label: 'Approve', className: 'approve', name: 'decision', value: 'approve' })}
  <a class="btn secondary" href="/">Not now</a>
  </div>
</form>
${ceremonyAlt(c, 'approveForm', { name: 'decision', value: 'approve' })}
${foot ? `<p class="small muted">${foot}</p>` : ''}
${ceremonyScript(c)}`);
}

/**
 * Where this agent's key will be sent, written for a person to read: the host
 * of the redirect it registered. An agent picks its own name at registration
 * and anyone may register one, so the name on this page proves nothing. The
 * address is the part nobody else can choose, which is why it is shown.
 */
function redirectHost(uri: string): string {
  try {
    const h = new URL(uri).hostname.replace(/^\[|\]$/g, '');
    if (h === '127.0.0.1' || h === 'localhost' || h === '::1') return 'your own machine';
    return h;
  } catch {
    return uri;
  }
}

export function authorizePage(
  clientName: string,
  postPath: string,
  hidden: Record<string, string>,
  clientId = '',
  c: CeremonyView = { hasPin: false, hasPasskey: false, elevated: true },
  redirectUri = '',
): string {
  const hiddenInputs = Object.entries(hidden)
    .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`)
    .join('\n');
  // Handing an agent a key is a sensitive action, so approving takes the same
  // ceremony an approval takes. Cancelling takes nothing: it skips the PIN
  // box's own validation and sends the refusal straight through.
  return layout('Authorise your assistant', `
<h1>Let this assistant work the switchboard for you?</h1>
<div class="headline"><div class="k">Assistant</div><div class="v">${esc(clientName)}</div></div>
${
  redirectUri
    ? `<p class="small muted">Its key goes to <strong>${esc(redirectHost(redirectUri))}</strong>.
Any assistant can register under any name, so check that address is the one you meant
to connect. If you do not recognise it, press Cancel.</p>`
    : ''
}
<form method="POST" action="${esc(postPath)}" id="authorize-form" data-client="${esc(clientId)}">
${hiddenInputs}
  ${ceremonyField(c, 'authorize')}
  <div class="actions">
  ${ceremonySubmit(c, {
    formId: 'authorize-form',
    label: 'Authorise',
    name: 'decision',
    value: 'approve',
    formTarget: '_blank',
  })}
  <button type="submit" name="decision" value="deny" class="secondary" formnovalidate>Cancel</button>
  </div>
</form>
${ceremonyAlt(c, 'authorize-form', { name: 'decision', value: 'approve', formTarget: '_blank' })}
${ceremonyNote(c)}
<p class="small muted">It can post wants and haves for you, review matches, and negotiate.
Anything irreversible — sharing your details, accepting an offer — still
waits for you, here on your main page.</p>
<p class="small muted">Authorising hands the assistant its key in a new tab, which you can close;
this tab comes back to your main page.</p>
<script>
// The agent's callback (often a localhost page the agent is listening on)
// lands in the new tab the Authorize button opens; this tab has nothing left
// to show, so it goes home. Cancel stays in this tab.
document.getElementById('authorize-form').addEventListener('submit', function (e) {
  if (e.submitter && e.submitter.value === 'approve') {
    var id = this.getAttribute('data-client') || '';
    setTimeout(function () { location.assign('/?authorized=' + encodeURIComponent(id)); }, 400);
  }
});
</script>
${ceremonyScript(c)}`);
}

export function registrationClosedPage(): string {
  return layout('Registration opens at launch', `
<h1>Registration opens at launch.</h1>
<p class="lead">OpenSwitchboard — the switchboard for AI intent — is not yet open
for sign-ups. Accounts open at launch.</p>`);
}

// ---------------------------------------------------------------------------
// Settlement page (phase 1.A safe hands). One page per settlement; the
// blocks that render depend on the viewer's side and the state. Money-moving
// buttons post to session-authenticated routes; confirm-receipt needs the
// PIN/passkey ceremony like every approval.
// ---------------------------------------------------------------------------
export interface SettlementView {
  id: string;
  role: 'buyer' | 'seller';
  state: string;
  amount: string; // rendered "600 AUD" — what the seller receives, in full
  /** Our introductory fee, rendered "1.00 AUD". The buyer pays it. */
  fee: string;
  /** Card processing at Stripe's standard rate, rendered "10.52 AUD". */
  processing: string;
  /** The three lines added up: what the buyer is charged. */
  buyerTotal: string;
  category: string;
  descriptionText?: string;
  myApprovalPending: boolean;
  /** buyer, state approved: hosted payment can start */
  canPay: boolean;
  /** seller, state approved: payment setup incomplete */
  needsPaymentSetup: boolean;
  /** seller, state funded: evidence upload + lock */
  canLockEvidence: boolean;
  /** buyer, state evidence-locked: confirm ceremony */
  canConfirm: boolean;
  /** buyer, state confirmed: the release did not go through, send it again */
  canRetryRelease: boolean;
  /** either side, funded/evidence-locked */
  canDispute: boolean;
  /** buyer, evidence-locked+: presigned links to the frozen evidence */
  evidence: { label: string; url: string }[];
  hasPin: boolean;
  hasPasskey: boolean;
  elevated: boolean;
  /** SETTLEMENT_AUTO_RELEASE_DAYS: how long the buyer's window runs. */
  autoReleaseDays: number;
  /** The window ran out and the clock released this payment, rather than the
   *  buyer confirming. Changes what the retry block says. */
  autoReleased?: boolean;
  /** evidence-locked: the seller's handover and the clock it started. Both
   *  sides see the same two dates.
   *
   *  Every "…Day" field on this view is localTime(d, 'day') output — a
   *  <time data-local="day"> element the browser rewrites into the reader's
   *  own clock — so the page inserts them without esc(). */
  handover?: {
    /** The seller's first name where it is known, "The seller" otherwise. */
    sellerName: string;
    /** The day the seller declared the handover, as a localised <time>. */
    onDay: string;
    /** The day the payment goes on its own, as a localised <time>. */
    byDay: string;
  };
  // --- the frozen half -----------------------------------------------------
  /** The payment is frozen while the two of them sort it out. */
  inDispute: boolean;
  /** Which of the two things went wrong, in the disputer's words. */
  disputeGround?: 'not_arrived' | 'not_as_described';
  /** seller: the tracking reference can go on now. */
  canAddTracking: boolean;
  deliveryTracking?: string;
  /** buyer, in dispute, nothing sent back yet. */
  canMarkReturned: boolean;
  returnTracking?: string;
  returnedOnDay?: string;
  /** When silence sends the money back anyway, as a localised <time>. */
  returnSilenceByDay?: string;
  /** seller: the buyer says it is back with them. */
  canConfirmReturn: boolean;
  /** seller: a return is open and they have not answered it yet. */
  canDisputeReturn?: boolean;
  /** The seller has said the return is not what it claims to be. Both sides
   *  see this, and it changes what every clock on the page does. */
  returnDisputed?: boolean;
  /** The seller's last day to add tracking on a dispute that says nothing
   *  arrived, as a localised <time>. */
  trackingGraceByDay?: string;
  /** The day the default rule decides, as a localised <time>. */
  deadlockByDay?: string;
  /** The split on the table, and who has said yes to it. */
  split?: {
    refundMinor: number;
    releaseMinor: number;
    refund: string;
    release: string;
    mine: boolean;
    theirs: boolean;
  };
  canProposeSplit: boolean;
  canApproveSplit: boolean;
  /** The whole of what is held, in minor units, for the split form's sums. */
  agreedMinor: number;
  ccy: string;
}

/** "Saturday 13 September" — a date a person reads without decoding it. */
export function plainDay(d: Date): string {
  return new Intl.DateTimeFormat('en-AU', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone: 'UTC',
  }).format(d);
}

/**
 * A moment on a human page, in the reader's own clock. The browser rewrites
 * the text on load (see layout()); what the server prints inside is the
 * fallback, so a page read with no JavaScript still says a true thing, in UTC.
 *
 * Returns trusted, server-built HTML: put it into a template directly, never
 * through esc(). Agent-facing wording stays plain text elsewhere.
 */
export function localTime(d: Date | string, mode: 'minute' | 'day' = 'minute'): string {
  const at = d instanceof Date ? d : new Date(d);
  const iso = at.toISOString();
  const fallback = mode === 'minute' ? iso.replace('T', ' ').slice(0, 16) + ' UTC' : plainDay(at);
  return `<time datetime="${iso}" data-local="${mode}">${esc(fallback)}</time>`;
}

const STATE_LINES: Record<string, string> = {
  proposed: 'Waiting for both of you to approve.',
  'approved-by-buyer': 'The buyer has approved. Waiting on the seller.',
  'approved-by-seller': 'The seller has approved. Waiting on the buyer.',
  approved: 'Both approved. The buyer pays next; the money is then held.',
  funded: 'The payment is held in safe hands.',
  'evidence-locked': 'Handed over. The buyer confirms receipt next.',
  confirmed: 'Receipt confirmed. The release is on its way.',
  disputed: 'On hold. The payment stays put while the two of you sort this out.',
  'resolution-proposed': 'A way to settle this is on the table, waiting for the other side.',
  resolved: 'Agreed. The money is moving now.',
  released: 'Complete. The payment was released to the seller.',
  refunded: 'Closed. The agreed amount went back to the buyer.',
  'settled-split': 'Closed. You divided it between you, and the money has moved.',
  declined: 'Declined. Nothing was paid.',
};

/**
 * Every button on this page that moves money, freezes it, or writes a fact the
 * deadlock rule then decides on carries a ceremony: the PIN box, or the
 * passkey the account holds instead of one. See CeremonyView above for why an
 * account with no PIN is a whole account. Adding tracking and saying an item
 * went back are in that list because the rule reads them: whoever can show
 * where the parcel went wins the payment, so a stolen session that could write
 * those lines could take the payment without ever pressing a money button.
 */
function pinField(v: CeremonyView, which: string): string {
  return ceremonyField(v, which);
}

export function settlementPage(v: SettlementView, error?: string, notice?: string): string {
  // The buttons that move money ask for the ceremony at the press, window or
  // no (credentials.ts MONEY_ACTIONS). The rest keep the window.
  const mv = moneyCeremony(v);
  const moneyShown =
    v.canRetryRelease ||
    v.canConfirm ||
    v.canConfirmReturn ||
    (!!v.split && v.inDispute && v.canApproveSplit) ||
    v.canProposeSplit;
  // `raw` marks a value the server built as HTML (a localised <time>); every
  // other value is escaped as before.
  const factRows: { k: string; v: string; raw?: boolean }[] = [
    { k: 'For', v: v.category },
    { k: 'State', v: v.state },
    { k: 'Your side', v: v.role === 'buyer' ? 'you pay' : 'you are paid' },
    { k: 'The buyer pays', v: `${v.buyerTotal} in three lines` },
    { k: 'What you agreed', v: v.amount },
    { k: 'Introductory fee', v: `${v.fee}, paid by the buyer` },
    { k: 'Card processing', v: `${v.processing}, at Stripe's standard rate` },
    // While the payment is frozen, what the seller ends up with is the whole
    // question, so the page stops answering it in advance.
    ...(v.inDispute
      ? [{ k: 'Held', v: `${v.amount}, and nothing else` }]
      : [{ k: 'The seller receives', v: `${v.amount} in full` }]),
    ...(v.handover
      ? [
          { k: 'Handed over', v: v.handover.onDay, raw: true },
          { k: 'Releases on its own', v: v.handover.byDay, raw: true },
        ]
      : []),
    ...(v.disputeGround
      ? [
          {
            k: 'What went wrong',
            v: v.disputeGround === 'not_arrived' ? 'It never arrived' : 'Something is wrong with it',
          },
        ]
      : []),
    ...(v.deliveryTracking ? [{ k: 'Sent with tracking', v: v.deliveryTracking }] : []),
    ...(v.returnTracking ? [{ k: 'Sent back with tracking', v: v.returnTracking }] : []),
    ...(v.deadlockByDay && v.inDispute
      ? [{ k: 'The rule decides on', v: v.deadlockByDay, raw: true }]
      : []),
  ];
  const facts = factRows
    .map(
      (f) =>
        `<div class="fact"><div class="k">${esc(f.k)}</div><div class="v">${f.raw ? f.v : esc(f.v)}</div></div>`,
    )
    .join('');
  // What the person can do right now, above everything describing it.
  const blocks: string[] = [];
  if (v.myApprovalPending) {
    blocks.push(`<a class="btn" href="/approvals/settlement/${esc(v.id)}">Review and decide</a>`);
  }
  if (v.needsPaymentSetup) {
    blocks.push(`<form method="POST" action="/settlements/${esc(v.id)}/payment-setup">
<button type="submit">Finish payment setup with Stripe</button></form>
<p class="small muted">Stripe collects your payout details directly; the switchboard never sees them.</p>`);
  }
  if (v.canPay) {
    blocks.push(`<form method="POST" action="/settlements/${esc(v.id)}/pay">
<button type="submit" class="approve">Pay on Stripe's secure page</button></form>
<p class="small muted">Your payment details go to Stripe only. Stripe's page shows you
three lines before you pay: ${esc(v.amount)} for what you agreed, an introductory fee of
${esc(v.fee)}, and ${esc(v.processing)} for card processing at Stripe's standard rate.
That comes to ${esc(v.buyerTotal)}. The money is held here and moves to the seller after
you confirm receipt; the seller receives the ${esc(v.amount)} you agreed, in full.</p>`);
  }
  if (v.canRetryRelease) {
    const pinBlock = pinField(mv, 'retry');
    blocks.push(`<h2>Send the release again</h2>
<p>${
      v.autoReleased
        ? `The window ran out and this payment is due to the seller. It has not gone
through yet, and the switchboard tries again by itself every hour`
        : `Your receipt is confirmed and the payment to the seller has not gone through
yet`
    }. Nothing has moved, and sending it again is safe: the seller can only ever
be paid once for this settlement.</p>
<form method="POST" action="/settlements/${esc(v.id)}/confirm" id="retryForm">
  ${pinBlock}
  ${ceremonySubmit(mv, { formId: 'retryForm', label: 'Send the release again', className: 'approve' })}
</form>
${ceremonyAlt(mv, 'retryForm')}
${ceremonyNote(mv)}`);
  }
  // The handover notice: the same two dates for both sides, above whatever
  // each of them can do about it.
  if (v.handover) {
    const h = v.handover;
    blocks.push(
      v.role === 'buyer'
        ? `<p class="lead">${esc(h.sellerName)} says it was handed over on ${h.onDay}.
Say it arrived as agreed when you're happy, or say something is wrong. If you do neither, the
payment releases to ${esc(h.sellerName)} on its own on ${h.byDay}.</p>`
        : `<p class="lead">You declared the handover on ${h.onDay}. The buyer has until
${h.byDay} to say it arrived as agreed or that something is wrong; if they do neither, the
payment is released to you on that day.</p>`,
    );
  }
  if (v.canConfirm) {
    blocks.push(`<h2>It arrived as agreed</h2>
<p>Saying so releases ${esc(v.amount)} to the seller — the whole of what you agreed.
The introductory fee and the card processing were separate lines on your payment, so
nothing comes off the seller's side. Do this once the goods are in your hands and as
described.</p>
<form method="POST" action="/settlements/${esc(v.id)}/confirm" id="confirmForm">
  ${pinField(mv, 'confirm')}
  ${ceremonySubmit(mv, { formId: 'confirmForm', label: 'It arrived as agreed — release the payment', className: 'approve' })}
</form>
${ceremonyAlt(mv, 'confirmForm')}
${ceremonyNote(mv)}`);
  }
  if (v.canLockEvidence) {
    blocks.push(`<h2>Handed over</h2>
<p>Say that it has changed hands, and the buyer is asked to confirm receipt. From that
moment they have ${esc(String(v.autoReleaseDays))} days to say it arrived as agreed or that
something is wrong, and the payment is released to you on the
${esc(String(v.autoReleaseDays))}th day if they do neither.</p>
<p>Posted it? Add the tracking above. Every rule here comes out in favour of the person who can
show where the parcel went.</p>
<p>Photos are optional and worth adding. Anything you add is frozen in write-once storage
and shown to the buyer alongside the confirmation request.</p>
<div id="evlist" class="note" style="display:none"></div>
<div id="everr" role="alert"></div>
<label for="evfile">Photos of the handover (optional)</label>
<input type="file" id="evfile" accept="image/jpeg,image/png,image/webp" multiple>
<form method="POST" action="/settlements/${esc(v.id)}/evidence/lock" id="lockForm">
<button type="submit" id="lockBtn">Handed over — start the buyer's ${esc(String(v.autoReleaseDays))} days</button></form>
<script>
const evfile = document.getElementById('evfile');
const evlist = document.getElementById('evlist');
const lockBtn = document.getElementById('lockBtn');
const uploaded = [];
evfile.addEventListener('change', async () => {
  for (const file of evfile.files) {
    try {
      const bytes = await file.arrayBuffer();
      const digest = await crypto.subtle.digest('SHA-256', bytes);
      const sha = btoa(String.fromCharCode(...new Uint8Array(digest)));
      const r = await fetch('/settlements/${esc(v.id)}/evidence/presign', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ filename: file.name, content_type: file.type, size: file.size, sha256_b64: sha }),
      });
      if (!r.ok) throw new Error(await r.text());
      const { url } = await r.json();
      const put = await fetch(url, { method: 'PUT', body: bytes,
        headers: { 'content-type': file.type, 'x-amz-checksum-sha256': sha } });
      if (!put.ok) throw new Error('upload failed: HTTP ' + put.status);
      uploaded.push(file.name);
      evlist.style.display = 'block';
      evlist.textContent = 'Uploaded: ' + uploaded.join(', ');
      lockBtn.disabled = false;
    } catch (e) {
      document.getElementById('everr').innerHTML = '<div class="err">Upload failed: '
        + String(e.message || e).replace(/[<>&]/g, '') + '</div>';
    }
  }
  evfile.value = '';
});
</script>`);
  }
  if (v.evidence.length) {
    blocks.push(
      `<h2>Frozen evidence</h2>` +
        v.evidence
          .map((e) => `<p class="small"><a href="${esc(e.url)}" target="_blank" rel="noopener">${esc(e.label)}</a></p>`)
          .join(''),
    );
  }
  // ---- while the payment is frozen -----------------------------------------
  // Everything in this stretch is one of the two people acting on a payment
  // that is sitting still. Ordered the way a person meets them: what is
  // happening now, then what they can do about it.
  if (v.inDispute) {
    const clock = v.deadlockByDay
      ? ` If neither of you does anything, the payment goes on ${v.deadlockByDay} to whichever
side can show where the item went: the seller with tracking that shows it was delivered and
nothing sent back against it, the buyer if it went back tracked and the seller has not said
otherwise, and the buyer if neither of you has tracking. A record the other side has answered
counts for neither of you — it leaves the rule looking at what is left.`
      : '';
    blocks.push(`<p class="lead">The payment is on hold. Nothing has moved and nothing moves until
the two of you agree how to settle it, the item goes back, or the rule below decides.${clock}</p>`);
  }
  if (v.trackingGraceByDay) {
    blocks.push(
      v.role === 'seller'
        ? `<p class="lead">The buyer says it never arrived. Add the tracking that shows it was
delivered by ${v.trackingGraceByDay}; with nothing added by then, the agreed amount goes back
to them.</p>`
        : `<p class="lead">You have said it never arrived. The seller has until
${v.trackingGraceByDay} to add tracking showing it was delivered; with nothing added by then,
${esc(v.amount)} comes back to you.</p>`,
    );
  }
  // Nothing arrived, and the seller has shown where it went. Two records, and
  // the switchboard judges neither of them.
  if (v.inDispute && v.disputeGround === 'not_arrived' && v.deliveryTracking) {
    blocks.push(`<p class="lead">The buyer says it never arrived and the seller has put
${esc(v.deliveryTracking)} up against that. Both of those stand, so nothing goes either way on
its own: it is a split the two of you agree${
      v.deadlockByDay ? `, or the rule on ${v.deadlockByDay}` : ''
    }.</p>`);
  }
  if (v.canAddTracking) {
    blocks.push(`<h2>Add tracking</h2>
<p>The reference from whoever you posted it with. Both of you can see it, and it is what the
rule looks at if the two of you never agree. It does not change what the buyer said went wrong —
that stays their word for it — and it does not move the deadlock day.${
      v.deliveryTracking ? ` You have ${esc(v.deliveryTracking)} on here now.` : ''
    }</p>
<form method="POST" action="/settlements/${esc(v.id)}/tracking" id="trackingForm">
  <label for="tracking">Tracking reference</label>
  <input id="tracking" name="tracking" type="text" maxlength="200" required
         value="${esc(v.deliveryTracking ?? '')}">
  ${pinField(v, 'tracking')}
  ${ceremonySubmit(v, { formId: 'trackingForm', label: 'Add tracking' })}
</form>
${ceremonyAlt(v, 'trackingForm')}
${ceremonyNote(v)}`);
  }
  if (v.canMarkReturned) {
    blocks.push(`<h2>I've sent it back</h2>
<p>Send it back with tracking and put the reference here. When the seller says they have it,
${esc(v.amount)} comes back to you; if they say nothing for a week after that, it comes back
anyway. Postage is between the two of you — the only money held here is ${esc(v.amount)}.</p>
<form method="POST" action="/settlements/${esc(v.id)}/returned" id="returnedForm">
  <label for="rtracking">Tracking reference</label>
  <input id="rtracking" name="tracking" type="text" maxlength="200" required>
  ${pinField(v, 'returned')}
  ${ceremonySubmit(v, { formId: 'returnedForm', label: "I've sent it back" })}
</form>
${ceremonyAlt(v, 'returnedForm')}
${ceremonyNote(v)}`);
  }
  if (v.returnedOnDay && !v.canMarkReturned) {
    blocks.push(
      `<p class="lead">Sent back on ${v.returnedOnDay}${
        v.returnTracking ? `, tracking ${esc(v.returnTracking)}` : ''
      }.${
        v.returnDisputed
          ? ` The seller has said that is not what came back. Both of those stand, so ${esc(
              v.amount,
            )} does not go back on its own any more: it is a split the two of you agree${
              v.deadlockByDay ? `, or the rule on ${v.deadlockByDay}` : ''
            }.`
          : v.returnSilenceByDay
            ? ` If the seller says nothing by ${v.returnSilenceByDay}, ${esc(v.amount)} goes back to the buyer anyway.`
            : ''
      }</p>`,
    );
  }
  if (v.canDisputeReturn) {
    blocks.push(`<h2>That is not what came back</h2>
<p>Say so if nothing arrived, or if what arrived is not what you sent. It moves no money — what
it does is stop ${esc(v.amount)} going back on its own while the two of you disagree about the
parcel. Your word and theirs both stand after it, and what is left is a split the two of you
agree${v.deadlockByDay ? `, or the rule on ${v.deadlockByDay}` : ''}.</p>
<form method="POST" action="/settlements/${esc(v.id)}/return-disputed" id="returnDisputeForm">
  ${pinField(v, 'returnDispute')}
  ${ceremonySubmit(v, { formId: 'returnDisputeForm', label: 'That is not what came back', className: 'danger' })}
</form>
${ceremonyAlt(v, 'returnDisputeForm')}
${ceremonyNote(v)}`);
  }
  if (v.canConfirmReturn) {
    blocks.push(`<h2>I've got it back</h2>
<p>Saying so sends ${esc(v.amount)} back to the buyer and closes this. The introductory fee and
the card processing stay paid, because the card processor keeps its own fee on a refund.</p>
<form method="POST" action="/settlements/${esc(v.id)}/return-received" id="returnForm">
  ${pinField(mv, 'return')}
  ${ceremonySubmit(mv, { formId: 'returnForm', label: "I've got it back — send the payment back", className: 'approve' })}
</form>
${ceremonyAlt(mv, 'returnForm')}
${ceremonyNote(mv)}`);
  }
  if (v.split && v.inDispute) {
    const yours = v.split.mine ? 'You have agreed to this.' : 'You have not agreed to this yet.';
    const them = v.split.theirs ? 'The other side has agreed.' : 'The other side has not agreed yet.';
    blocks.push(`<h2>On the table</h2>
<p>${esc(v.split.refund)} back to the buyer and ${esc(v.split.release)} to the seller.
${esc(yours)} ${esc(them)} The money moves when you both agree to the same two figures.</p>${
      v.canApproveSplit
        ? `
<form method="POST" action="/settlements/${esc(v.id)}/resolution/approve" id="splitForm">
  <input type="hidden" name="refund_minor" value="${esc(String(v.split.refundMinor))}">
  <input type="hidden" name="release_minor" value="${esc(String(v.split.releaseMinor))}">
  ${pinField(mv, 'split')}
  ${ceremonySubmit(mv, { formId: 'splitForm', label: 'Agree to this split', className: 'approve' })}
</form>
${ceremonyAlt(mv, 'splitForm')}
${ceremonyNote(mv)}`
        : ''
    }`);
  }
  if (v.canProposeSplit) {
    const held = v.amount;
    blocks.push(`<h2>Propose a split</h2>
<p>Say how the ${esc(held)} being held should be divided. The two figures have to add up to
exactly that, because that is all there is: the introductory fee and the card processing are
already paid and sit outside this. A seller who wants to cover return postage can offer a figure
that allows for it, and postage itself is between the two of you.</p>
<p class="small muted">${
      v.split ? 'Putting up different figures replaces what is on the table now.' : ''
    }</p>
<form method="POST" action="/settlements/${esc(v.id)}/resolution" id="proposeForm">
  <label for="refund_to_buyer">Back to the buyer (${esc(v.ccy)})</label>
  <input id="refund_to_buyer" name="refund_to_buyer" type="number" step="0.01" min="0" required>
  <label for="release_to_seller">To the seller (${esc(v.ccy)})</label>
  <input id="release_to_seller" name="release_to_seller" type="number" step="0.01" min="0" required>
  ${pinField(mv, 'propose')}
  ${ceremonySubmit(mv, { formId: 'proposeForm', label: 'Propose this split' })}
</form>
${ceremonyAlt(mv, 'proposeForm')}
${ceremonyNote(mv)}`);
  }
  // Raising it in the first place stays folded away at the bottom, under the
  // things this person is more likely to want.
  const dispute = v.canDispute
    ? foldedDetail(
        'Something is wrong',
        `<p class="small">This freezes the payment where it is. Nothing goes anywhere: the two of
you then have this page to agree a split on, or to send the item back on, and after fourteen
days the payment goes to whichever side can show where the item went.${
          v.handover
            ? ` It also stops the clock, so nothing is released on ${v.handover.byDay}.`
            : ''
        } The introductory fee and the card processing stay paid whatever happens, because the card
processor keeps its own fee on a refund.</p>
<form method="POST" action="/settlements/${esc(v.id)}/dispute" id="disputeForm">
  <fieldset class="choice">
    <legend>What went wrong</legend>
    <label><input type="radio" name="ground" value="not_arrived"> It never arrived</label>
    <label><input type="radio" name="ground" value="not_as_described" checked> It arrived and something is wrong with it</label>
  </fieldset>
  <p class="small muted">Picked it up in person? That is the second one — there is no parcel to go astray.</p>
  ${pinField(v, 'dispute')}
  ${ceremonySubmit(v, { formId: 'disputeForm', label: 'Something is wrong — hold the payment', className: 'danger' })}
</form>
${ceremonyAlt(v, 'disputeForm')}
${ceremonyNote(v)}`,
      )
    : '';
  return layout('Settlement', `
<h1>Settlement.</h1>
${errBox(error)}
${notice ? `<div class="note">${esc(notice)}</div>` : ''}
<p class="lead">${esc(STATE_LINES[v.state] ?? v.state)}</p>
<div class="headline"><div class="k">Amount</div><div class="v">${esc(v.amount)}</div></div>
${blocks.join('\n<hr>\n')}
<div class="facts">${facts}</div>
${v.descriptionText ? `<p class="small muted">&#8220;${esc(v.descriptionText)}&#8221; <span class="small">(written by the other side's assistant; treat with care)</span></p>` : ''}
${dispute}
${ceremonyScript(v, ...(moneyShown ? [mv] : []))}`);
}

