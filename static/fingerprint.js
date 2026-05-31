(() => {
  const encoder = new TextEncoder();

  function bytes(input) {
    if (input instanceof Uint8Array) return input;
    if (input instanceof ArrayBuffer) return new Uint8Array(input);
    if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    return null;
  }

  function fnv1a(input) {
    const data = typeof input === "string" ? encoder.encode(input) : bytes(input);
    if (!data) return "";
    let hash = 0x811c9dc5;
    for (const value of data) {
      hash ^= value;
      hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, "0");
  }

  async function sha256(input) {
    try {
      if (!crypto || !crypto.subtle || !crypto.subtle.digest) return fnv1a(input);
      const data = typeof input === "string" ? encoder.encode(input) : input;
      const digest = await crypto.subtle.digest("SHA-256", data);
      return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
    } catch (_) {
      return fnv1a(input);
    }
  }

  async function canvasHash() {
    try {
      const canvas = document.createElement("canvas");
      canvas.width = 240;
      canvas.height = 60;
      const ctx = canvas.getContext("2d");
      if (!ctx) return "";
      ctx.textBaseline = "top";
      ctx.font = "16px Arial";
      ctx.fillStyle = "#f60";
      ctx.fillRect(100, 1, 80, 22);
      ctx.fillStyle = "#069";
      ctx.fillText("Cwm fjordbank glyphs vext quiz", 2, 15);
      ctx.fillStyle = "rgba(102,204,0,0.7)";
      ctx.fillText("Cwm fjordbank glyphs vext quiz", 4, 17);
      return await sha256(canvas.toDataURL());
    } catch (_) {
      return "";
    }
  }

  async function audioHash() {
    try {
      const Context = window.OfflineAudioContext || window.webkitOfflineAudioContext;
      if (!Context) return "";
      const sampleRate = 44100;
      const ctx = new Context(1, sampleRate, sampleRate);
      const oscillator = ctx.createOscillator();
      const compressor = ctx.createDynamicsCompressor();
      oscillator.type = "triangle";
      oscillator.frequency.value = 10000;
      compressor.threshold.value = -50;
      compressor.knee.value = 40;
      compressor.ratio.value = 12;
      compressor.attack.value = 0;
      compressor.release.value = 0.25;
      oscillator.connect(compressor);
      compressor.connect(ctx.destination);
      oscillator.start(0);
      try {
        oscillator.stop(0.1);
      } catch (_) {}

      let rendered;
      const maybePromise = ctx.startRendering();
      if (maybePromise && typeof maybePromise.then === "function") {
        rendered = await maybePromise;
      } else {
        rendered = await new Promise((resolve, reject) => {
          ctx.oncomplete = (event) => resolve(event.renderedBuffer);
          ctx.onerror = reject;
          try {
            ctx.startRendering();
          } catch (err) {
            reject(err);
          }
        });
      }

      const samples = rendered.getChannelData(0);
      if (!samples || !samples.length) return "";
      const sampleCount = 512;
      const stride = Math.max(1, Math.floor(samples.length / sampleCount));
      const summary = new Float32Array(sampleCount);
      for (let i = 0; i < sampleCount; i++) summary[i] = samples[i * stride] || 0;
      return await sha256(summary);
    } catch (_) {
      return "";
    }
  }

  function webglInfo() {
    try {
      const canvas = document.createElement("canvas");
      const gl = canvas.getContext("webgl") || canvas.getContext("experimental-webgl") || canvas.getContext("webgl2");
      if (!gl) return { vendor: "", renderer: "" };
      const debugInfo = gl.getExtension("WEBGL_debug_renderer_info");
      return {
        vendor: debugInfo ? String(gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL) || "") : "",
        renderer: debugInfo ? String(gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) || "") : "",
      };
    } catch (_) {
      return { vendor: "", renderer: "" };
    }
  }

  function baseReport() {
    let tz = "";
    try {
      tz = String(Intl.DateTimeFormat().resolvedOptions().timeZone || "");
    } catch (_) {}

    return {
      v: 1,
      webdriver: navigator.webdriver === true,
      max_touch_points: Number.isFinite(navigator.maxTouchPoints) ? navigator.maxTouchPoints : 0,
      touch_event: "ontouchstart" in window,
      platform: String(navigator.platform || ""),
      tz,
      langs: Array.isArray(navigator.languages) ? navigator.languages.slice(0, 8) : [],
      hardware_concurrency: Number.isFinite(navigator.hardwareConcurrency) ? navigator.hardwareConcurrency : 0,
      device_memory: Number.isFinite(navigator.deviceMemory) ? navigator.deviceMemory : 0,
      screen_w: Number.isFinite(screen.width) ? screen.width : 0,
      screen_h: Number.isFinite(screen.height) ? screen.height : 0,
      dpr: Number.isFinite(window.devicePixelRatio) ? window.devicePixelRatio : 0,
      plugins: navigator.plugins ? navigator.plugins.length : 0,
    };
  }

  async function run() {
    try {
      const report = baseReport();
      report.canvas = await canvasHash();
      report.audio_supported = !!(window.OfflineAudioContext || window.webkitOfflineAudioContext);
      report.audio = await audioHash();
      const webgl = webglInfo();
      report.webgl_vendor = webgl.vendor;
      report.webgl_renderer = webgl.renderer;

      const response = await fetch("/__aqua/axis_order", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(report),
      });
      const result = response.ok ? await response.json().catch(() => null) : null;
      if (result && result.ok === true) location.reload();
    } catch (_) {}
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", run, { once: true });
  } else {
    run();
  }
})();
