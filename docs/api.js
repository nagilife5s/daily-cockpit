/**
 * daily-cockpit — google.script.run の代わり（GitHub Pages 版 2026-09-29）
 *
 * index.html の Store は GAS 時代のまま google.script.run を呼ぶ。ここでそれを
 * Cloudflare Worker への fetch に差し替える。Store 側は1行も変えなくてよい。
 *
 *   ・合言葉は初回だけ聞いて、この端末の localStorage に覚える（dc.key）
 *   ・401（合言葉違い）なら忘れて聞き直し、1回だけやり直す
 *   ・?mock=1 を付けて開くと何もしない（index.html のダミーデータで動く）
 */
(function () {
  var API_BASE = 'https://daily-cockpit-api.nagi-life-5s.workers.dev';   /* デプロイ後に書き換える */

  if (/[?&]mock=1\b/.test(location.search)) return;

  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch (e) {} }

  function getKey(force) {
    var k = force ? null : lsGet('dc.key');
    if (!k) {
      k = window.prompt(force ? '合言葉が違うようです。もう一度入力してください' : 'daily-cockpit の合言葉を入力してください');
      if (k) lsSet('dc.key', k.trim());
    }
    return k ? k.trim() : '';
  }

  function call(fn, args, retried) {
    var base = lsGet('dc.apiBase') || API_BASE;
    return fetch(base + '/api/' + fn, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Cockpit-Key': getKey(retried) },
      body: JSON.stringify({ args: args })
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (js) {
        if (res.status === 401 && !retried) { lsSet('dc.key', null); return call(fn, args, true); }
        if (!res.ok) throw new Error(js.error || ('通信エラー (' + res.status + ')'));
        return js.result;
      });
    });
  }

  function runner(ok, ng) {
    return new Proxy({}, {
      get: function (_, name) {
        if (name === 'withSuccessHandler') return function (f) { return runner(f, ng); };
        if (name === 'withFailureHandler') return function (f) { return runner(ok, f); };
        if (typeof name !== 'string') return undefined;
        return function () {
          var args = Array.prototype.slice.call(arguments);
          call(name, args).then(
            function (r) { if (ok) ok(r); },
            function (e) { if (ng) ng(e); else console.error(e); }
          );
        };
      }
    });
  }

  window.google = { script: { run: runner(null, null) } };
})();
