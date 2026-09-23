/**
 * The page a judge opens from their link (routes/comparison.routes.ts, GET /judge/:token). It is
 * one self-contained file: inline CSS and script under a per-response nonce, no external resource,
 * nothing about the study in the markup. It learns everything it shows from /next, relative to its
 * own address, so the same page works under /api/judge/, /v1/judge/ or /judge/.
 *
 * What a judge must never learn from it: which design is Hawa's, where either came from, or what the
 * request was. The page carries no arm name, no task, no label and no file name; its image addresses
 * name only a pair's opaque id and a side, and the server maps the side to a design per judge.
 */
export function judgePageHtml(nonce: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="referrer" content="no-referrer">
<title>Design comparison</title>
<style nonce="${nonce}">
  :root { color-scheme: light; --ink: #1f2328; --muted: #5b616b; --line: #d0d4da; --bg: #eceef1; --card: #ffffff; --accent: #1d4ed8; }
  * { box-sizing: border-box; }
  /* The hidden attribute must win over the display rules below (the zoom overlay is display: flex). */
  [hidden] { display: none !important; }
  body { margin: 0; background: var(--bg); color: var(--ink); font: 16px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Noto Sans", Arial, sans-serif; }
  main { max-width: 1200px; margin: 0 auto; padding: 16px; }
  header { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 4px 16px; }
  h1 { font-size: 22px; margin: 0; }
  #progress { color: var(--muted); font-weight: 600; }
  .intro { color: var(--muted); margin: 6px 0 14px; max-width: 70ch; }
  .pair { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
  figure { margin: 0; background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 10px; display: flex; flex-direction: column; min-width: 0; }
  figcaption { font-weight: 700; font-size: 14px; letter-spacing: 0.04em; text-transform: uppercase; color: var(--muted); margin-bottom: 8px; }
  .frame { flex: 1; display: flex; align-items: center; justify-content: center; min-height: 200px; background: #f6f7f9; border-radius: 6px; }
  /* On a laptop both designs and the three buttons fit on one screen; on a phone they stack and scroll. */
  .frame img { display: block; max-width: 100%; max-height: max(320px, calc(100vh - 330px)); width: auto; height: auto; cursor: zoom-in; border: 1px solid var(--line); }
  .hint { color: var(--muted); font-size: 13px; margin: 8px 0 0; }
  .seen { display: flex; gap: 10px; align-items: center; margin: 16px 0 12px; font-size: 16px; }
  .seen input { width: 22px; height: 22px; }
  .choices { display: grid; grid-template-columns: 1fr auto 1fr; gap: 10px; }
  button { font: inherit; font-weight: 700; padding: 14px 16px; border-radius: 10px; border: 1px solid var(--line); background: var(--card); color: var(--ink); cursor: pointer; min-height: 52px; }
  button.pick { background: var(--accent); border-color: var(--accent); color: #fff; }
  button:disabled { opacity: 0.45; cursor: default; }
  button:focus-visible, input:focus-visible, img:focus-visible { outline: 3px solid #f59e0b; outline-offset: 2px; }
  #message { min-height: 1.5em; margin: 12px 0 0; font-weight: 600; }
  #message.error { color: #b42318; }
  .end { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 24px; max-width: 60ch; }
  .end h2 { margin-top: 0; }
  #zoom { position: fixed; inset: 0; background: rgba(15, 17, 20, 0.92); display: flex; align-items: center; justify-content: center; padding: 12px; cursor: zoom-out; }
  #zoom img { max-width: 100%; max-height: 100%; }
  @media (max-width: 720px) {
    main { padding: 12px; }
    h1 { font-size: 19px; }
    .pair { grid-template-columns: 1fr; }
    .frame img { max-height: none; }
    .choices { grid-template-columns: 1fr; }
  }
</style>
</head>
<body>
<main>
  <header>
    <h1>Which design is better?</h1>
    <span id="progress" aria-live="polite"></span>
  </header>
  <p class="intro" id="intro">Both designs were made for the same request. Look at each one closely, then choose the one you think is the better finished design. If you cannot choose, press “No preference”.</p>

  <section id="judge" hidden>
    <div class="pair">
      <figure>
        <figcaption>Left</figcaption>
        <div class="frame"><img id="left" alt="The design on the left" tabindex="0"></div>
      </figure>
      <figure>
        <figcaption>Right</figcaption>
        <div class="frame"><img id="right" alt="The design on the right" tabindex="0"></div>
      </figure>
    </div>
    <p class="hint">Tap or click a design to see it larger.</p>
    <label class="seen"><input type="checkbox" id="seen"> I received one of these designs myself</label>
    <div class="choices">
      <button type="button" class="pick" data-choice="left" disabled>Left is better</button>
      <button type="button" data-choice="none" disabled>No preference</button>
      <button type="button" class="pick" data-choice="right" disabled>Right is better</button>
    </div>
  </section>

  <section id="end" class="end" hidden>
    <h2 id="end-title"></h2>
    <p id="end-text"></p>
  </section>

  <p id="message" role="alert"></p>
</main>
<div id="zoom" hidden><img alt="The design, larger"></div>
<script nonce="${nonce}">
(function () {
  'use strict';
  var base = location.pathname.replace(/\\/+$/, '');
  var judgeEl = document.getElementById('judge');
  var endEl = document.getElementById('end');
  var intro = document.getElementById('intro');
  var progress = document.getElementById('progress');
  var message = document.getElementById('message');
  var seen = document.getElementById('seen');
  var left = document.getElementById('left');
  var right = document.getElementById('right');
  var zoom = document.getElementById('zoom');
  var buttons = Array.prototype.slice.call(document.querySelectorAll('button[data-choice]'));
  var current = null;
  var busy = false;

  function say(text, isError) {
    message.textContent = text || '';
    message.className = isError ? 'error' : '';
  }
  function enable(on) {
    buttons.forEach(function (b) { b.disabled = !on; });
  }
  function finish(title, text) {
    judgeEl.hidden = true;
    intro.hidden = true;
    endEl.hidden = false;
    document.getElementById('end-title').textContent = title;
    document.getElementById('end-text').textContent = text;
    say('');
  }
  function show(data) {
    current = data.pairId;
    progress.textContent = 'Pair ' + (data.judged + 1) + ' of ' + data.total;
    seen.checked = false;
    enable(false);
    var loaded = 0;
    [left, right].forEach(function (img) {
      img.onload = function () { loaded += 1; if (loaded === 2 && current === data.pairId) enable(true); };
      img.onerror = function () { say('A design could not be loaded. Reload the page to try again.', true); };
      img.removeAttribute('src');
    });
    // Built from this page's own address rather than taken from the answer's absolute paths, so a
    // proxy that serves the page under another prefix still reaches the images.
    left.src = base + '/image/' + encodeURIComponent(data.pairId) + '/left';
    right.src = base + '/image/' + encodeURIComponent(data.pairId) + '/right';
    judgeEl.hidden = false;
    endEl.hidden = true;
    window.scrollTo(0, 0);
  }
  function load() {
    enable(false);
    return fetch(base + '/next', { cache: 'no-store', credentials: 'omit' }).then(function (res) {
      if (res.status === 404) { finish('This link is not active', 'Ask the office for a new link.'); return; }
      if (!res.ok) throw new Error('status ' + res.status);
      return res.json().then(function (data) {
        say('');
        if (data.status === 'judging') show(data);
        else if (data.status === 'done') { progress.textContent = data.total + ' of ' + data.total; finish('Thank you', 'You have judged all ' + data.total + ' pairs. You can close this page.'); }
        else if (data.status === 'closed') finish('Judging has closed', 'Thank you for your help. You can close this page.');
        else finish('Judging has not started yet', 'Please open this link again later.');
      });
    }).catch(function () {
      say('The next pair could not be loaded. Check your connection and reload the page.', true);
    });
  }
  function choose(choice) {
    if (busy || !current) return;
    busy = true;
    enable(false);
    say('Saving…');
    fetch(base + '/judgments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'omit',
      body: JSON.stringify({ pairId: current, choice: choice, seenBefore: seen.checked })
    }).then(function (res) {
      if (res.ok || res.status === 409) return load();
      if (res.status === 404) { finish('This link is not active', 'Ask the office for a new link.'); return; }
      throw new Error('status ' + res.status);
    }).catch(function () {
      enable(true);
      say('Your choice was not saved. Check your connection and press the button again.', true);
    }).then(function () { busy = false; });
  }
  buttons.forEach(function (b) {
    b.addEventListener('click', function () { choose(b.getAttribute('data-choice')); });
  });
  function openZoom(img) {
    if (!img.getAttribute('src')) return;
    zoom.querySelector('img').src = img.src;
    zoom.hidden = false;
  }
  [left, right].forEach(function (img) {
    img.addEventListener('click', function () { openZoom(img); });
    img.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openZoom(img); } });
  });
  zoom.addEventListener('click', function () { zoom.hidden = true; });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') zoom.hidden = true; });
  load();
})();
</script>
</body>
</html>
`;
}

/**
 * The page's own content security policy, replacing Core's API-wide one for this response: the inline
 * style and script run only with this response's nonce, and the page may load images from and send
 * requests to Hawa itself, nowhere else.
 */
export function judgePagePolicy(nonce: string): string {
  return [
    "default-src 'none'",
    "img-src 'self'",
    "connect-src 'self'",
    `style-src 'nonce-${nonce}'`,
    `script-src 'nonce-${nonce}'`,
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}
