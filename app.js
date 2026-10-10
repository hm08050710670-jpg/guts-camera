/* ==========================================================
   GUTS CAMERA  アプリ本体
   - 画面切り替え / IndexedDB 保存 / 動画分析（補助線・スロー・コマ送り）
   - フレームワーク・ビルド不要。このファイルを直接編集できます。
   ========================================================== */
(function () {
  'use strict';

  var APP_VERSION = '1.7.0';

  var CLUBS = ['ドライバー', '3W', '5W', 'UT', '5I', '6I', '7I', '8I', '9I', 'PW', 'AW', 'SW', 'パター', 'その他'];
  var COLORS = [
    ['蛍光イエロー', '#DFFF00'],
    ['白', '#FFFFFF'],
    ['赤', '#FF3B30'],
    ['青', '#2F8CFF'],
    ['緑', '#30D158'],
    ['黄色', '#FFD60A']
  ];
  var FPS_CHOICES = [24, 25, 30, 60, 120, 240];
  var FPS_SNAP = [24, 25, 30, 48, 50, 60, 90, 100, 120, 240];
  var DEFAULT_FPS = 30;
  var HAS_RVFC = typeof HTMLVideoElement !== 'undefined' &&
    'requestVideoFrameCallback' in HTMLVideoElement.prototype;

  function $(id) { return document.getElementById(id); }
  function clamp(v, a, b) { return Math.min(b, Math.max(a, v)); }
  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function todayStr(d) {
    d = d || new Date();
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }
  function fmtTime(t) {
    if (!isFinite(t) || t < 0) t = 0;
    var cs = Math.floor(t * 100 + 1e-6);
    var m = Math.floor(cs / 6000);
    var s = Math.floor((cs % 6000) / 100);
    return m + ':' + pad2(s) + '.' + pad2(cs % 100);
  }
  function fmtSize(bytes) {
    if (!bytes && bytes !== 0) return '';
    if (bytes >= 1073741824) return (bytes / 1073741824).toFixed(1) + 'GB';
    return Math.max(1, Math.round(bytes / 1048576)) + 'MB';
  }
  function fmtDate(str) {
    if (!str) return '';
    var p = str.split('-');
    return p.length === 3 ? p[0] + '/' + Number(p[1]) + '/' + Number(p[2]) : str;
  }

  /* ==========================================================
     IndexedDB
     items    : 動画の情報（タイトル・クラブ・サムネイルなど）
     videos   : 動画データ本体
     drawings : 補助線データ（動画とは別に保存）
     ========================================================== */
  var dbPromise = null;
  function openDb() {
    if (!dbPromise) {
      dbPromise = new Promise(function (resolve, reject) {
        if (!window.indexedDB) { reject(new Error('IndexedDB が使えません')); return; }
        var req = indexedDB.open('guts-camera', 1);
        req.onupgradeneeded = function () {
          var d = req.result;
          if (!d.objectStoreNames.contains('items')) d.createObjectStore('items', { keyPath: 'id' });
          if (!d.objectStoreNames.contains('videos')) d.createObjectStore('videos', { keyPath: 'id' });
          if (!d.objectStoreNames.contains('drawings')) d.createObjectStore('drawings', { keyPath: 'id' });
        };
        req.onsuccess = function () { resolve(req.result); };
        req.onerror = function () { reject(req.error); };
      });
      dbPromise.catch(function () { dbPromise = null; });
    }
    return dbPromise;
  }
  function dbTx(stores, mode, fn) {
    return openDb().then(function (d) {
      return new Promise(function (resolve, reject) {
        var t = d.transaction(stores, mode);
        var out;
        t.oncomplete = function () { resolve(out && 'result' in out ? out.result : undefined); };
        t.onerror = function () { reject(t.error); };
        t.onabort = function () { reject(t.error || new Error('保存が中断されました')); };
        out = fn(t);
      });
    });
  }
  function dbGet(store, id) {
    return dbTx([store], 'readonly', function (t) { return t.objectStore(store).get(id); });
  }
  function dbAll(store) {
    return dbTx([store], 'readonly', function (t) { return t.objectStore(store).getAll(); });
  }
  function dbPut(store, value) {
    return dbTx([store], 'readwrite', function (t) { t.objectStore(store).put(value); });
  }

  /* ==========================================================
     共通UI：トースト・確認ダイアログ
     ========================================================== */
  var toastTimer = 0;
  function toast(msg, ms) {
    var el = $('toast');
    el.textContent = msg;
    // カメラ画面では録画ボタンに重ならないよう、上側に表示する
    el.classList.toggle('is-high', currentScreen === 'camera');
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.hidden = true; }, ms || 2600);
  }

  // buttons: [{label, value, kind}]  kind: 'primary' | 'danger' | undefined
  function ask(title, text, buttons) {
    return new Promise(function (resolve) {
      $('dialog-title').textContent = title;
      $('dialog-text').textContent = text || '';
      var box = $('dialog-actions');
      box.textContent = '';
      buttons.forEach(function (b) {
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'btn' + (b.kind ? ' is-' + b.kind : '');
        btn.textContent = b.label;
        btn.addEventListener('click', function () {
          $('dialog').hidden = true;
          resolve(b.value);
        });
        box.appendChild(btn);
      });
      $('dialog').hidden = false;
    });
  }
  function busy(on, text) {
    $('busy-text').textContent = text || '読み込み中…';
    $('busy').hidden = !on;
  }

  /* ==========================================================
     画面切り替え
     ========================================================== */
  var currentScreen = 'home';
  function show(name) {
    currentScreen = name;
    ['home', 'capture', 'camera', 'list', 'analyze'].forEach(function (n) {
      $('screen-' + n).classList.toggle('is-active', n === name);
    });
    if (name === 'home') refreshStorageInfo();
  }

  function refreshStorageInfo() {
    var el = $('storage-info');
    dbAll('items').then(function (items) {
      var total = items.reduce(function (a, i) { return a + (i.size || 0); }, 0);
      el.textContent = items.length
        ? '保存済み ' + items.length + '本（約' + fmtSize(total) + '）'
        : '';
    }).catch(function () {
      el.textContent = 'このブラウザでは動画を保存できない設定になっています（プライベートブラウズ等）。';
    });
  }

  /* ==========================================================
     撮影・取り込み
     ========================================================== */
  var captureDir = '後方';
  var DIR_HINT = {
    '後方': '後方：シャフトラインの確認におすすめ',
    '正面': '正面：スウェーライン・頭の枠の確認におすすめ'
  };

  function bindSeg(el, onChange) {
    el.addEventListener('click', function (e) {
      var b = e.target.closest('button');
      if (!b) return;
      setSeg(el, b.getAttribute('data-val'));
      if (onChange) onChange(b.getAttribute('data-val'));
    });
  }
  function setSeg(el, val) {
    Array.prototype.forEach.call(el.children, function (b) {
      b.classList.toggle('is-on', b.getAttribute('data-val') === val);
    });
  }
  function getSeg(el) {
    var on = el.querySelector('.is-on');
    return on ? on.getAttribute('data-val') : '';
  }

  function handleFile(input, kind, dir, from) {
    var file = input.files && input.files[0];
    input.value = '';
    if (!file) return;
    if (file.type && file.type.indexOf('video/') !== 0) {
      ask('動画ファイルではありません', '動画（MOV / MP4 など）を選んでください。', [{ label: 'OK', value: 1, kind: 'primary' }]);
      return;
    }
    if (file.size > 500 * 1048576) {
      toast('大きな動画です（' + fmtSize(file.size) + '）。\n読み込み・保存に時間がかかる場合があります。', 4200);
    }
    openVideo({
      blob: file,
      kind: kind,
      from: from,
      meta: {
        title: '',
        date: todayStr(file.lastModified ? new Date(file.lastModified) : new Date()),
        club: 'ドライバー',
        dir: dir,
        memo: '',
        fav: false,
        fps: 'auto',
        fileName: file.name || ''
      }
    });
  }

  /* ==========================================================
     アプリ内カメラ
     - getUserMedia で高解像度を指定してプレビューし、MediaRecorder で録画する。
     - 録画が終わったら、そのまま動画分析画面へ渡す。
     - 120/240fps のスロー撮影はブラウザからはできない（30fps または 60fps）。
     ========================================================== */
  var camVideo = $('cam-video');
  var cam = {
    stream: null, rec: null, chunks: [], recording: false,
    fpsMode: loadCamFps(), facing: 'environment',
    token: 0, t0: 0, timer: 0, wake: null, discard: false, failed: false,
    zoom: loadCamZoom(),   // 標準を 1 とした倍率（0.5 = 広角）
    onUltra: false,        // 超広角カメラ（別のカメラ）で起動しているか
    ultraId: null,         // 超広角カメラのID（見つかった場合）
    wideMax: 1,            // 標準カメラで拡大できる上限（倍率）
    ctl: null,             // いまのカメラでのズームの扱い方
    diag: {}
  };
  var MAX_ZOOM = 5;
  var CAM_MAX_SEC = 60;

  // 前回選んだフレームレートを覚えておく（60fps非対応の端末で毎回試し直さないため）
  function loadCamFps() {
    try { return localStorage.getItem('guts-cam-fps') === '30' ? 30 : 60; } catch (e) { return 60; }
  }
  function saveCamFps() {
    try { localStorage.setItem('guts-cam-fps', String(cam.fpsMode)); } catch (e) {}
  }

  function loadCamZoom() {
    try {
      var v = parseFloat(localStorage.getItem('guts-cam-zoom'));
      if (v >= 0.3 && v <= 10) return v;
      if (localStorage.getItem('guts-cam-lens') === 'ultra') return 0.5;   // 以前の版の設定
    } catch (e) {}
    return 1;
  }
  function saveCamZoom() {
    try { localStorage.setItem('guts-cam-zoom', String(Math.round(cam.zoom * 100) / 100)); } catch (e) {}
  }

  function camSupported() {
    return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder);
  }
  // アプリ内カメラが使えないときの、従来方式（iPhoneのカメラを起動）への切り替え
  function useSystemCamera() { $('file-camera').click(); }

  function openCamera() {
    if (!camSupported()) {
      ask('アプリ内カメラを使えません', 'このブラウザはアプリ内での録画に対応していません。\niPhoneのカメラを起動して撮影できますが、画質は下がります。', [
        { label: 'iPhoneのカメラで撮影', value: 1, kind: 'primary' },
        { label: 'キャンセル', value: 0 }
      ]).then(function (ok) { if (ok) useSystemCamera(); });
      return;
    }
    $('cam-dir').textContent = captureDir + 'から撮影';
    $('cam-quality').textContent = '';
    $('cam-fps').textContent = cam.fpsMode + 'fps';
    setRecUI(false);
    show('camera');
    startStream();
    if (navigator.wakeLock && navigator.wakeLock.request) {
      navigator.wakeLock.request('screen').then(function (w) {
        if (currentScreen === 'camera') cam.wake = w; else w.release();
      }).catch(function () {});
    }
  }

  function closeCamera() {
    cam.token++;
    if (cam.recording) { cam.discard = true; stopRec(); }
    stopStream();
    if (cam.wake) { try { cam.wake.release(); } catch (e) {} cam.wake = null; }
    fillMsg($('cam-msg'), null);
  }

  function stopStream() {
    if (cam.stream) {
      cam.stream.getTracks().forEach(function (t) { t.onended = null; try { t.stop(); } catch (e) {} });
      cam.stream = null;
    }
    try { camVideo.pause(); } catch (e) {}
    camVideo.srcObject = null;
  }

  // 広角を「別のカメラ（超広角カメラ）」として起動する状態かどうか
  function useUltraDevice() {
    return cam.facing === 'environment' && cam.onUltra && !!cam.ultraId;
  }
  function camConstraints(w, h, frameRate) {
    var v = { width: { ideal: w }, height: { ideal: h }, frameRate: frameRate };
    if (useUltraDevice()) v.deviceId = { exact: cam.ultraId };
    else v.facingMode = { ideal: cam.facing };
    return { audio: false, video: v };
  }
  function isPermissionError(e) {
    return !!e && (e.name === 'NotAllowedError' || e.name === 'SecurityError' || e.name === 'PermissionDeniedError');
  }
  // 60fps を優先して試し、端末が対応していなければ 30fps に下げる
  function getCamStream(mode) {
    var md = navigator.mediaDevices;
    function std() { return md.getUserMedia(camConstraints(1920, 1080, { ideal: 30 })); }
    if (mode !== 60) return std().then(function (s) { return { stream: s }; });
    return md.getUserMedia(camConstraints(1920, 1080, { min: 50, ideal: 60 }))
      .catch(function (e) {
        if (isPermissionError(e)) throw e;
        return md.getUserMedia(camConstraints(1280, 720, { min: 50, ideal: 60 }));
      })
      .then(function (s) { return { stream: s }; })
      .catch(function (e) {
        if (isPermissionError(e)) throw e;
        return std().then(function (s) { return { stream: s, downgraded: true }; });
      });
  }

  function startStream() {
    var token = ++cam.token;
    stopStream();
    cam.failed = false;
    $('cam-rec').disabled = true;
    fillMsg($('cam-msg'), { spinner: true, text: 'カメラを起動中…' });
    getCamStream(cam.fpsMode).then(function (res) {
      if (token !== cam.token || currentScreen !== 'camera') {
        res.stream.getTracks().forEach(function (t) { t.stop(); });
        return;
      }
      cam.stream = res.stream;
      if (res.downgraded) {
        cam.fpsMode = 30;
        saveCamFps();
        $('cam-fps').textContent = '30fps';
        toast('このカメラは60fpsで撮影できないため、30fpsにしました', 3600);
      }
      var track = res.stream.getVideoTracks()[0];
      if (track) track.onended = function () {
        if (token !== cam.token) return;
        if (cam.recording) stopRec();
        else { stopStream(); showCamError({ name: 'TrackEnded' }); }
      };
      camVideo.srcObject = res.stream;
      var p = camVideo.play();
      if (p && p.catch) p.catch(function () {});
      fillMsg($('cam-msg'), null);
      $('cam-rec').disabled = false;
      updateCamInfo();
      setupFocus(track);
      setupLens(track, token);
    }).catch(function (err) {
      if (token !== cam.token) return;
      if (useUltraDevice()) {
        // 広角カメラを起動できなかった場合は、標準のカメラに戻してやり直す
        cam.onUltra = false;
        cam.ultraId = null;
        cam.ctl = null;
        cam.zoom = 1;
        saveCamZoom();
        updateLensUI();
        toast('広角カメラを起動できなかったため、標準に戻しました', 3600);
        startStream();
        return;
      }
      showCamError(err);
    });
  }

  function updateCamInfo() {
    if (!cam.stream) return;
    var track = cam.stream.getVideoTracks()[0];
    var st = track && track.getSettings ? track.getSettings() : {};
    var w = camVideo.videoWidth || st.width, h = camVideo.videoHeight || st.height;
    var parts = [];
    if (w && h) parts.push(w + '×' + h);
    if (st.frameRate) parts.push(Math.round(st.frameRate) + 'fps');
    if (cam.ctl && cam.facing === 'environment' && Math.abs(cam.zoom - 1) > 0.04) parts.push(fmtZoom(cam.zoom) + '×');
    $('cam-quality').textContent = parts.join('・');
  }

  /* ---------- ズーム（広角〜拡大） ----------
     iPhoneのカメラに近い操作：
       ・録画ボタンの上の「.5 / 1× / 2」をタップして切り替え
       ・プレビューを2本指でつまんで、なめらかに拡大・縮小
       ・「.5 / 1× / 2」の並びを指でなぞっても、なめらかに変えられる
     端末・iOSのバージョンによって使える方法が違うため、起動したカメラから調べて決める。
       zoom   : 1つのカメラのまま、ズームの指定だけで広角〜拡大ができる
       device : 広角は超広角カメラ（別のカメラ）に切り替える。各カメラでズームできる場合はその範囲で動かす
     倍率は、標準のカメラを 1 として扱う。 */
  var ULTRA_LABEL = /ultra[\s-]?wide|超広角|ウルトラワイド/i;
  var FRONT_LABEL = /front|前面|フロント|facetime|インカメラ/i;

  function fmtZoom(z) {
    var r = Math.round(z * 10) / 10;
    return r % 1 === 0 ? String(r) : r.toFixed(1);
  }
  function shortZoom(p) {
    return p < 1 ? '.' + Math.round(p * 10) : fmtZoom(p);
  }

  function setupLens(track, token) {
    cam.ctl = null;
    if (!track || cam.facing !== 'environment') { updateLensUI(); return; }
    var caps = {}, st = {};
    try {
      caps = track.getCapabilities ? track.getCapabilities() : {};
      st = track.getSettings ? track.getSettings() : {};
    } catch (e) {}
    var zc = caps.zoom && typeof st.zoom === 'number' && caps.zoom.max > caps.zoom.min
      ? { min: caps.zoom.min, max: caps.zoom.max, cur: st.zoom } : null;
    cam.diag = { label: track.label || '', zoom: zc ? [zc.min, zc.max, zc.cur] : null, devices: cam.diag.devices };

    if (useUltraDevice()) { buildDeviceCtl(track, zc, true); return; }

    // 1) 1つのカメラのまま標準より広くできる場合（ズームの最小値が、起動時の値より小さい）
    var base = zc ? zc.cur : null;
    // カメラを起動し直したときに広角のまま始まる端末では、前に測った標準の値を使う
    if (zc && cam.zoomBase && cam.zoomBaseLabel === track.label && Math.abs(zc.cur - zc.min) < 0.01 && cam.zoomBase > zc.min) base = cam.zoomBase;
    if (zc && zc.min < base * 0.9) {
      cam.zoomBase = base;
      cam.zoomBaseLabel = track.label;
      var mx = Math.min(zc.max / base, MAX_ZOOM);
      finishCtl({ mode: 'zoom', track: track, zc: zc, base: base, min: zc.min / base, max: mx, devMin: zc.min / base, devMax: mx, applied: zc.cur });
      return;
    }
    // 2) 超広角カメラが別のカメラとして用意されているか調べる
    findUltraDevice(st.deviceId).then(function (id) {
      if (token !== cam.token) return;
      cam.ultraId = id;
      if (id && cam.zoom < 0.95) { cam.onUltra = true; startStream(); return; }   // 広角を選んでいたら、超広角カメラで起動し直す
      buildDeviceCtl(track, zc, false);
    });
  }
  function buildDeviceCtl(track, zc, onUltra) {
    var c = { mode: 'device', track: track, zc: zc, onUltra: onUltra, applied: zc ? zc.cur : null };
    if (onUltra) {
      // 超広角カメラ：そのままで 0.5 倍。ズームできる場合は 1 倍相当まで
      c.base = zc ? zc.min : null;
      c.devMin = 0.5;
      c.devMax = zc ? Math.min(0.5 * zc.max / zc.min, 1) : 0.5;
    } else {
      c.base = zc ? zc.cur : null;
      c.devMin = 1;
      c.devMax = zc ? Math.min(zc.max / zc.cur, MAX_ZOOM) : 1;
      cam.wideMax = c.devMax;
    }
    c.min = cam.ultraId ? 0.5 : 1;
    c.max = Math.max(c.devMax, cam.wideMax || 1);
    finishCtl(c);
  }
  function finishCtl(c) {
    c.presets = [];
    if (c.min <= 0.6) c.presets.push(Math.round(c.min * 100) / 100);
    c.presets.push(1);
    if (c.max >= 2) c.presets.push(2);
    cam.ctl = c;
    cam.zoom = clamp(cam.zoom, c.min, c.max);
    if (c.mode === 'device') {
      // 選んでいる倍率と起動しているカメラが合っていなければ、合うカメラで起動し直す
      var wantUltra = !!cam.ultraId && cam.zoom < 0.95;
      if (wantUltra !== c.onUltra) { cam.onUltra = wantUltra; startStream(); return; }
      cam.zoom = clamp(cam.zoom, c.devMin, c.devMax);
    }
    buildLensButtons();
    applyTrackZoom();
    updateLensUI();
    updateCamInfo();
  }
  function findUltraDevice(currentId) {
    var md = navigator.mediaDevices;
    if (!md || !md.enumerateDevices) return Promise.resolve(null);
    return md.enumerateDevices().then(function (list) {
      var cams = list.filter(function (d) { return d.kind === 'videoinput'; });
      cam.diag.devices = cams.map(function (d) { return d.label || '（名前なし）'; });
      for (var i = 0; i < cams.length; i++) {
        var d = cams[i];
        if (d.deviceId && d.deviceId !== currentId && ULTRA_LABEL.test(d.label || '') && !FRONT_LABEL.test(d.label || '')) return d.deviceId;
      }
      return null;
    }).catch(function () { return null; });
  }

  // 倍率（標準=1）を、いまのカメラのズームの値に直す。ズームできないカメラでは null
  function trackZoomFor(rel) {
    var c = cam.ctl;
    if (!c || !c.zc || c.base == null) return null;
    var z = c.mode === 'device' && c.onUltra ? c.base * (rel / 0.5) : c.base * rel;
    return clamp(z, c.zc.min, c.zc.max);
  }
  var zoomBusy = false, zoomPending = false, zoomWarned = false;
  function applyTrackZoom() {
    var c = cam.ctl;
    if (!c) return;
    var z = trackZoomFor(cam.zoom);
    if (z == null || (c.applied != null && Math.abs(z - c.applied) < 0.001)) return;
    if (zoomBusy) { zoomPending = true; return; }   // 前の変更が終わってから、最新の値だけを送る
    zoomBusy = true;
    var p;
    try { p = c.track.applyConstraints({ advanced: [{ zoom: z }] }); } catch (e) { p = Promise.reject(e); }
    Promise.resolve(p).then(function () { c.applied = z; }, function () {
      if (!zoomWarned) { zoomWarned = true; toast('ズームを変更できませんでした'); }
    }).then(function () {
      zoomBusy = false;
      if (zoomPending) { zoomPending = false; applyTrackZoom(); }
    });
  }

  // live=true：指で動かしている途中（カメラの切り替えはしない）。live=false：ボタンのタップ
  function setZoom(rel, live) {
    var c = cam.ctl;
    if (!c || cam.recording || !(rel > 0)) return;
    rel = clamp(rel, c.min, c.max);
    if (live) {
      // 区切りのよい倍率の近くでは、その倍率にぴったり合わせる
      for (var i = 0; i < c.presets.length; i++) {
        if (Math.abs(rel / c.presets[i] - 1) < 0.04) rel = c.presets[i];
      }
    }
    if (c.mode === 'device') {
      var wantUltra = !!cam.ultraId && rel < 0.999;
      if (!live && wantUltra !== c.onUltra) {
        cam.zoom = rel;
        saveCamZoom();
        cam.onUltra = wantUltra;
        updateLensUI();
        startStream();
        return;
      }
      rel = clamp(rel, c.devMin, c.devMax);
    }
    cam.zoom = rel;
    applyTrackZoom();
    updateLensUI();
    updateCamInfo();
    saveCamZoom();
  }

  function lensVisible() {
    var c = cam.ctl;
    return !!c && cam.facing === 'environment' && (c.presets.length >= 2 || c.devMax - c.devMin > 0.05);
  }
  function buildLensButtons() {
    var box = $('cam-lens');
    box.textContent = '';
    if (!cam.ctl) return;
    cam.ctl.presets.forEach(function (p) {
      var b = document.createElement('button');
      b.setAttribute('data-zoom', String(p));
      b.setAttribute('aria-label', p < 1 ? '広角' : (p === 1 ? '標準' : p + '倍'));
      box.appendChild(b);
    });
  }
  function updateLensUI() {
    var box = $('cam-lens');
    var show = lensVisible();
    box.hidden = !show;
    if (!show) return;
    var ps = cam.ctl.presets, active = ps[0];
    for (var i = 0; i < ps.length; i++) if (cam.zoom >= ps[i] - 0.001) active = ps[i];
    Array.prototype.forEach.call(box.children, function (b) {
      var p = parseFloat(b.getAttribute('data-zoom'));
      var on = p === active;
      b.classList.toggle('is-on', on);
      b.textContent = on ? fmtZoom(cam.zoom) + '×' : shortZoom(p);
    });
  }

  // 「.5 / 1× / 2」の並び：タップで切り替え、なぞるとなめらかに変わる
  (function () {
    var box = $('cam-lens'), d = null;
    box.addEventListener('pointerdown', function (e) {
      if (e.button || cam.recording || !cam.ctl) return;
      e.preventDefault();
      d = { pid: e.pointerId, x: e.clientX, y: e.clientY, z0: cam.zoom, moved: false, btn: e.target.closest ? e.target.closest('button') : null };
      try { box.setPointerCapture(e.pointerId); } catch (err) {}
    });
    box.addEventListener('pointermove', function (e) {
      if (!d || e.pointerId !== d.pid) return;
      var vertical = getComputedStyle(box).flexDirection.indexOf('column') === 0;
      var delta = vertical ? d.y - e.clientY : e.clientX - d.x;
      if (Math.abs(delta) > 8) d.moved = true;
      if (d.moved) setZoom(d.z0 * Math.pow(2, delta / 110), true);
    });
    function end(e) {
      if (!d || e.pointerId !== d.pid) return;
      var cur_ = d;
      d = null;
      if (e.type === 'pointerup' && !cur_.moved && cur_.btn) setZoom(parseFloat(cur_.btn.getAttribute('data-zoom')), false);
    }
    box.addEventListener('pointerup', end);
    box.addEventListener('pointercancel', end);
  })();

  // プレビューを2本指でつまんで拡大・縮小
  (function () {
    var el = document.querySelector('.cam-stage'), pinch = null;
    function dist(t) { return Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY); }
    el.addEventListener('touchstart', function (e) {
      if (e.touches.length === 2 && cam.ctl && !cam.recording && lensVisible()) {
        pinch = { d0: Math.max(10, dist(e.touches)), z0: cam.zoom };
        e.preventDefault();
      }
    }, { passive: false });
    el.addEventListener('touchmove', function (e) {
      if (!pinch || e.touches.length !== 2) return;
      e.preventDefault();
      setZoom(pinch.z0 * dist(e.touches) / pinch.d0, true);
    }, { passive: false });
    var pinchedAt = 0;
    function end(e) { if (e.touches.length < 2) { if (pinch) pinchedAt = Date.now(); pinch = null; } }
    el.addEventListener('touchend', end);
    el.addEventListener('touchcancel', end);
    // 1本指のタップ：その位置にピントを合わせる（つまむ操作の直後は無視する）
    el.addEventListener('click', function (e) {
      if (Date.now() - pinchedAt < 400) return;
      focusAt(e.clientX, e.clientY);
    });
  })();

  /* ---------- タップでピント合わせ ----------
     プレビューをタップした位置にピント（と明るさ）を合わせる。
     ブラウザのカメラ機能が「位置を指定したピント合わせ」に対応している端末でだけ働く。
     対応していない端末では、カメラの自動ピントのままになる（その旨を一度だけ案内する）。 */
  var focusNoticeShown = false, focusTimer = 0;
  function pickMode(list) {
    if (!list || !list.indexOf) return null;
    if (list.indexOf('single-shot') >= 0) return 'single-shot';
    if (list.indexOf('continuous') >= 0) return 'continuous';
    return null;
  }
  function setupFocus(track) {
    cam.focus = null;
    $('cam-focus').hidden = true;
    var caps = {}, sup = {};
    try { caps = track && track.getCapabilities ? track.getCapabilities() : {}; } catch (e) {}
    try { sup = navigator.mediaDevices.getSupportedConstraints ? navigator.mediaDevices.getSupportedConstraints() : {}; } catch (e) {}
    var mode = pickMode(caps.focusMode);
    cam.focusInfo = { modes: caps.focusMode ? Array.prototype.slice.call(caps.focusMode) : null, poi: !!sup.pointsOfInterest };
    if (track && sup.pointsOfInterest && mode) cam.focus = { track: track, mode: mode, exposure: pickMode(caps.exposureMode) };
  }
  // プレビュー上の位置（画面の座標）を、映像に対する割合（0〜1）に直す。映像の外なら null
  function camPoint(clientX, clientY) {
    var vw = camVideo.videoWidth, vh = camVideo.videoHeight;
    if (!vw || !vh) return null;
    var r = camVideo.getBoundingClientRect();
    var s = Math.min(r.width / vw, r.height / vh);
    var w = vw * s, h = vh * s;
    var centered = getComputedStyle(camVideo).objectPosition.indexOf('50% 50%') === 0;
    var left = r.left + (r.width - w) / 2, top = centered ? r.top + (r.height - h) / 2 : r.top;
    var x = (clientX - left) / w, y = (clientY - top) / h;
    if (x < 0 || x > 1 || y < 0 || y > 1) return null;
    return { x: x, y: y };
  }
  function focusAt(clientX, clientY) {
    if (currentScreen !== 'camera' || !cam.stream || !$('cam-msg').hidden) return;
    var p = camPoint(clientX, clientY);
    if (!p) return;
    if (!cam.focus) {
      if (!focusNoticeShown) {
        focusNoticeShown = true;
        toast('この端末のブラウザは、タップでのピント合わせに対応していません。\nピントはカメラが自動で合わせます。', 4200);
      }
      return;
    }
    var set = { pointsOfInterest: [{ x: p.x, y: p.y }], focusMode: cam.focus.mode };
    if (cam.focus.exposure) set.exposureMode = cam.focus.exposure;
    var box = $('cam-focus'), sr = document.querySelector('.cam-stage').getBoundingClientRect();
    box.style.left = (clientX - sr.left) + 'px';
    box.style.top = (clientY - sr.top) + 'px';
    box.hidden = false;
    clearTimeout(focusTimer);
    focusTimer = setTimeout(function () { box.hidden = true; }, 1400);
    var pr;
    try { pr = cam.focus.track.applyConstraints({ advanced: [set] }); } catch (e) { pr = Promise.reject(e); }
    Promise.resolve(pr).catch(function () {
      box.hidden = true;
      toast('ピントを合わせられませんでした');
    });
  }

  function showCamError(err) {
    var name = err && err.name || '';
    var title = 'カメラを起動できませんでした', text;
    if (isPermissionError(err)) {
      title = 'カメラの使用が許可されていません';
      text = 'iPhoneの「設定」でSafariの「カメラ」を「許可」または「確認」にしてから、もう一度お試しください。';
    } else if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
      text = '使用できるカメラが見つかりませんでした。';
    } else if (name === 'NotReadableError' || name === 'TrackStartError' || name === 'TrackEnded') {
      text = 'ほかのアプリがカメラを使用中か、カメラが停止されました。';
    } else {
      text = '原因を特定できませんでした。' + (name ? '（' + name + '）' : '');
    }
    cam.failed = true;
    $('cam-rec').disabled = true;
    $('cam-quality').textContent = '';
    fillMsg($('cam-msg'), {
      title: title,
      text: text,
      buttons: [
        { label: 'もう一度試す', primary: true, onClick: startStream },
        { label: 'iPhoneのカメラで撮影（画質は下がります）', onClick: useSystemCamera }
      ]
    });
  }

  function pickRecMime() {
    var list = ['video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
    if (!MediaRecorder.isTypeSupported) return '';
    for (var i = 0; i < list.length; i++) {
      try { if (MediaRecorder.isTypeSupported(list[i])) return list[i]; } catch (e) {}
    }
    return '';
  }

  function setRecUI(on) {
    $('screen-camera').classList.toggle('is-rec', on);
    $('cam-timer').hidden = !on;
    $('cam-rec').setAttribute('aria-label', on ? '録画停止' : '録画開始');
    if (on) $('cam-time').textContent = '0:00';
  }

  function startRec() {
    if (!cam.stream || cam.recording) return;
    var mime = pickRecMime();
    var opts = { videoBitsPerSecond: cam.fpsMode === 60 ? 20000000 : 14000000 };
    if (mime) opts.mimeType = mime;
    var rec;
    try { rec = new MediaRecorder(cam.stream, opts); }
    catch (e) {
      try { rec = new MediaRecorder(cam.stream); }
      catch (e2) { toast('録画を開始できませんでした'); return; }
    }
    cam.rec = rec;
    cam.chunks = [];
    cam.discard = false;
    rec.ondataavailable = function (e) { if (e.data && e.data.size) cam.chunks.push(e.data); };
    rec.onerror = function () { cam.discard = true; stopRec(); toast('録画中にエラーが発生しました'); };
    rec.onstop = function () { finishRec(rec, mime); };
    try { rec.start(1000); }
    catch (e) { cam.rec = null; toast('録画を開始できませんでした'); return; }
    cam.recording = true;
    cam.t0 = performance.now();
    setRecUI(true);
    clearInterval(cam.timer);
    cam.timer = setInterval(function () {
      var sec = Math.floor((performance.now() - cam.t0) / 1000);
      $('cam-time').textContent = Math.floor(sec / 60) + ':' + pad2(sec % 60);
      if (sec >= CAM_MAX_SEC) { stopRec(); toast('録画は' + CAM_MAX_SEC + '秒までです。自動で停止しました', 3600); }
    }, 250);
  }

  function stopRec() {
    if (!cam.recording) return;
    cam.recording = false;
    clearInterval(cam.timer);
    cam.timer = 0;
    setRecUI(false);
    try { if (cam.rec && cam.rec.state !== 'inactive') cam.rec.stop(); } catch (e) {}
  }

  function finishRec(rec, mime) {
    var secs = (performance.now() - cam.t0) / 1000;
    var type = (rec.mimeType || mime || 'video/mp4').split(';')[0] || 'video/mp4';
    var blob = new Blob(cam.chunks, { type: type });
    cam.chunks = [];
    cam.rec = null;
    if (cam.discard) { cam.discard = false; return; }
    if (currentScreen !== 'camera') return;
    if (!blob.size || secs < 0.5) { toast('録画が短すぎます。もう一度撮影してください'); return; }
    closeCamera();
    openVideo({
      blob: blob,
      kind: 'my',
      from: 'capture',
      meta: {
        title: '', date: todayStr(), club: 'ドライバー', dir: captureDir, memo: '', fav: false,
        fps: 'auto', fileName: 'camera-' + Date.now(), recDuration: secs
      }
    });
  }

  /* ==========================================================
     一覧（マイスイング / お気に入り / お手本動画）
     ========================================================== */
  var listState = { kind: 'my', club: '', dir: '', fav: false };
  var LIST_TITLE = { my: 'マイスイング', fav: 'お気に入り', model: 'お手本動画' };
  var LIST_EMPTY = {
    my: '保存した動画はまだありません。\n「撮影する」から動画を取り込んで保存してください。',
    fav: 'お気に入りはまだありません。\n動画分析画面の ★ を押すと登録できます。',
    model: 'お手本動画はまだありません。\n右上の「＋ 追加」から登録してください。'
  };

  function openList(kind) {
    listState = { kind: kind, club: '', dir: '', fav: false };
    $('list-title').textContent = LIST_TITLE[kind];
    $('list-add').hidden = kind !== 'model';
    $('list-spacer').hidden = kind === 'model';
    $('f-fav').hidden = kind !== 'my';
    $('f-club').value = '';
    $('f-dir').value = '';
    $('f-fav').setAttribute('aria-pressed', 'false');
    $('list-grid').textContent = '';
    show('list');
    return renderList();
  }

  function renderList() {
    return dbAll('items').then(function (items) {
      var st = listState;
      var hasAny = false;
      var rows = items.filter(function (i) {
        if (st.kind === 'fav') { if (!i.fav) return false; }
        else if (i.kind !== st.kind) return false;
        hasAny = true;
        if (st.club && i.club !== st.club) return false;
        if (st.dir && i.dir !== st.dir) return false;
        if (st.fav && !i.fav) return false;
        return true;
      });
      rows.sort(function (a, b) {
        var da = a.date || '', db = b.date || '';
        if (da !== db) return da < db ? 1 : -1;
        return (b.createdAt || 0) - (a.createdAt || 0);
      });
      var grid = $('list-grid');
      grid.textContent = '';
      rows.forEach(function (i) { grid.appendChild(buildCard(i)); });
      var empty = $('list-empty');
      empty.hidden = rows.length > 0;
      empty.textContent = hasAny ? '条件に合う動画がありません。' : LIST_EMPTY[st.kind];
    }).catch(function (err) {
      $('list-empty').hidden = false;
      $('list-empty').textContent = '一覧を読み込めませんでした。\n' + (err && err.message ? err.message : '');
    });
  }

  function buildCard(item) {
    var card = document.createElement('div');
    card.className = 'card';
    card.setAttribute('data-id', item.id);

    var open = document.createElement('button');
    open.className = 'card-open';
    open.setAttribute('aria-label', (item.title || '動画') + ' を開く');

    var thumb = document.createElement('div');
    thumb.className = 'card-thumb';
    if (item.thumb) thumb.style.backgroundImage = 'url(' + item.thumb + ')';
    else thumb.classList.add('no-thumb');

    var dir = document.createElement('span');
    dir.className = 'badge';
    dir.textContent = item.dir || '';
    thumb.appendChild(dir);
    if (item.kind === 'model') {
      var mb = document.createElement('span');
      mb.className = 'badge model';
      mb.textContent = 'お手本';
      thumb.appendChild(mb);
    }
    if (item.fav) {
      var star = document.createElement('span');
      star.className = 'card-star';
      star.textContent = '★';
      thumb.appendChild(star);
    }
    open.appendChild(thumb);

    var body = document.createElement('div');
    body.className = 'card-body';
    var t = document.createElement('div');
    t.className = 'card-title';
    t.textContent = item.title || '（無題）';
    var m = document.createElement('div');
    m.className = 'card-meta';
    m.textContent = [item.kind === 'model' ? '' : fmtDate(item.date), item.club].filter(Boolean).join(' ・ ');
    body.appendChild(t);
    body.appendChild(m);
    open.appendChild(body);
    open.addEventListener('click', function () { openSaved(item.id, 'list'); });
    card.appendChild(open);

    var del = document.createElement('button');
    del.className = 'card-del';
    del.setAttribute('aria-label', '削除');
    del.innerHTML = '<svg viewBox="0 0 24 24"><path d="M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13"/></svg>';
    del.addEventListener('click', function () {
      ask('動画を削除しますか？', '「' + (item.title || '無題') + '」をアプリから削除します。\n補助線も一緒に削除され、元に戻せません。', [
        { label: 'キャンセル', value: 0 },
        { label: '削除する', value: 1, kind: 'danger' }
      ]).then(function (ok) {
        if (!ok) return;
        return dbTx(['items', 'videos', 'drawings'], 'readwrite', function (tx) {
          tx.objectStore('items').delete(item.id);
          tx.objectStore('videos').delete(item.id);
          tx.objectStore('drawings').delete(item.id);
        }).then(function () {
          toast('削除しました');
          return renderList();
        }).catch(function () { toast('削除できませんでした'); });
      });
    });
    card.appendChild(del);
    return card;
  }

  function openSaved(id, from) {
    busy(true, '動画を開いています…');
    Promise.all([dbGet('items', id), dbGet('videos', id), dbGet('drawings', id)]).then(function (r) {
      busy(false);
      var item = r[0], vid = r[1], drw = r[2];
      if (!item || !vid || !(vid.blob || vid.buf)) {
        ask('動画データが見つかりません', 'iOSによってアプリ内のデータが削除された可能性があります。元の動画を取り込み直してください。', [{ label: 'OK', value: 1, kind: 'primary' }]);
        return;
      }
      var type = vid.type || 'video/mp4';
      var blob = new Blob([vid.blob || vid.buf], { type: type });
      openVideo({
        blob: blob,
        kind: item.kind,
        from: from,
        id: id,
        meta: item,
        shapes: drw && Array.isArray(drw.shapes) ? drw.shapes : []
      });
    }).catch(function (err) {
      busy(false);
      ask('動画を開けませんでした', String(err && err.message || err || ''), [{ label: 'OK', value: 1, kind: 'primary' }]);
    });
  }

  /* ==========================================================
     動画分析
     ========================================================== */
  var video = $('video');
  var overlay = $('overlay');
  var stage = $('stage');
  var frame = $('frame');
  var screenAn = $('screen-analyze');
  var SVGNS = 'http://www.w3.org/2000/svg';

  var cur = null;        // 開いている動画の状態
  var tokenSeq = 0;      // 読み込みのやり直しを判別する番号

  function waitMeta(v, ms) {
    return new Promise(function (resolve, reject) {
      if (v.readyState >= 1) { resolve(); return; }
      var timer = setTimeout(function () { done(new Error('timeout')); }, ms);
      function done(err) {
        clearTimeout(timer);
        v.removeEventListener('loadedmetadata', ok);
        v.removeEventListener('error', ng);
        if (err) reject(err); else resolve();
      }
      function ok() { done(); }
      function ng() { done(new Error('error')); }
      v.addEventListener('loadedmetadata', ok);
      v.addEventListener('error', ng);
    });
  }

  function stageMsg(opts) { fillMsg($('stage-msg'), opts); }
  // opts: {spinner, title, text, button, onButton, buttons:[{label, onClick, primary}]}
  function fillMsg(el, opts) {
    el.textContent = '';
    if (!opts) { el.hidden = true; return; }
    if (opts.spinner) {
      var sp = document.createElement('div');
      sp.className = 'spinner';
      el.appendChild(sp);
    }
    if (opts.title) {
      var b = document.createElement('b');
      b.textContent = opts.title;
      el.appendChild(b);
    }
    if (opts.text) {
      var s = document.createElement('span');
      s.textContent = opts.text;
      el.appendChild(s);
    }
    var list = opts.buttons ? opts.buttons.slice() : [];
    if (opts.button) list.push({ label: opts.button, onClick: opts.onButton });
    list.forEach(function (bt) {
      var btn = document.createElement('button');
      btn.textContent = bt.label;
      if (bt.primary) btn.className = 'is-primary';
      btn.addEventListener('click', bt.onClick);
      el.appendChild(btn);
    });
    el.hidden = false;
  }

  // 録画したての動画などで長さが取得できない場合に、末尾までシークして長さを確定させる
  function ensureDuration(v) {
    if (isFinite(v.duration) && v.duration > 0) return Promise.resolve();
    return new Promise(function (resolve) {
      var done = false;
      var timer = setTimeout(finish, 4000);
      function ok() { return isFinite(v.duration) && v.duration > 0; }
      function finish() {
        if (done) return;
        done = true;
        clearTimeout(timer);
        v.removeEventListener('durationchange', check);
        v.removeEventListener('seeked', check);
        resolve();
      }
      function check() { if (ok()) finish(); }
      v.addEventListener('durationchange', check);
      v.addEventListener('seeked', check);
      try { v.currentTime = 1e7; } catch (e) { finish(); }
    });
  }
  function seekStart(v) {
    return new Promise(function (resolve) {
      if (v.currentTime === 0 && !v.seeking) { resolve(); return; }
      var timer = setTimeout(fin, 3000);
      function fin() { clearTimeout(timer); v.removeEventListener('seeked', fin); resolve(); }
      v.addEventListener('seeked', fin);
      try { v.currentTime = 0; } catch (e) { fin(); }
    });
  }

  function openVideo(opts) {
    if (cur) closeVideo();
    var token = ++tokenSeq;
    var meta = {};
    Object.keys(opts.meta || {}).forEach(function (k) { meta[k] = opts.meta[k]; });
    if (!meta.fps) meta.fps = 'auto';
    cur = {
      token: token,
      id: opts.id || null,
      saved: !!opts.id,
      kind: opts.kind || 'my',
      from: opts.from || 'home',
      blob: opts.blob,
      url: URL.createObjectURL(opts.blob),
      meta: meta,
      shapes: (opts.shapes || []).map(normalizeShape),
      history: [],
      selected: null,
      mode: 'play',
      tool: null,
      pending: null,
      swayCount: 0,
      hidden: false,
      color: COLORS[0][1],
      width: 2,
      extend: false,
      rate: 1,
      estFps: meta.estFps || 0,
      duration: 0,
      fw: 0, fh: 0,
      ready: false,
      priming: false,
      fpPromise: null,
      rateWarned: {}
    };
    cur.fpPromise = cur.saved ? Promise.resolve(meta.fp) : fingerprint(opts.blob, meta.fileName);

    show('analyze');
    screenAn.classList.remove('panels-hidden', 'is-playing', 'is-draw');
    showStyleRow(false);
    updateHeader();
    updateToolsUI();
    updateSpeedUI();
    updateFpsChip();
    updateTimeUI(0);
    renderShapes();
    stageMsg({ spinner: true, text: '動画を読み込み中…' });

    video.muted = true;
    video.src = cur.url;
    video.load();

    return waitMeta(video, 30000).then(function () {
      if (!cur || cur.token !== token) return;
      if (!video.videoWidth || !video.videoHeight) throw new Error('no-video-track');
      cur.priming = true;
      return ensureDuration(video).then(function () { return seekStart(video); });
    }).then(function () {
      if (!cur || cur.token !== token) return;
      cur.duration = isFinite(video.duration) && video.duration > 0 ? video.duration : (cur.meta.recDuration || 0);
      cur.meta.w = video.videoWidth;
      cur.meta.h = video.videoHeight;
      cur.meta.duration = cur.duration;
      fitFrame();
      // iOS では一度再生しないと最初のコマが表示されないことがあるため、一瞬だけ再生して止める
      cur.priming = true;
      var p;
      try { p = video.play(); } catch (e) { p = null; }
      return Promise.resolve(p).catch(function () {}).then(function () {
        if (!cur || cur.token !== token) return;
        video.pause();
        cur.priming = false;
        try { video.currentTime = 0; } catch (e) {}
        applyRate();
        cur.ready = true;
        screenAn.classList.remove('is-playing');
        updateTimeUI(0);
        stageMsg(null);
        probeFps(cur.url, token);
      });
    }).catch(function () {
      if (!cur || cur.token !== token) return;
      showVideoError();
    });
  }

  function showVideoError() {
    if (!cur) return;
    cur.ready = false;
    stageMsg({
      title: 'この動画は再生できません',
      text: 'Safariで再生できない形式か、ファイルが壊れている可能性があります。\niPhone標準の「カメラ」アプリで撮影した動画（MOV / MP4）をお試しください。',
      button: '戻る',
      onButton: function () { closeVideo(true); }
    });
  }

  function closeVideo(navigate) {
    if (!cur) return;
    flushDrawings();
    var from = cur.from;
    var url = cur.url;
    cur = null;
    tokenSeq++;
    try { video.pause(); } catch (e) {}
    video.removeAttribute('src');
    try { video.load(); } catch (e) {}
    setTimeout(function () { URL.revokeObjectURL(url); }, 0);
    screenAn.classList.remove('is-playing', 'is-draw', 'panels-hidden');
    $('draw-hint').hidden = true;
    stageMsg(null);
    overlay.textContent = '';
    if (navigate) {
      if (from === 'list') { show('list'); renderList(); }
      else show(from || 'home');
    }
  }

  function requestBack() {
    if (!cur) { show('home'); return; }
    if (cur.saved || !cur.ready) { closeVideo(true); return; }
    ask('保存していません', 'この動画はまだアプリに保存されていません。', [
      { label: '保存する', value: 'save', kind: 'primary' },
      { label: '保存せず戻る', value: 'leave' },
      { label: 'キャンセル', value: '' }
    ]).then(function (v) {
      if (v === 'save') openSaveSheet();
      else if (v === 'leave') closeVideo(true);
    });
  }

  // 分析画面から、同じ撮影方向のまま次の動画を撮影する
  function shootNext() {
    if (!cur) return;
    function go() {
      if (cur && cur.meta.dir && DIR_HINT[cur.meta.dir]) {
        captureDir = cur.meta.dir;
        setSeg($('cap-dir'), captureDir);
        $('cap-dir-hint').textContent = DIR_HINT[captureDir];
      }
      closeVideo(false);
      show('capture');   // カメラ画面の「戻る」で戻る先
      openCamera();
    }
    if (cur.saved || !cur.ready) { go(); return; }
    ask('保存していません', 'この動画はまだアプリに保存されていません。', [
      { label: '保存する', value: 'save', kind: 'primary' },
      { label: '保存せず撮影', value: 'go' },
      { label: 'キャンセル', value: '' }
    ]).then(function (v) {
      if (v === 'save') openSaveSheet();
      else if (v === 'go') go();
    });
  }

  function updateHeader() {
    if (!cur) return;
    var title = cur.saved ? (cur.meta.title || '（無題）') : (cur.kind === 'model' ? '未登録のお手本動画' : '未保存の動画');
    $('an-title').textContent = title + (cur.meta.dir ? '　' + cur.meta.dir : '');
    $('an-fav').setAttribute('aria-pressed', cur.meta.fav ? 'true' : 'false');
    var sb = $('an-save');
    sb.textContent = cur.saved ? '編集' : (cur.kind === 'model' ? '登録' : '保存');
    sb.classList.toggle('is-saved', cur.saved);
  }

  /* ---------- 映像領域の計算 ----------
     動画の実際の映像部分だけを .frame にぴったり合わせ、
     補助線は映像に対する割合（0〜1）で保存する。 */
  function fitFrame() {
    if (!cur) return;
    var sw = stage.clientWidth, sh = stage.clientHeight;
    var vw = video.videoWidth || cur.meta.w, vh = video.videoHeight || cur.meta.h;
    if (!sw || !sh || !vw || !vh) return;
    // 縦画面では上の表示と下の操作パネルを動画に重ねる。再生モードでも描画モードでも同じ大きさで表示する。
    var ov = overlayInsets();
    var s = Math.min(sw / vw, sh / vh);
    var w = Math.max(1, Math.round(vw * s)), h = Math.max(1, Math.round(vh * s));
    var top;
    if (!ov) top = (sh - h) / 2;
    else {
      var free = sh - ov.top - ov.bottom;
      // 間に収まるなら間の中央に、収まらないなら上に寄せて下のパネルに隠れる部分を減らす
      top = h <= free ? ov.top + (free - h) / 2 : Math.max(0, sh - ov.bottom - h);
    }
    frame.style.width = w + 'px';
    frame.style.height = h + 'px';
    frame.style.left = Math.round((sw - w) / 2) + 'px';
    frame.style.top = Math.round(top) + 'px';
    cur.fw = w;
    cur.fh = h;
    overlay.setAttribute('viewBox', '0 0 ' + w + ' ' + h);
    renderShapes();
  }

  // 縦画面では上の表示と下の操作パネルを動画に重ねている。その重なりの高さを返す（横画面では null）。
  var overlayTop = 0, overlayBottom = 0;
  function overlayInsets() {
    if (getComputedStyle(stage).position !== 'absolute') return null;
    var sr = stage.getBoundingClientRect();
    var tr = document.querySelector('.an-top').getBoundingClientRect();
    var cr = $('an-controls').getBoundingClientRect();
    // パネルを隠しているときは、最後に測った高さを使う（表示切り替えで動画が動かないように）
    if (tr.height > 0) overlayTop = Math.max(0, tr.bottom - sr.top - 16);
    if (cr.height > 0) overlayBottom = Math.max(0, sr.bottom - cr.top);
    return { top: overlayTop, bottom: overlayBottom };
  }

  /* ---------- 再生・シーク ---------- */
  var seekWant = null;
  function seekTo(t) {
    if (!cur || !cur.ready) return;
    t = clamp(t, 0, cur.duration || 0);
    // 前のシークが終わっていなければ、最後の指定だけを覚えておき、終わったときに移動する。
    // シーク完了の通知が来ない場合に備えて、一定時間たったら待たずに移動する。
    if (video.seeking && performance.now() - seekStartedAt < 600) {
      seekWant = t;
      clearTimeout(seekTimer);
      seekTimer = setTimeout(flushSeek, 650);
    } else {
      seekWant = null;
      setVideoTime(t);
    }
    updateTimeUI(t);
  }
  var seekStartedAt = 0, seekTimer = 0;
  function setVideoTime(t) {
    shownFresh = false;   // これ以降に表示の通知が来るまで、表示中のコマの時刻は当てにしない
    seekStartedAt = performance.now();
    try { video.currentTime = t; } catch (e) {}
  }
  function flushSeek() {
    clearTimeout(seekTimer);
    if (seekWant == null || !cur) return;
    var t = seekWant;
    seekWant = null;
    if (Math.abs(video.currentTime - t) > 0.0005) setVideoTime(t);
  }
  video.addEventListener('seeked', flushSeek);

  function updateTimeUI(t) {
    var d = cur ? cur.duration : 0;
    var r = d > 0 ? clamp(t / d, 0, 1) : 0;
    $('seek').style.setProperty('--r', r.toFixed(5));
    $('seek').setAttribute('aria-valuenow', Math.round(r * 100));
    $('time').textContent = fmtTime(t) + ' / ' + fmtTime(d);
  }

  var rafId = 0;
  var rateCheck = null;
  function tick() {
    rafId = 0;
    if (!cur || video.paused) return;
    if (!seekDragging) updateTimeUI(video.currentTime);
    checkActualRate();
    rafId = requestAnimationFrame(tick);
  }
  // 指定した速度で実際に再生されているかを確認し、速すぎる場合は案内する
  function checkActualRate() {
    if (!cur || cur.rate >= 1 || video.seeking) { rateCheck = null; return; }
    var now = performance.now();
    if (!rateCheck) { rateCheck = { t0: now, m0: video.currentTime, rate: cur.rate }; return; }
    if (rateCheck.rate !== cur.rate) { rateCheck = null; return; }
    var dt = (now - rateCheck.t0) / 1000;
    if (dt < 1.6) return;
    var actual = (video.currentTime - rateCheck.m0) / dt;
    rateCheck = null;
    if (actual > cur.rate * 1.6 && !cur.rateWarned[cur.rate]) {
      cur.rateWarned[cur.rate] = true;
      toast('この動画・端末では ' + cur.rate + '倍の速度で再生できていない可能性があります。', 4200);
    }
  }

  video.addEventListener('play', function () {
    if (!cur || cur.priming) return;
    applyRate();
    screenAn.classList.add('is-playing');
    rateCheck = null;
    if (!rafId) rafId = requestAnimationFrame(tick);
  });
  video.addEventListener('pause', function () {
    if (!cur || cur.priming) return;
    screenAn.classList.remove('is-playing');
    rateCheck = null;
    if (cur.ready && !seekDragging && seekWant == null) updateTimeUI(video.currentTime);
  });
  video.addEventListener('seeking', function () { rateCheck = null; fpsLast = null; shownFresh = false; });
  video.addEventListener('durationchange', function () {
    if (cur && isFinite(video.duration) && video.duration > 0) {
      cur.duration = video.duration;
      updateTimeUI(video.currentTime);
    }
  });
  video.addEventListener('error', function () {
    if (cur && cur.ready) showVideoError();
  });

  function togglePlay() {
    if (!cur || !cur.ready) return;
    if (!video.paused) { video.pause(); return; }
    if (cur.mode === 'draw') setMode('play');
    seekWant = null;
    if (cur.duration && video.currentTime >= cur.duration - 0.03) {
      try { video.currentTime = 0; } catch (e) {}
    }
    applyRate();
    var p = video.play();
    if (p && p.catch) p.catch(function () { toast('再生を開始できませんでした'); });
  }

  /* ---------- 再生速度 ---------- */
  function applyRate() {
    if (!cur) return;
    try {
      if (video.playbackRate !== cur.rate) video.playbackRate = cur.rate;
    } catch (e) {}
  }
  function setRate(r) {
    if (!cur) return;
    var ok = true;
    try {
      video.playbackRate = r;
      video.defaultPlaybackRate = r;
    } catch (e) { ok = false; }
    var actual = video.playbackRate;
    if (!ok || Math.abs(actual - r) > 0.001) {
      toast('このブラウザは ' + r + '倍の再生に対応していません。\n' + actual + '倍のまま再生します。', 4200);
      cur.rate = actual;
    } else {
      cur.rate = r;
    }
    rateCheck = null;
    updateSpeedUI();
  }
  function updateSpeedUI() {
    var r = cur ? cur.rate : 1;
    Array.prototype.forEach.call($('speeds').children, function (b) {
      b.classList.toggle('is-on', Math.abs(Number(b.getAttribute('data-rate')) - r) < 0.001);
    });
  }

  /* ---------- コマ送り ----------
     ブラウザでは正確なコマ位置を取得できないため、
     「1コマ分の時間（1/fps秒）」だけ進める近似の動作。
     fps は再生時のフレーム情報から推定するか、手動で選択する。 */
  function currentFps() {
    if (!cur) return DEFAULT_FPS;
    var f = cur.meta.fps;
    if (f && f !== 'auto') return Number(f);
    return cur.estFps || DEFAULT_FPS;
  }
  function stepFrame(dir) {
    if (!cur || !cur.ready) return;
    if (!video.paused) video.pause();
    var f = currentFps(), d = cur.duration || 0;
    var pending = seekWant != null || video.seeking;
    var base = seekWant != null ? seekWant : video.currentTime;
    // 基本：今の時刻が入っているコマの、1つ先（前）のコマの中央へ移動する。
    // 必ず今の時刻から半コマ分以上は動くので、同じ位置に止まり続けることがない。
    var n = Math.floor(base * f + 0.001);
    var t = (n + dir + 0.5) / f;
    // 表示中のコマの開始時刻が確かに分かっているときは、そのコマを確実に越える位置にする
    // （再生を止めた直後など、時刻と表示が1コマずれている場合の空振りを防ぐ）
    if (!pending && shownFresh && shownTime != null && Math.abs(shownTime - base) < 2 / f) {
      if (dir > 0) t = Math.max(t, shownTime + 1.5 / f);
      else t = Math.min(t, shownTime - 0.5 / f);
    }
    seekTo(clamp(t, 0, d));
  }
  function bindHold(btn, dir) {
    var timer = 0, iv = 0;
    function stop() {
      clearTimeout(timer); clearInterval(iv);
      timer = 0; iv = 0;
      btn.classList.remove('is-held');
    }
    var lastDown = 0;
    btn.addEventListener('pointerdown', function (e) {
      if (e.button) return;
      e.preventDefault();
      stop();
      lastDown = Date.now();
      btn.classList.add('is-held');
      stepFrame(dir);
      timer = setTimeout(function () {
        iv = setInterval(function () { stepFrame(dir); }, 110);
      }, 420);
    });
    ['pointerup', 'pointercancel', 'pointerleave'].forEach(function (ev) {
      btn.addEventListener(ev, stop);
    });
    // 押したことがポインターイベントで届かなかった場合だけ、クリックで1コマ送る
    btn.addEventListener('click', function () {
      if (Date.now() - lastDown > 1500) stepFrame(dir);
    });
    btn.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    btn.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); stepFrame(dir); }
    });
  }

  function fpsFromDeltas(ds) {
    if (ds.length < 5) return 0;
    var s = ds.slice().sort(function (a, b) { return a - b; });
    var d = s[Math.floor(s.length * 0.2)];
    if (!(d > 0)) return 0;
    var raw = 1 / d;
    for (var i = 0; i < FPS_SNAP.length; i++) {
      if (Math.abs(raw - FPS_SNAP[i]) / FPS_SNAP[i] < 0.05) return FPS_SNAP[i];
    }
    return clamp(Math.round(raw), 1, 480);
  }
  function applyEstFps(f) {
    if (!cur || !f || f <= cur.estFps) return;
    cur.estFps = f;
    updateFpsChip();
    if (cur.saved) {
      cur.meta.estFps = f;
      saveItemMeta();
    }
  }
  // 見えない動画を低速で少しだけ再生し、フレーム間隔から fps を推定する
  function probeFps(url, token) {
    if (!HAS_RVFC) return;
    var v = document.createElement('video');
    v.muted = true;
    v.playsInline = true;
    v.setAttribute('playsinline', '');
    v.setAttribute('webkit-playsinline', '');
    v.preload = 'auto';
    v.style.cssText = 'position:fixed;left:0;top:0;width:2px;height:2px;opacity:0.01;pointer-events:none;z-index:-1';
    var ds = [], last = null, done = false;
    function finish() {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { v.pause(); } catch (e) {}
      v.removeAttribute('src');
      try { v.load(); } catch (e) {}
      if (v.parentNode) v.parentNode.removeChild(v);
      if (cur && cur.token === token) applyEstFps(fpsFromDeltas(ds));
    }
    function onFrame(now, md) {
      if (done) return;
      if (last != null) {
        var d = md.mediaTime - last;
        if (d > 0.0008 && d < 0.25) ds.push(d);
      }
      last = md.mediaTime;
      if (ds.length >= 10) finish();
      else v.requestVideoFrameCallback(onFrame);
    }
    var timer = setTimeout(finish, 5000);
    v.addEventListener('loadedmetadata', function () {
      try { v.playbackRate = 0.25; } catch (e) {}
      var p;
      try { p = v.play(); } catch (e) { finish(); return; }
      if (p && p.then) p.then(function () { try { v.playbackRate = 0.25; } catch (e) {} }).catch(finish);
    });
    v.addEventListener('error', finish);
    v.addEventListener('ended', finish);
    document.body.appendChild(v);
    v.requestVideoFrameCallback(onFrame);
    v.src = url;
    v.load();
  }
  // 画面の動画を再生している間も、フレーム間隔を集めて推定を更新する
  var fpsLast = null, fpsDeltas = [], fpsCount = 0;
  var shownTime = null;    // 最後に画面へ表示されたコマの時刻
  var shownFresh = false;  // shownTime が「いま表示中のコマ」のものだと確かに言えるか
  function mainFrame(now, md) {
    shownTime = md.mediaTime;
    shownFresh = !video.seeking;
    if (cur && cur.ready && !video.paused && !video.seeking) {
      if (fpsLast != null) {
        var d = md.mediaTime - fpsLast;
        if (d > 0.0008 && d < 0.25) {
          fpsDeltas.push(d);
          if (fpsDeltas.length > 40) fpsDeltas.shift();
          if (++fpsCount % 12 === 0) applyEstFps(fpsFromDeltas(fpsDeltas));
        }
      }
      fpsLast = md.mediaTime;
    } else {
      fpsLast = null;
    }
    video.requestVideoFrameCallback(mainFrame);
  }
  if (HAS_RVFC) video.requestVideoFrameCallback(mainFrame);
  video.addEventListener('emptied', function () { fpsLast = null; fpsDeltas = []; fpsCount = 0; shownTime = null; shownFresh = false; });

  function updateFpsChip() {
    var el = $('fps-chip');
    if (!cur) return;
    var f = cur.meta.fps;
    if (f && f !== 'auto') el.textContent = 'コマ送り\n' + f + 'fps（手動）';
    else if (cur.estFps) el.textContent = 'コマ送り\n約' + cur.estFps + 'fps（推定）';
    else el.textContent = 'コマ送り\n' + DEFAULT_FPS + 'fps（仮）';
  }
  function openFpsSheet() {
    if (!cur) return;
    var f = cur.meta.fps || 'auto';
    var desc;
    if (!HAS_RVFC) desc = 'このブラウザでは動画のコマ数を自動で調べられません。動画のフレームレートを選んでください（通常のビデオは30、スロー撮影は120や240）。';
    else if (cur.estFps) desc = 'この動画は約' + cur.estFps + 'fpsと推定しました。動きが合わない場合は、撮影時のフレームレートを手動で選んでください。';
    else desc = 'コマ数をまだ推定できていません（30fpsと仮定しています）。一度再生すると推定されます。分かっている場合は手動で選んでください。';
    $('fps-desc').textContent = desc;
    var box = $('fps-opts');
    box.textContent = '';
    function add(val, label, sub) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = String(f) === String(val) ? 'is-on' : '';
      var s = document.createElement('span');
      s.textContent = label;
      b.appendChild(s);
      if (sub) { var sm = document.createElement('small'); sm.textContent = sub; b.appendChild(sm); }
      b.addEventListener('click', function () {
        cur.meta.fps = val;
        updateFpsChip();
        if (cur.saved) saveItemMeta();
        $('fps-sheet').hidden = true;
      });
      box.appendChild(b);
    }
    add('auto', '自動（推定）', cur.estFps ? '約' + cur.estFps + 'fps' : (HAS_RVFC ? '未推定' : '30fpsと仮定'));
    FPS_CHOICES.forEach(function (n) {
      add(n, n + ' fps', n === 30 ? '通常のビデオ' : n === 60 ? '60fps撮影' : n >= 120 ? 'スロー撮影' : '');
    });
    $('toast').hidden = true;
    $('fps-sheet').hidden = false;
  }

  /* ---------- シークバー ---------- */
  var seekDragging = false;
  (function () {
    var el = $('seek');
    function ratio(e) {
      var r = el.getBoundingClientRect();
      return clamp((e.clientX - r.left - 9) / Math.max(1, r.width - 18), 0, 1);
    }
    el.addEventListener('pointerdown', function (e) {
      if (!cur || !cur.ready || e.button) return;
      e.preventDefault();
      seekDragging = true;
      el.classList.add('is-drag');
      try { el.setPointerCapture(e.pointerId); } catch (err) {}
      if (!video.paused) video.pause();
      seekTo(ratio(e) * cur.duration);
    });
    el.addEventListener('pointermove', function (e) {
      if (!seekDragging || !cur) return;
      seekTo(ratio(e) * cur.duration);
    });
    function end() {
      seekDragging = false;
      el.classList.remove('is-drag');
    }
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
  })();

  /* ==========================================================
     補助線（シャフトライン / スウェーライン / 頭の枠）
     座標はすべて映像に対する割合（0〜1）で保持する。
       line  : {x1,y1,x2,y2,extend}
       vline : {x,y1,y2}
       rect  : {x,y,w,h}
     ========================================================== */
  function svgEl(name, attrs) {
    var e = document.createElementNS(SVGNS, name);
    if (attrs) Object.keys(attrs).forEach(function (k) { e.setAttribute(k, attrs[k]); });
    return e;
  }
  function findShape(id) {
    if (!cur) return null;
    for (var i = 0; i < cur.shapes.length; i++) if (cur.shapes[i].id === id) return cur.shapes[i];
    return null;
  }
  // 保存データを読み込むときの整形。以前のスウェーライン（縦線専用の形式）は、
  // シャフトラインと同じ直線の形式に変えて、同じように動かせるようにする。
  function normalizeShape(src) {
    var s = JSON.parse(JSON.stringify(src));
    if (s.type === 'vline') {
      return { id: s.id, type: 'line', kind: 'sway', x1: s.x, y1: s.y1, x2: s.x, y2: s.y2, extend: false, color: s.color, width: s.width };
    }
    return s;
  }
  function snapshot() { return JSON.stringify(cur.shapes); }
  function pushHistory(snap) {
    cur.history.push(snap || snapshot());
    if (cur.history.length > 60) cur.history.shift();
  }

  var saveTimer = 0;
  function shapesChanged() {
    renderShapes();
    updateToolsUI();
    if (!cur || !cur.saved) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flushDrawings, 350);
  }
  function flushDrawings() {
    clearTimeout(saveTimer);
    saveTimer = 0;
    if (!cur || !cur.saved || !cur.id) return;
    dbPut('drawings', { id: cur.id, shapes: JSON.parse(snapshot()), updatedAt: Date.now() })
      .catch(function () { toast('補助線を保存できませんでした'); });
  }

  function addHandle(g, s, name, x, y) {
    g.appendChild(svgEl('circle', { cx: x, cy: y, r: 13, 'class': 'handle' }));
    g.appendChild(svgEl('circle', { cx: x, cy: y, r: 2.2, 'class': 'handle-dot' }));
    g.appendChild(svgEl('circle', { cx: x, cy: y, r: 24, 'class': 'handle-hit', 'data-id': s.id, 'data-h': name }));
  }

  function renderShapes() {
    overlay.textContent = '';
    if (!cur || !cur.fw) return;
    var w = cur.fw, h = cur.fh;
    var defs = svgEl('defs');
    var cp = svgEl('clipPath', { id: 'ov-clip' });
    cp.appendChild(svgEl('rect', { x: 0, y: 0, width: w, height: h }));
    defs.appendChild(cp);
    overlay.appendChild(defs);
    var g = svgEl('g', { 'clip-path': 'url(#ov-clip)' });
    var hg = svgEl('g');
    overlay.appendChild(g);
    overlay.appendChild(hg);

    if (!cur.hidden) {
      cur.shapes.forEach(function (s) {
        var sel = cur.mode === 'draw' && s.id === cur.selected;
        var sw = s.width || 3.5;
        var x1, y1, x2, y2;
        if (s.type === 'line' || s.type === 'vline') {
          if (s.type === 'line') { x1 = s.x1 * w; y1 = s.y1 * h; x2 = s.x2 * w; y2 = s.y2 * h; }
          else { x1 = x2 = s.x * w; y1 = s.y1 * h; y2 = s.y2 * h; }
          var ax = x1, ay = y1, bx = x2, by = y2;
          if (s.type === 'line' && s.extend) {
            var dx = x2 - x1, dy = y2 - y1;
            var k = (w + h) * 2 / (Math.hypot(dx, dy) || 1);
            ax = x1 - dx * k; ay = y1 - dy * k; bx = x2 + dx * k; by = y2 + dy * k;
          }
          g.appendChild(svgEl('line', { x1: ax, y1: ay, x2: bx, y2: by, 'class': 'shadow', 'stroke-width': sw + 2.5, 'stroke-linecap': 'round' }));
          g.appendChild(svgEl('line', { x1: ax, y1: ay, x2: bx, y2: by, 'class': 'vis', stroke: s.color, 'stroke-width': sw, 'stroke-linecap': 'round', 'data-shape': s.id, 'data-type': s.type }));
          g.appendChild(svgEl('line', { x1: ax, y1: ay, x2: bx, y2: by, 'class': 'hit', 'stroke-width': 32, 'stroke-linecap': 'round', 'data-id': s.id }));
          if (sel) {
            addHandle(hg, s, s.type === 'line' ? 'p1' : 'top', x1, y1);
            addHandle(hg, s, s.type === 'line' ? 'p2' : 'bottom', x2, y2);
          }
        } else if (s.type === 'rect') {
          var rx = s.x * w, ry = s.y * h, rw = s.w * w, rh = s.h * h;
          g.appendChild(svgEl('rect', { x: rx, y: ry, width: rw, height: rh, 'class': 'shadow', 'stroke-width': sw + 2.5 }));
          g.appendChild(svgEl('rect', { x: rx, y: ry, width: rw, height: rh, 'class': 'vis', stroke: s.color, 'stroke-width': sw, 'data-shape': s.id, 'data-type': 'rect' }));
          g.appendChild(svgEl('rect', { x: rx, y: ry, width: rw, height: rh, 'class': 'hit-fill', 'data-id': s.id }));
          g.appendChild(svgEl('rect', { x: rx, y: ry, width: rw, height: rh, 'class': 'hit', 'stroke-width': 28, 'data-id': s.id }));
          if (sel) {
            addHandle(hg, s, 'nw', rx, ry);
            addHandle(hg, s, 'ne', rx + rw, ry);
            addHandle(hg, s, 'sw', rx, ry + rh);
            addHandle(hg, s, 'se', rx + rw, ry + rh);
          }
        }
      });
    }

    // シャフトラインの作成途中の表示
    var p = cur.pending;
    if (p && p.p1) {
      if (p.p2) {
        hg.appendChild(svgEl('line', { x1: p.p1.x * w, y1: p.p1.y * h, x2: p.p2.x * w, y2: p.p2.y * h, 'class': 'pending', stroke: cur.color, 'stroke-dasharray': '6 5', style: 'stroke:' + cur.color }));
        hg.appendChild(svgEl('circle', { cx: p.p2.x * w, cy: p.p2.y * h, r: 9, 'class': 'pending' }));
      }
      hg.appendChild(svgEl('circle', { cx: p.p1.x * w, cy: p.p1.y * h, r: 9, 'class': 'pending' }));
    }
  }

  function updateHint() {
    var el = $('draw-hint');
    var text = '';
    if (cur && cur.mode === 'draw') {
      if (cur.tool === 'line') text = cur.pending && cur.pending.fixed1 ? '② シャフト上の2点目をタップ' : '① シャフト上の1点目をタップ';
      else if (cur.tool === 'sway') text = cur.swayCount === 0 ? '① 左足の外側をタップ' : '② 右足の外側をタップ';
      else if (cur.tool === 'ball') text = 'ボールの位置をタップ';
    }
    el.textContent = text;
    el.hidden = !text;
  }

  function updateToolsUI() {
    if (!cur) return;
    var draw = cur.mode === 'draw';
    screenAn.classList.toggle('is-draw', draw);
    $('tool-mode').setAttribute('aria-pressed', draw ? 'true' : 'false');
    Array.prototype.forEach.call(document.querySelectorAll('#tools-main [data-tool]'), function (b) {
      b.classList.toggle('is-on', draw && cur.tool === b.getAttribute('data-tool'));
    });
    var sel = findShape(cur.selected);
    var ext = sel && sel.type === 'line' ? !!sel.extend : cur.extend;
    $('tool-extend').setAttribute('aria-pressed', ext ? 'true' : 'false');
    $('tool-extend').classList.toggle('is-dim', !!sel && sel.type !== 'line');
    $('tool-delete').classList.toggle('is-dim', !sel);
    $('tool-undo').classList.toggle('is-dim', cur.history.length === 0);
    $('tool-hide').setAttribute('aria-pressed', cur.hidden ? 'true' : 'false');
    $('tool-hide-label').textContent = cur.hidden ? 'すべて表示' : 'すべて非表示';
    $('tool-hide-label').setAttribute('data-short', cur.hidden ? '表示' : '非表示');
    var color = sel ? sel.color : cur.color;
    var width = sel ? (sel.width || 3.5) : cur.width;
    $('style-dot').style.fill = color;
    Array.prototype.forEach.call($('swatches').children, function (b) {
      b.classList.toggle('is-on', b.getAttribute('data-color') === color);
    });
    Array.prototype.forEach.call($('widths').children, function (b) {
      b.classList.toggle('is-on', Math.abs(Number(b.getAttribute('data-w')) - width) < 0.01);
    });
    updateHint();
  }

  function showStyleRow(on) {
    $('tools-style').hidden = !on;
    $('tools-main').hidden = on;
  }

  function setMode(m) {
    if (!cur || cur.mode === m) return;
    cur.mode = m;
    if (m === 'draw') {
      if (!video.paused) video.pause();
    } else {
      cur.tool = null;
      cur.pending = null;
      cur.selected = null;
      showStyleRow(false);
    }
    updateToolsUI();
    renderShapes();
  }

  function chooseTool(tool) {
    if (!cur || !cur.ready) return;
    setMode('draw');
    if (cur.hidden) cur.hidden = false;
    cur.pending = null;
    cur.swayCount = 0;
    if (tool === 'rect') {
      cur.tool = null;
      pushHistory();
      var w = 0.24;
      var h = clamp(w * cur.fw / cur.fh, 0.06, 0.6);
      var s = { id: uid(), type: 'rect', x: 0.5 - w / 2, y: clamp(0.28 - h / 2, 0, 1 - h), w: w, h: h, color: cur.color, width: cur.width };
      cur.shapes.push(s);
      cur.selected = s.id;
      shapesChanged();
      return;
    }
    cur.tool = cur.tool === tool ? null : tool;
    cur.selected = null;
    updateToolsUI();
    renderShapes();
  }

  // 映像のうち、上の表示と下の操作パネルに隠れていない縦の範囲（0〜1）。
  // 新しく引く縦線の上下の丸が、ボタンの下に入って触れなくならないようにするために使う。
  function visibleRangeY() {
    var y1 = 0.03, y2 = 0.97;
    var ov = overlayInsets();
    if (ov && cur && cur.fh) {
      var ft = parseFloat(frame.style.top) || 0;
      var a = Math.max(y1, (ov.top - ft) / cur.fh + 0.02);
      var b = Math.min(y2, (stage.clientHeight - ov.bottom - ft) / cur.fh - 0.03);
      if (b - a >= 0.2) { y1 = a; y2 = b; }
    }
    return [y1, y2];
  }

  function toNorm(e) {
    var r = frame.getBoundingClientRect();
    return {
      x: clamp((e.clientX - r.left) / Math.max(1, r.width), 0, 1),
      y: clamp((e.clientY - r.top) / Math.max(1, r.height), 0, 1)
    };
  }

  var drag = null;
  overlay.addEventListener('pointerdown', function (e) {
    if (!cur || drag || e.button) return;
    if (cur.mode !== 'draw') {
      // 再生モード：引いてある線や枠に触れたら、描画モードに切り替えて、そのまま選んで動かせるようにする。
      // 何もないところのタップは、今までどおり操作パネルの表示切り替えになる。
      var hitId = e.target.getAttribute && e.target.getAttribute('data-id');
      if (!hitId || !cur.ready || cur.hidden || !findShape(hitId)) return;
      setMode('draw');
      screenAn.classList.remove('panels-hidden');
    }
    e.preventDefault();
    e.stopPropagation();
    var p = toNorm(e);
    try { overlay.setPointerCapture(e.pointerId); } catch (err) {}

    if (cur.tool === 'line') {
      if (!cur.pending || !cur.pending.fixed1) {
        cur.pending = { p1: p, fixed1: false };
        drag = { pid: e.pointerId, place: 'p1' };
      } else {
        cur.pending.p2 = p;
        drag = { pid: e.pointerId, place: 'p2' };
      }
      renderShapes();
      return;
    }
    // スウェーライン（2本）とボールライン（1本）：タップした位置に、まっすぐな縦線を引く。
    // 引いたあとはシャフトラインと同じ直線として扱い、端の丸や線の途中をドラッグして動かせる。
    if (cur.tool === 'sway' || cur.tool === 'ball') {
      var before = snapshot();
      var vr = visibleRangeY();
      var v = { id: uid(), type: 'line', kind: cur.tool, x1: p.x, y1: vr[0], x2: p.x, y2: vr[1], extend: false, color: cur.color, width: cur.width };
      cur.shapes.push(v);
      cur.selected = v.id;
      drag = { pid: e.pointerId, place: 'sway', id: v.id, before: before };
      renderShapes();
      return;
    }

    var id = e.target.getAttribute && e.target.getAttribute('data-id');
    var s = id ? findShape(id) : null;
    if (s) {
      cur.selected = id;
      drag = {
        pid: e.pointerId,
        id: id,
        handle: e.target.getAttribute('data-h') || 'body',
        start: p,
        orig: JSON.parse(JSON.stringify(s)),
        before: snapshot(),
        moved: false
      };
    } else {
      cur.selected = null;
    }
    updateToolsUI();
    renderShapes();
  });

  overlay.addEventListener('pointermove', function (e) {
    if (!cur || !drag || e.pointerId !== drag.pid) return;
    e.preventDefault();
    var p = toNorm(e);
    if (drag.place === 'p1') { cur.pending.p1 = p; renderShapes(); return; }
    if (drag.place === 'p2') { cur.pending.p2 = p; renderShapes(); return; }
    if (drag.place === 'sway') {
      var v = findShape(drag.id);
      if (v) { v.x1 = v.x2 = p.x; renderShapes(); }
      return;
    }
    var s = findShape(drag.id);
    if (!s) return;
    var o = drag.orig;
    var dx = p.x - drag.start.x, dy = p.y - drag.start.y;
    if (Math.abs(dx) * cur.fw + Math.abs(dy) * cur.fh > 2) drag.moved = true;
    if (!drag.moved) return;
    var MIN = 0.04;
    if (s.type === 'line') {
      if (drag.handle === 'p1') { s.x1 = clamp(o.x1 + dx, 0, 1); s.y1 = clamp(o.y1 + dy, 0, 1); }
      else if (drag.handle === 'p2') { s.x2 = clamp(o.x2 + dx, 0, 1); s.y2 = clamp(o.y2 + dy, 0, 1); }
      else {
        dx = clamp(dx, -Math.min(o.x1, o.x2), 1 - Math.max(o.x1, o.x2));
        dy = clamp(dy, -Math.min(o.y1, o.y2), 1 - Math.max(o.y1, o.y2));
        s.x1 = o.x1 + dx; s.x2 = o.x2 + dx; s.y1 = o.y1 + dy; s.y2 = o.y2 + dy;
      }
    } else if (s.type === 'vline') {
      if (drag.handle === 'top') s.y1 = clamp(o.y1 + dy, 0, o.y2 - MIN);
      else if (drag.handle === 'bottom') s.y2 = clamp(o.y2 + dy, o.y1 + MIN, 1);
      else {
        s.x = clamp(o.x + dx, 0, 1);
        dy = clamp(dy, -o.y1, 1 - o.y2);
        s.y1 = o.y1 + dy; s.y2 = o.y2 + dy;
      }
    } else if (s.type === 'rect') {
      if (drag.handle === 'body') {
        s.x = clamp(o.x + dx, 0, 1 - o.w);
        s.y = clamp(o.y + dy, 0, 1 - o.h);
      } else {
        var l = o.x, t = o.y, r = o.x + o.w, b = o.y + o.h;
        if (drag.handle.indexOf('w') >= 0) l = clamp(o.x + dx, 0, r - MIN);
        if (drag.handle.indexOf('e') >= 0) r = clamp(o.x + o.w + dx, l + MIN, 1);
        if (drag.handle.indexOf('n') >= 0) t = clamp(o.y + dy, 0, b - MIN);
        if (drag.handle.indexOf('s') >= 0) b = clamp(o.y + o.h + dy, t + MIN, 1);
        s.x = l; s.y = t; s.w = r - l; s.h = b - t;
      }
    }
    renderShapes();
  });

  function endDrag(e) {
    if (!cur || !drag || e.pointerId !== drag.pid) return;
    var d = drag;
    drag = null;
    try { overlay.releasePointerCapture(e.pointerId); } catch (err) {}
    if (e.type === 'pointercancel') {
      if (d.place === 'p1') cur.pending = null;
      else if (d.place === 'p2') cur.pending.p2 = null;
      else if (d.place === 'sway') { cur.shapes = JSON.parse(d.before); cur.selected = null; }
      else if (d.moved) cur.shapes = JSON.parse(d.before);
      updateToolsUI();
      renderShapes();
      return;
    }
    if (d.place === 'p1') {
      cur.pending.fixed1 = true;
      updateToolsUI();
      renderShapes();
      return;
    }
    if (d.place === 'p2') {
      var a = cur.pending.p1, b = cur.pending.p2;
      var dist = Math.hypot((b.x - a.x) * cur.fw, (b.y - a.y) * cur.fh);
      if (dist < 16) {
        cur.pending.p2 = null;
        toast('1点目から少し離れた位置をタップしてください');
        renderShapes();
        return;
      }
      pushHistory();
      var s = { id: uid(), type: 'line', x1: a.x, y1: a.y, x2: b.x, y2: b.y, extend: cur.extend, color: cur.color, width: cur.width };
      cur.shapes.push(s);
      cur.selected = s.id;
      cur.pending = null;
      cur.tool = null;
      shapesChanged();
      return;
    }
    if (d.place === 'sway') {
      pushHistory(d.before);
      if (cur.tool === 'ball') cur.tool = null;
      else {
        cur.swayCount++;
        if (cur.swayCount >= 2) { cur.tool = null; cur.swayCount = 0; }
      }
      shapesChanged();
      return;
    }
    if (d.moved) {
      pushHistory(d.before);
      shapesChanged();
    }
  }
  overlay.addEventListener('pointerup', endDrag);
  overlay.addEventListener('pointercancel', endDrag);

  function applyStyle(key, val) {
    if (!cur) return;
    cur[key] = val;
    var s = findShape(cur.selected);
    if (s && s[key] !== val) {
      pushHistory();
      s[key] = val;
      shapesChanged();
    } else {
      updateToolsUI();
      renderShapes();
    }
  }

  /* ==========================================================
     保存
     ========================================================== */
  // 重複登録の判定用：サイズと、先頭・末尾の一部のハッシュ
  function fingerprint(blob, name) {
    var fallback = 'n:' + blob.size + ':' + (name || '');
    if (!(window.crypto && crypto.subtle && blob.slice)) return Promise.resolve(fallback);
    var CH = 262144;
    var parts = [blob.slice(0, CH)];
    if (blob.size > CH * 2) parts.push(blob.slice(blob.size - CH));
    return new Response(new Blob(parts)).arrayBuffer().then(function (buf) {
      return crypto.subtle.digest('SHA-256', buf);
    }).then(function (hash) {
      var b = new Uint8Array(hash), hex = '';
      for (var i = 0; i < 12; i++) hex += (b[i] < 16 ? '0' : '') + b[i].toString(16);
      return 'h:' + blob.size + ':' + hex;
    }).catch(function () { return fallback; });
  }

  function captureThumb() {
    try {
      var vw = video.videoWidth, vh = video.videoHeight;
      if (!vw || !vh) return null;
      var s = Math.min(1, 400 / Math.max(vw, vh));
      var c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(vw * s));
      c.height = Math.max(1, Math.round(vh * s));
      c.getContext('2d').drawImage(video, 0, 0, c.width, c.height);
      return c.toDataURL('image/jpeg', 0.72);
    } catch (e) {
      return null;
    }
  }

  function itemRecord() {
    var m = cur.meta;
    return {
      id: cur.id,
      kind: cur.kind,
      title: m.title || '',
      date: m.date || '',
      club: m.club || '',
      dir: m.dir || '',
      memo: m.memo || '',
      fav: !!m.fav,
      fps: m.fps || 'auto',
      estFps: cur.estFps || 0,
      size: cur.blob.size,
      type: cur.blob.type || '',
      duration: cur.duration,
      w: m.w, h: m.h,
      fp: m.fp || '',
      thumb: m.thumb || null,
      createdAt: m.createdAt || Date.now(),
      updatedAt: Date.now()
    };
  }
  function saveItemMeta() {
    if (!cur || !cur.saved) return Promise.resolve();
    return dbPut('items', itemRecord()).catch(function () { toast('情報を保存できませんでした'); });
  }

  function openSaveSheet() {
    if (!cur || !cur.ready) return;
    if (!video.paused) video.pause();
    var m = cur.meta, model = cur.kind === 'model';
    $('save-heading').textContent = cur.saved ? '動画の情報を編集' : (model ? 'お手本動画を登録' : '動画を保存');
    $('save-title-label').textContent = model ? '選手名' : '動画タイトル';
    $('s-title').value = m.title || '';
    $('s-title').placeholder = model ? '例：お手本プロ' : defaultTitle(m.date, m.club, m.dir);
    $('s-date-field').hidden = model;
    $('s-date').value = m.date || todayStr();
    $('s-club').value = m.club || 'ドライバー';
    setSeg($('s-dir'), m.dir || '後方');
    $('s-memo').value = m.memo || '';
    $('s-fav').checked = !!m.fav;
    $('save-ok').textContent = cur.saved ? '更新する' : (model ? '登録する' : '保存する');
    $('save-ok').disabled = false;
    $('toast').hidden = true;
    $('save-sheet').hidden = false;
  }
  function defaultTitle(date, club, dir) {
    var p = (date || todayStr()).split('-');
    return Number(p[1]) + '/' + Number(p[2]) + ' ' + (club || '') + ' ' + (dir || '');
  }

  function submitSave() {
    if (!cur) return;
    var model = cur.kind === 'model';
    var m = cur.meta;
    var date = model ? (m.date || todayStr()) : ($('s-date').value || todayStr());
    var club = $('s-club').value;
    var dir = getSeg($('s-dir'));
    var title = $('s-title').value.trim() || (model ? 'お手本' : defaultTitle(date, club, dir));
    var next = { title: title, date: date, club: club, dir: dir, memo: $('s-memo').value.trim(), fav: $('s-fav').checked };

    if (cur.saved) {
      Object.keys(next).forEach(function (k) { m[k] = next[k]; });
      saveItemMeta().then(function () {
        $('save-sheet').hidden = true;
        updateHeader();
        toast('更新しました');
      });
      return;
    }

    $('save-ok').disabled = true;
    var token = cur.token;
    Promise.all([cur.fpPromise, dbAll('items')]).then(function (r) {
      var fp = r[0];
      var dup = r[1].filter(function (i) { return i.fp && i.fp === fp && i.kind === cur.kind; })[0];
      if (!dup) return fp;
      return ask('同じ動画が保存されています', '「' + (dup.title || '無題') + '」と同じ動画のようです。', [
        { label: '保存済みを開く', value: 'open', kind: 'primary' },
        { label: 'それでも保存', value: 'save' },
        { label: 'キャンセル', value: '' }
      ]).then(function (v) {
        if (v === 'open') {
          $('save-sheet').hidden = true;
          var from = cur.from;
          closeVideo(false);
          openSaved(dup.id, from);
          return null;
        }
        return v === 'save' ? fp : null;
      });
    }).then(function (fp) {
      if (fp == null || !cur || cur.token !== token) return null;
      // 空き容量の目安を確認（対応ブラウザのみ）
      if (!(navigator.storage && navigator.storage.estimate)) return fp;
      return navigator.storage.estimate().then(function (est) {
        var free = (est.quota || 0) - (est.usage || 0);
        if (!est.quota || free > cur.blob.size * 1.1) return fp;
        return ask('空き容量が足りない可能性があります', '動画のサイズ：' + fmtSize(cur.blob.size) + '\n保存できる目安：' + fmtSize(Math.max(0, free)) + '\n不要な動画を削除すると保存できる場合があります。', [
          { label: '保存を試す', value: 1, kind: 'primary' },
          { label: 'キャンセル', value: 0 }
        ]).then(function (ok) { return ok ? fp : null; });
      }, function () { return fp; });
    }).then(function (fp) {
      if (fp == null || !cur || cur.token !== token) return;
      busy(true, '保存しています…');
      Object.keys(next).forEach(function (k) { m[k] = next[k]; });
      m.fp = fp;
      m.thumb = captureThumb();
      m.createdAt = Date.now();
      var id = uid();
      cur.id = id;
      var item = itemRecord();
      var shapes = JSON.parse(snapshot());
      var type = cur.blob.type || 'video/mp4';
      function write(videoRec) {
        return dbTx(['items', 'videos', 'drawings'], 'readwrite', function (tx) {
          tx.objectStore('videos').put(videoRec);
          tx.objectStore('items').put(item);
          tx.objectStore('drawings').put({ id: id, shapes: shapes, updatedAt: Date.now() });
        });
      }
      return write({ id: id, blob: cur.blob, type: type }).catch(function (err) {
        // Blob のまま保存できない環境向けに、バイト列として保存し直す
        if ((err && /quota/i.test(err.name || '')) || cur.blob.size > 200 * 1048576) throw err;
        return new Response(cur.blob).arrayBuffer().then(function (buf) {
          return write({ id: id, buf: buf, type: type });
        });
      }).then(function () {
        if (!cur || cur.token !== token) return;
        busy(false);
        cur.saved = true;
        $('save-sheet').hidden = true;
        updateHeader();
        toast(model ? 'お手本動画を登録しました' : '保存しました');
        if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(function () {});
      });
    }).catch(function (err) {
      busy(false);
      if (cur && cur.token === token && !cur.saved) cur.id = null;
      var quota = err && /quota/i.test((err.name || '') + (err.message || ''));
      ask('保存できませんでした', quota
        ? 'アプリに保存できる容量が不足しています。不要な動画を削除してからお試しください。\n元の動画は「写真」アプリに残しておいてください。'
        : 'このブラウザの設定（プライベートブラウズなど）や空き容量が原因の可能性があります。\n元の動画は「写真」アプリに残しておいてください。',
        [{ label: 'OK', value: 1, kind: 'primary' }]);
    }).then(function () {
      $('save-ok').disabled = false;
    });
  }

  /* ==========================================================
     イベントの登録
     ========================================================== */
  function fillClubs() {
    var f = $('f-club'), s = $('s-club');
    var all = document.createElement('option');
    all.value = '';
    all.textContent = 'クラブ：すべて';
    f.appendChild(all);
    CLUBS.forEach(function (c) {
      [f, s].forEach(function (sel) {
        var o = document.createElement('option');
        o.value = c;
        o.textContent = c;
        sel.appendChild(o);
      });
    });
  }
  function fillSwatches() {
    var box = $('swatches');
    COLORS.forEach(function (c) {
      var b = document.createElement('button');
      b.setAttribute('aria-label', c[0]);
      b.setAttribute('data-color', c[1]);
      b.style.background = c[1];
      box.appendChild(b);
    });
  }

  /* ==========================================================
     画面下の余白の補正と診断
     ホーム画面から起動したとき、iOS側で表示領域が画面より短くなり、
     下に余白ができる場合がある。その場合はホームバー用の余白（下のセーフエリア）を
     重ねて取らないようにして、ボタンを下に寄せる。
     ========================================================== */
  function safeInsets() {
    var d = document.createElement('div');
    d.style.cssText = 'position:fixed;left:0;top:0;visibility:hidden;pointer-events:none;' +
      'padding:env(safe-area-inset-top,0px) env(safe-area-inset-right,0px) env(safe-area-inset-bottom,0px) env(safe-area-inset-left,0px)';
    document.body.appendChild(d);
    var c = getComputedStyle(d);
    var r = { top: parseFloat(c.paddingTop) || 0, right: parseFloat(c.paddingRight) || 0, bottom: parseFloat(c.paddingBottom) || 0, left: parseFloat(c.paddingLeft) || 0 };
    document.body.removeChild(d);
    return r;
  }
  function isStandalone() {
    return navigator.standalone === true || !!(window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);
  }
  function bottomGap() {
    if (!isStandalone() || !window.screen) return 0;
    var root = document.documentElement;
    var portrait = root.clientHeight >= root.clientWidth;
    var full = portrait ? Math.max(screen.width, screen.height) : Math.min(screen.width, screen.height);
    var gap = full - root.clientHeight;
    return gap >= 20 && gap <= 120 ? gap : 0;
  }
  function applyViewportFix() {
    var root = document.documentElement;
    var gap = bottomGap();
    if (gap) root.style.setProperty('--sab', Math.max(0, safeInsets().bottom - gap) + 'px');
    else root.style.removeProperty('--sab');
  }
  function showDiag() {
    var root = document.documentElement, ins = safeInsets(), vv = window.visualViewport;
    var strip = document.createElement('div');
    strip.className = 'diag-strip';
    strip.textContent = 'TEST';
    document.body.appendChild(strip);
    var lines = [
      'バージョン：' + APP_VERSION,
      '画面：' + screen.width + '×' + screen.height,
      '表示領域：' + root.clientWidth + '×' + root.clientHeight,
      'inner：' + window.innerWidth + '×' + window.innerHeight + (vv ? ' / vv：' + Math.round(vv.width) + '×' + Math.round(vv.height) : ''),
      '余白（上/右/下/左）：' + [ins.top, ins.right, ins.bottom, ins.left].join(' / '),
      'ホーム画面から起動：' + (isStandalone() ? 'はい' : 'いいえ'),
      '下の余白：' + bottomGap() + ' / 補正：' + (root.style.getPropertyValue('--sab') || 'なし'),
      navigator.userAgent.replace(/^Mozilla\/5\.0 /, '').slice(0, 90)
    ];
    // カメラの情報（広角の切り替えがうまくいかないときの調査用。一度カメラを使ったあとに名前が分かる）
    var md = navigator.mediaDevices;
    var getCams = md && md.enumerateDevices ? md.enumerateDevices().catch(function () { return []; }) : Promise.resolve([]);
    getCams.then(function (list) {
      var names = list.filter(function (d) { return d.kind === 'videoinput'; }).map(function (d) { return d.label || '（名前なし）'; });
      lines.push('カメラ：' + (names.length ? names.join('、') : 'なし'));
      if (cam.diag.label) lines.push('使用：' + cam.diag.label + ' / ズーム：' + (cam.diag.zoom ? cam.diag.zoom[0] + '〜' + cam.diag.zoom[1] + '（今 ' + cam.diag.zoom[2] + '）' : 'なし'));
      if (cam.focusInfo) lines.push('ピント：' + (cam.focus ? 'タップ対応（' + cam.focus.mode + '）' : 'タップ非対応') +
        ' / 方式：' + (cam.focusInfo.modes ? cam.focusInfo.modes.join(',') : 'なし') + ' / 位置指定：' + (cam.focusInfo.poi ? 'あり' : 'なし'));
      var c = cam.ctl;
      lines.push('ズーム操作：' + (c ? c.mode + ' ' + fmtZoom(c.min) + '〜' + fmtZoom(c.max) + '（このカメラ ' + fmtZoom(c.devMin) + '〜' + fmtZoom(c.devMax) + '）' : 'なし') +
        ' / 超広角：' + (cam.ultraId ? 'あり' : 'なし') + ' / 現在：' + fmtZoom(cam.zoom) + '×');
      return ask('診断情報', lines.join('\n'), [{ label: '閉じる', value: 1, kind: 'primary' }]);
    }).then(function () {
      if (strip.parentNode) strip.parentNode.removeChild(strip);
    });
  }

  function init() {
    $('app-version').textContent = 'v' + APP_VERSION;
    applyViewportFix();
    window.addEventListener('resize', applyViewportFix);
    window.addEventListener('orientationchange', function () { setTimeout(applyViewportFix, 300); });
    document.querySelector('.foot-ver').addEventListener('click', showDiag);
    fillClubs();
    fillSwatches();

    // ホーム
    Array.prototype.forEach.call(document.querySelectorAll('[data-go]'), function (b) {
      b.addEventListener('click', function () {
        var go = b.getAttribute('data-go');
        if (go === 'capture') show('capture');
        else openList(go.replace('list-', ''));
      });
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-back]'), function (b) {
      b.addEventListener('click', function () { show('home'); });
    });

    // 撮影・取り込み
    bindSeg($('cap-dir'), function (v) {
      captureDir = v;
      $('cap-dir-hint').textContent = DIR_HINT[v];
    });
    $('btn-import').addEventListener('click', function () { $('file-import').click(); });
    $('btn-camera').addEventListener('click', openCamera);
    $('file-import').addEventListener('change', function () { handleFile(this, 'my', captureDir, 'capture'); });
    $('file-camera').addEventListener('change', function () {
      if (currentScreen === 'camera') closeCamera();
      handleFile(this, 'my', captureDir, 'capture');
    });

    // アプリ内カメラ
    $('cam-back').addEventListener('click', function () { closeCamera(); show('capture'); });
    $('cam-rec').addEventListener('click', function () { if (cam.recording) stopRec(); else startRec(); });
    $('cam-fps').addEventListener('click', function () {
      if (cam.recording) return;
      cam.fpsMode = cam.fpsMode === 60 ? 30 : 60;
      saveCamFps();
      this.textContent = cam.fpsMode + 'fps';
      startStream();
    });
    $('cam-flip').addEventListener('click', function () {
      if (cam.recording) return;
      cam.facing = cam.facing === 'environment' ? 'user' : 'environment';
      cam.ctl = null;       // 前後を切り替えたら、ズームの扱い方を調べ直す
      cam.onUltra = false;
      updateLensUI();
      startStream();
    });

    // 一覧
    $('f-club').addEventListener('change', function () { listState.club = this.value; renderList(); });
    $('f-dir').addEventListener('change', function () { listState.dir = this.value; renderList(); });
    $('f-fav').addEventListener('click', function () {
      listState.fav = !listState.fav;
      this.setAttribute('aria-pressed', listState.fav ? 'true' : 'false');
      renderList();
    });
    $('list-add').addEventListener('click', function () { $('file-model').click(); });
    $('file-model').addEventListener('change', function () { handleFile(this, 'model', '後方', 'list'); });

    // 動画分析：上部
    $('an-back').addEventListener('click', requestBack);
    $('an-shoot').addEventListener('click', shootNext);
    $('an-save').addEventListener('click', openSaveSheet);
    $('an-fav').addEventListener('click', function () {
      if (!cur || !cur.ready) return;
      cur.meta.fav = !cur.meta.fav;
      updateHeader();
      if (cur.saved) {
        saveItemMeta();
        toast(cur.meta.fav ? 'お気に入りに登録しました' : 'お気に入りを解除しました');
      } else {
        toast(cur.meta.fav ? '保存するとお気に入りに登録されます' : 'お気に入りを解除しました');
      }
    });

    // 動画分析：動画タップで操作パネルの表示・非表示（再生モードのみ）
    stage.addEventListener('click', function (e) {
      if (!cur || !cur.ready || cur.mode !== 'play') return;
      if (e.target.closest && e.target.closest('#stage-msg')) return;
      var hide = !screenAn.classList.contains('panels-hidden');
      screenAn.classList.toggle('panels-hidden', hide);
      if (hide) toast('動画をタップすると操作パネルを表示します', 1800);
    });
    if (window.ResizeObserver) {
      new ResizeObserver(fitFrame).observe(stage);
      new ResizeObserver(fitFrame).observe($('an-controls'));
    }
    window.addEventListener('resize', fitFrame);
    window.addEventListener('orientationchange', function () { setTimeout(fitFrame, 250); });

    // 動画分析：再生操作
    $('btn-play').addEventListener('click', togglePlay);
    bindHold($('btn-prev'), -1);
    bindHold($('btn-next'), 1);
    $('speeds').addEventListener('click', function (e) {
      var b = e.target.closest('button');
      if (b) setRate(Number(b.getAttribute('data-rate')));
    });
    $('fps-chip').addEventListener('click', openFpsSheet);
    $('fps-close').addEventListener('click', function () { $('fps-sheet').hidden = true; });

    // 動画分析：描画ツール
    $('tool-mode').addEventListener('click', function () {
      if (!cur || !cur.ready) return;
      setMode(cur.mode === 'draw' ? 'play' : 'draw');
    });
    Array.prototype.forEach.call(document.querySelectorAll('#tools-main [data-tool]'), function (b) {
      b.addEventListener('click', function () { chooseTool(b.getAttribute('data-tool')); });
    });
    $('tool-style').addEventListener('click', function () { if (cur) { updateToolsUI(); showStyleRow(true); } });
    $('style-back').addEventListener('click', function () { showStyleRow(false); });
    $('swatches').addEventListener('click', function (e) {
      var b = e.target.closest('button');
      if (b) applyStyle('color', b.getAttribute('data-color'));
    });
    $('widths').addEventListener('click', function (e) {
      var b = e.target.closest('button');
      if (b) applyStyle('width', Number(b.getAttribute('data-w')));
    });
    $('tool-extend').addEventListener('click', function () {
      if (!cur) return;
      var s = findShape(cur.selected);
      if (s && s.type !== 'line') { toast('延長はシャフトラインで使えます'); return; }
      if (s) {
        pushHistory();
        s.extend = !s.extend;
        cur.extend = s.extend;
        shapesChanged();
      } else {
        cur.extend = !cur.extend;
        updateToolsUI();
        toast(cur.extend ? '次に引くシャフトラインを画面の端まで延長します' : '次に引くシャフトラインは延長しません');
      }
    });
    $('tool-delete').addEventListener('click', function () {
      if (!cur) return;
      var s = findShape(cur.selected);
      if (!s) { toast('削除したい線や枠をタップして選んでください'); if (cur.shapes.length) setMode('draw'); return; }
      pushHistory();
      cur.shapes = cur.shapes.filter(function (x) { return x.id !== s.id; });
      cur.selected = null;
      shapesChanged();
    });
    $('tool-undo').addEventListener('click', function () {
      if (!cur) return;
      if (cur.pending) { cur.pending = null; updateToolsUI(); renderShapes(); return; }
      if (!cur.history.length) { toast('戻せる操作はありません'); return; }
      cur.shapes = JSON.parse(cur.history.pop());
      if (!findShape(cur.selected)) cur.selected = null;
      cur.swayCount = 0;
      shapesChanged();
    });
    $('tool-hide').addEventListener('click', function () {
      if (!cur) return;
      cur.hidden = !cur.hidden;
      if (cur.hidden) { cur.selected = null; cur.tool = null; cur.pending = null; }
      updateToolsUI();
      renderShapes();
    });

    // 保存フォーム
    bindSeg($('s-dir'));
    $('save-cancel').addEventListener('click', function () { $('save-sheet').hidden = true; });
    $('save-form').addEventListener('submit', function (e) { e.preventDefault(); submitSave(); });

    // バックグラウンドに移ったら再生を止め、補助線を確実に保存する
    document.addEventListener('visibilitychange', function () {
      if (document.hidden && cur) {
        if (!video.paused) video.pause();
        flushDrawings();
      }
      // カメラ画面：裏に回ったら録画を止めてカメラを解放し、戻ったら再起動する
      if (currentScreen === 'camera') {
        if (document.hidden) {
          if (cam.recording) stopRec();
          else { cam.token++; stopStream(); }
        } else if (!cam.stream && !cam.recording && !cam.failed) {
          startStream();
        }
      }
    });
    window.addEventListener('pagehide', flushDrawings);

    // ピンチ操作などでページ全体が拡大されるのを防ぐ（動画と補助線の位置ずれ防止）
    document.addEventListener('gesturestart', function (e) { e.preventDefault(); });

    refreshStorageInfo();
    registerServiceWorker();
  }

  /* ==========================================================
     Service Worker（オフライン対応・更新の案内）
     ========================================================== */
  function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    var secure = location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1';
    if (!secure) return;
    var timer = 0;
    navigator.serviceWorker.addEventListener('message', function (e) {
      if (!e.data || e.data.type !== 'app-updated') return;
      clearTimeout(timer);
      timer = setTimeout(function () { $('update-bar').hidden = false; }, 1500);
    });
    $('update-btn').addEventListener('click', function () {
      flushDrawings();
      location.reload();
    });
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('service-worker.js').catch(function () {});
    });
  }

  init();
})();
