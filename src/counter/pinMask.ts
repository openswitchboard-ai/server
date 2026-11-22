/**
 * PIN BOXES SHOW DOTS (22 November 2026).
 *
 * The PIN boxes used to show their digits. They are text boxes rather than
 * password fields on purpose (pages.ts CSS): Safari treats any masked box,
 * type=password or -webkit-text-security, as a password, offers to invent one
 * and asks to save it. But an assistant with a browser of its own that the
 * person shares (Meta's Muse) reads that browser's screen and page text, so a
 * PIN typed there was on the assistant's screen.
 *
 * So the box stays a plain text box and this script does the masking: the
 * box only ever holds dots, and the digits are kept in this script and added
 * under the box's own name only as the form is sent. They are in neither the
 * screen, the page's text nor its markup. Without the script the box works as
 * before, digits and all.
 *
 * How an edit is read: every character in the box that is not a dot was just
 * typed or pasted, and sits just before the cursor. The dots that are gone
 * were deleted from where the new characters start. That covers typing,
 * pasting, backspace, forward delete and replacing a selection, whatever the
 * keyboard reports.
 *
 * Scripts that need the digits ask window.osbPinValue(box); one that empties
 * a box calls window.osbPinClear(box). The sealed-details pages allow no
 * inline script, so sealed.js carries this same code (sealedScript.ts).
 */
export const PIN_MASK_JS = String.raw`
(function () {
  if (window.osbPinValue) return;
  var DOT = '•', MAX = 12, store = new WeakMap();
  function digits(el) { return store.get(el) || ''; }
  function onInput(ev) {
    var el = ev.target, old = digits(el), v = el.value;
    var typed = '', kept = 0;
    for (var i = 0; i < v.length; i++) { if (v[i] === DOT) kept++; else typed += v[i]; }
    var caret = el.selectionStart == null ? v.length : el.selectionStart;
    var start = Math.max(0, Math.min(caret - typed.length, kept));
    var gone = Math.max(0, old.length - kept);
    var add = typed.replace(/[^0-9]/g, '');
    var next = (old.slice(0, start) + add + old.slice(start + gone)).slice(0, MAX);
    store.set(el, next);
    el.value = new Array(next.length + 1).join(DOT);
    var at = Math.min(start + add.length, next.length);
    try { el.setSelectionRange(at, at); } catch (e) {}
  }
  function arm(el) {
    if (store.has(el)) return;
    store.set(el, '');
    var name = el.getAttribute('name');
    if (name && el.form) {
      // The digits join the form only as it is sent: the 'formdata' event
      // fires for a normal submit and for new FormData(form) alike. A hidden
      // field would not do, because its value is written into the markup.
      el.removeAttribute('name');
      var form = el.form;
      if (window.FormDataEvent) {
        form.addEventListener('formdata', function (e) { e.formData.set(name, digits(el)); });
      } else {
        var h = document.createElement('input');
        h.type = 'hidden'; h.name = name;
        el.parentNode.insertBefore(h, el.nextSibling);
        document.addEventListener('submit', function (e) { if (e.target === form) h.value = digits(el); }, true);
        window.addEventListener('pageshow', function () { h.value = ''; });
      }
    }
    el.setAttribute('pattern', '[' + DOT + ']{6,12}');
    // Anything already in the box (a page restored from history) is read as typed.
    if (el.value) onInput({ target: el });
    el.addEventListener('input', onInput);
  }
  function armAll(root) {
    var l = (root || document).querySelectorAll('input.pinbox');
    for (var i = 0; i < l.length; i++) arm(l[i]);
  }
  window.osbPinValue = function (el) { return store.has(el) ? digits(el) : (el && el.value) || ''; };
  window.osbPinClear = function (el) { if (!el) return; store.set(el, ''); el.value = ''; };
  function start() {
    armAll();
    // Pages pressed in place swap their content without a reload.
    if (window.MutationObserver) new MutationObserver(function () { armAll(); }).observe(document.body, { childList: true, subtree: true });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
`;
