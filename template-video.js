(() => {
  "use strict";

  const DEFAULT_FPS = 24;
  const AUDIO_BITRATE = 192_000;
  const FFMPEG_VERSION = "0.12.15";
  const FFMPEG_CORE_VERSION = "0.12.10";
  const FFMPEG_BASE = `https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@${FFMPEG_VERSION}/dist/umd`;
  const FFMPEG_CORE_BASE = `https://cdn.jsdelivr.net/npm/@ffmpeg/core@${FFMPEG_CORE_VERSION}/dist/umd`;

  let ffmpegPromise = null;
  let ffmpegBlobUrls = [];

  function dataUriToFile(dataUri, name, mimeType = "audio/mpeg") {
    const comma = dataUri.indexOf(",");
    if (comma < 0) throw new Error("Data musik bawaan tidak valid.");
    const binary = atob(dataUri.slice(comma + 1));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return new File([bytes], name, { type: mimeType, lastModified: Date.now() });
  }

  function getDefaultMusicFile() {
    const asset = window.DEFAULT_MUSIC;
    if (!asset?.dataUri) throw new Error("Musik bawaan tidak ditemukan.");
    return dataUriToFile(asset.dataUri, asset.name || "musik-bawaan.mp3", asset.mimeType || "audio/mpeg");
  }

  function probeAudio(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const audio = document.createElement("audio");
      audio.preload = "metadata";
      const cleanup = () => {
        audio.removeAttribute("src");
        audio.load();
        URL.revokeObjectURL(url);
      };
      audio.addEventListener("loadedmetadata", () => {
        const duration = Number(audio.duration);
        cleanup();
        if (!Number.isFinite(duration) || duration <= 0) reject(new Error("Durasi musik tidak dapat dibaca."));
        else resolve({ duration });
      }, { once: true });
      audio.addEventListener("error", () => {
        cleanup();
        reject(new Error("File musik tidak dapat diputar oleh browser."));
      }, { once: true });
      audio.src = url;
    });
  }

  function formatDuration(seconds) {
    const totalHundredths = Math.max(0, Math.round((Number(seconds) || 0) * 100));
    const minutes = Math.floor(totalHundredths / 6000);
    const secs = Math.floor((totalHundredths % 6000) / 100);
    const hundredths = totalHundredths % 100;
    return `${minutes}:${String(secs).padStart(2, "0")}.${String(hundredths).padStart(2, "0")}`;
  }

  function normalizeFileName(name) {
    return String(name || "video")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-zA-Z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 100) || "video";
  }

  function downloadBlob(blob, fileName) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }

  function hasStableRuntime() {
    return Boolean(window.Mediabunny && window.VideoEncoder && window.AudioEncoder && window.AudioDecoder);
  }

  function videoBitrate(width, height) {
    const pixels = width * height;
    if (pixels >= 5_000_000) return 8_000_000;
    if (pixels >= 3_000_000) return 6_000_000;
    return 4_000_000;
  }

  function stableVideoCapability(width, height, fps) {
    return {
      width,
      height,
      bitrate: videoBitrate(width, height),
      framerate: fps,
      hardwareAcceleration: "prefer-hardware",
      fullCodecString: "avc1.420033",
    };
  }

  function stableVideoEncoding(width, height) {
    return {
      codec: "avc",
      fullCodecString: "avc1.420033",
      bitrate: videoBitrate(width, height),
      keyFrameInterval: 5,
      bitrateMode: "variable",
      latencyMode: "quality",
      hardwareAcceleration: "prefer-hardware",
      contentHint: "detail",
    };
  }

  function stableAudioCapability() {
    return {
      sampleRate: 48_000,
      numberOfChannels: 2,
      bitrate: AUDIO_BITRATE,
      fullCodecString: "mp4a.40.2",
    };
  }

  function stableAudioEncoding() {
    return {
      codec: "aac",
      bitrate: AUDIO_BITRATE,
      fullCodecString: "mp4a.40.2",
      transform: { sampleRate: 48_000, numberOfChannels: 2 },
    };
  }

  async function canUseStableMp4(width, height, fps) {
    if (!hasStableRuntime()) return false;
    try {
      const M = window.Mediabunny;
      const [videoOk, audioOk] = await Promise.all([
        M.canEncodeVideo("avc", stableVideoCapability(width, height, fps)),
        M.canEncodeAudio("aac", stableAudioCapability()),
      ]);
      return Boolean(videoOk && audioOk);
    } catch (error) {
      console.warn("Pemeriksaan MP4 WebCodecs gagal", error);
      return false;
    }
  }

  async function encodeStableMp4({ musicFile, duration, width, height, fps, renderFrame, quote, onFrameProgress }) {
    const M = window.Mediabunny;
    let input = null;
    let output = null;
    try {
      input = new M.Input({ source: new M.BlobSource(musicFile), formats: M.ALL_FORMATS });
      const audioTrack = await input.getPrimaryAudioTrack();
      if (!audioTrack || !(await audioTrack.canDecode())) throw new Error("Codec musik tidak dapat dibaca oleh browser.");

      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d", { alpha: false, desynchronized: true });
      renderFrame(context, width, height, quote);

      const target = new M.BufferTarget();
      output = new M.Output({ format: new M.Mp4OutputFormat({ fastStart: "in-memory" }), target });
      const videoSource = new M.CanvasSource(canvas, stableVideoEncoding(width, height));
      const audioSource = new M.AudioSampleSource(stableAudioEncoding());
      output.addVideoTrack(videoSource, { frameRate: fps });
      output.addAudioTrack(audioSource);
      await output.start();

      const frameCount = Math.max(1, Math.ceil(duration * fps));
      const videoTask = (async () => {
        for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
          const timestamp = frameIndex / fps;
          const frameDuration = Math.min(1 / fps, Math.max(0.001, duration - timestamp));
          await videoSource.add(timestamp, frameDuration);
          onFrameProgress?.((frameIndex + 1) / frameCount);
        }
        videoSource.close();
      })();

      const audioTask = (async () => {
        const sink = new M.AudioSampleSink(audioTrack);
        for await (const sample of sink.samples(0, duration)) {
          await audioSource.add(sample);
          sample.close();
        }
        audioSource.close();
      })();

      await Promise.all([videoTask, audioTask]);
      await output.finalize();
      if (!target.buffer) throw new Error("Encoder tidak menghasilkan file MP4.");
      return new Blob([target.buffer], { type: "video/mp4" });
    } catch (error) {
      try {
        if (output && !["finalized", "canceled"].includes(output.state)) await output.cancel();
      } catch (cancelError) {
        console.warn("Gagal menutup encoder", cancelError);
      }
      throw error;
    } finally {
      try { input?.dispose?.(); } catch (error) { console.warn("Gagal melepas input musik", error); }
    }
  }

  // MP4 selalu diprioritaskan. WebM sengaja tidak pernah dipilih sebagai hasil akhir.
  function getMp4RecorderConfig() {
    if (typeof MediaRecorder === "undefined") return null;
    const options = [
      "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
      "video/mp4;codecs=avc1.4D401F,mp4a.40.2",
      "video/mp4",
    ];
    const mimeType = options.find((item) => {
      try { return MediaRecorder.isTypeSupported(item); } catch (error) { return false; }
    });
    return mimeType ? { mimeType, extension: "mp4" } : null;
  }

  async function encodeRealtimeMp4({ musicFile, duration, width, height, fps, renderFrame, quote, onFrameProgress }) {
    const config = getMp4RecorderConfig();
    if (!config) throw new Error("MediaRecorder MP4 tidak tersedia.");

    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) throw new Error("AudioContext tidak didukung oleh browser.");

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { alpha: false, desynchronized: true });
    renderFrame(context, width, height, quote);

    const audioUrl = URL.createObjectURL(musicFile);
    const audio = document.createElement("audio");
    audio.src = audioUrl;
    audio.preload = "auto";
    audio.playsInline = true;

    let audioContext = null;
    let outputStream = null;
    let recorder = null;
    let redrawTimer = null;
    let progressTimer = null;

    try {
      audioContext = new AudioContextClass();
      const audioSource = audioContext.createMediaElementSource(audio);
      const audioDestination = audioContext.createMediaStreamDestination();
      audioSource.connect(audioDestination);

      const canvasStream = canvas.captureStream(0);
      const canvasTrack = canvasStream.getVideoTracks()[0];
      outputStream = new MediaStream([
        canvasTrack,
        ...audioDestination.stream.getAudioTracks(),
      ]);
      const chunks = [];
      recorder = new MediaRecorder(outputStream, {
        mimeType: config.mimeType,
        videoBitsPerSecond: videoBitrate(width, height),
        audioBitsPerSecond: AUDIO_BITRATE,
      });

      const done = new Promise((resolve, reject) => {
        recorder.addEventListener("dataavailable", (event) => { if (event.data?.size) chunks.push(event.data); });
        recorder.addEventListener("stop", resolve, { once: true });
        recorder.addEventListener("error", () => reject(recorder.error || new Error("Perekam MP4 gagal.")), { once: true });
      });
      const playbackDone = new Promise((resolve, reject) => {
        audio.addEventListener("ended", resolve, { once: true });
        audio.addEventListener("error", () => reject(new Error("Musik berhenti karena gagal diputar.")), { once: true });
      });

      await audioContext.resume();
      recorder.start(1000);
      canvasTrack.requestFrame?.();
      redrawTimer = setInterval(() => {
        renderFrame(context, width, height, quote);
        canvasTrack.requestFrame?.();
      }, Math.max(250, 1000 / fps));
      progressTimer = setInterval(() => onFrameProgress?.(Math.min(1, audio.currentTime / duration)), 200);
      await audio.play();
      await playbackDone;
      if (recorder.state !== "inactive") recorder.stop();
      await done;
      onFrameProgress?.(1);

      const blob = new Blob(chunks, { type: recorder.mimeType || config.mimeType || "video/mp4" });
      if (!blob.size) throw new Error("Perekam MP4 menghasilkan file kosong.");
      return blob;
    } finally {
      clearInterval(redrawTimer);
      clearInterval(progressTimer);
      if (recorder?.state && recorder.state !== "inactive") recorder.stop();
      outputStream?.getTracks().forEach((track) => track.stop());
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
      URL.revokeObjectURL(audioUrl);
      await audioContext?.close().catch(() => {});
    }
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const existing = [...document.scripts].find((script) => script.src === src);
      if (existing) {
        if (window.FFmpegWASM?.FFmpeg) return resolve();
        existing.addEventListener("load", resolve, { once: true });
        existing.addEventListener("error", () => reject(new Error("Komponen MP4 gagal dimuat.")), { once: true });
        return;
      }
      const script = document.createElement("script");
      script.src = src;
      script.async = true;
      script.crossOrigin = "anonymous";
      script.addEventListener("load", resolve, { once: true });
      script.addEventListener("error", () => reject(new Error("Komponen MP4 gagal dimuat. Pastikan koneksi internet tersedia saat pertama kali memakai mode kompatibilitas.")), { once: true });
      document.head.append(script);
    });
  }

  async function remoteToBlobUrl(url, mimeType) {
    const response = await fetch(url, { mode: "cors", cache: "force-cache" });
    if (!response.ok) throw new Error(`Gagal memuat encoder MP4 (${response.status}).`);
    const source = await response.blob();
    const blob = new Blob([source], { type: mimeType });
    const blobUrl = URL.createObjectURL(blob);
    ffmpegBlobUrls.push(blobUrl);
    return blobUrl;
  }

  async function getFfmpeg() {
    if (ffmpegPromise) return ffmpegPromise;
    ffmpegPromise = (async () => {
      await loadScript(`${FFMPEG_BASE}/ffmpeg.js`);
      const FFmpegClass = window.FFmpegWASM?.FFmpeg;
      if (!FFmpegClass) throw new Error("FFmpeg MP4 tidak tersedia.");

      const [classWorkerURL, coreURL, wasmURL] = await Promise.all([
        remoteToBlobUrl(`${FFMPEG_BASE}/814.ffmpeg.js`, "text/javascript"),
        remoteToBlobUrl(`${FFMPEG_CORE_BASE}/ffmpeg-core.js`, "text/javascript"),
        remoteToBlobUrl(`${FFMPEG_CORE_BASE}/ffmpeg-core.wasm`, "application/wasm"),
      ]);

      const ffmpeg = new FFmpegClass();
      await ffmpeg.load({ classWorkerURL, coreURL, wasmURL });
      return ffmpeg;
    })().catch((error) => {
      ffmpegPromise = null;
      throw error;
    });
    return ffmpegPromise;
  }

  function canvasToPngBlob(canvas) {
    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new Error("Frame gambar tidak dapat dibuat."));
      }, "image/png");
    });
  }

  function audioFileExtension(file) {
    const fromName = String(file?.name || "").match(/\.([a-zA-Z0-9]{2,5})$/)?.[1];
    if (fromName) return fromName.toLowerCase();
    const type = String(file?.type || "").toLowerCase();
    if (type.includes("mpeg")) return "mp3";
    if (type.includes("wav")) return "wav";
    if (type.includes("ogg")) return "ogg";
    if (type.includes("mp4") || type.includes("m4a")) return "m4a";
    if (type.includes("aac")) return "aac";
    return "audio";
  }

  async function safeDeleteFfmpegFile(ffmpeg, path) {
    try { await ffmpeg.deleteFile(path); } catch (error) { /* file may not exist */ }
  }

  async function encodeFfmpegMp4({ musicFile, duration, width, height, fps, renderFrame, quote, onFrameProgress }) {
    const ffmpeg = await getFfmpeg();
    const nonce = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const imageName = `frame-${nonce}.png`;
    const audioName = `audio-${nonce}.${audioFileExtension(musicFile)}`;
    const outputName = `output-${nonce}.mp4`;

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { alpha: false });
    renderFrame(context, width, height, quote);
    const imageBlob = await canvasToPngBlob(canvas);

    let progressHandler = null;
    try {
      await ffmpeg.writeFile(imageName, new Uint8Array(await imageBlob.arrayBuffer()));
      await ffmpeg.writeFile(audioName, new Uint8Array(await musicFile.arrayBuffer()));

      progressHandler = ({ progress }) => {
        const value = Number(progress);
        if (Number.isFinite(value)) onFrameProgress?.(Math.max(0, Math.min(0.99, value)));
      };
      ffmpeg.on("progress", progressHandler);

      const exitCode = await ffmpeg.exec([
        "-loop", "1",
        "-framerate", String(fps),
        "-i", imageName,
        "-i", audioName,
        "-t", String(Math.max(0.01, duration)),
        "-c:v", "libx264",
        "-preset", "ultrafast",
        "-tune", "stillimage",
        "-pix_fmt", "yuv420p",
        "-r", String(fps),
        "-c:a", "aac",
        "-b:a", "192k",
        "-shortest",
        "-movflags", "+faststart",
        "-y",
        outputName,
      ]);
      if (exitCode !== 0) throw new Error(`Encoder MP4 berhenti dengan kode ${exitCode}.`);

      const data = await ffmpeg.readFile(outputName);
      if (!(data instanceof Uint8Array) || !data.byteLength) throw new Error("Encoder MP4 menghasilkan file kosong.");
      onFrameProgress?.(1);
      return new Blob([data], { type: "video/mp4" });
    } finally {
      if (progressHandler) ffmpeg.off("progress", progressHandler);
      await Promise.all([
        safeDeleteFfmpegFile(ffmpeg, imageName),
        safeDeleteFfmpegFile(ffmpeg, audioName),
        safeDeleteFfmpegFile(ffmpeg, outputName),
      ]);
    }
  }

  async function exportBatch(options) {
    const {
      quotes,
      musicFile,
      duration,
      width,
      height,
      renderFrame,
      makeBaseName,
      zipName,
      onProgress,
      fps = DEFAULT_FPS,
    } = options;
    if (!quotes?.length) throw new Error("Tidak ada quotes untuk diekspor.");
    if (!musicFile) throw new Error("Musik belum tersedia.");

    let mode = "ffmpeg";
    if (await canUseStableMp4(width, height, fps)) mode = "webcodecs";
    else if (getMp4RecorderConfig()) mode = "mediarecorder";

    const useZip = quotes.length > 1;
    if (useZip && typeof JSZip === "undefined") throw new Error("Komponen ZIP tidak tersedia.");
    const zip = useZip ? new JSZip() : null;
    let singleResult = null;

    for (let index = 0; index < quotes.length; index += 1) {
      const quote = quotes[index];
      const baseProgress = index / quotes.length;
      const itemShare = 1 / quotes.length;
      const modeDetail = mode === "webcodecs"
        ? "MP4 H.264 + AAC sedang dirender."
        : mode === "mediarecorder"
          ? "MP4 H.264 + AAC direkam sesuai durasi musik."
          : "Menyiapkan encoder MP4 H.264 + AAC kompatibel untuk GPT Work.";

      onProgress?.({
        percent: baseProgress * 92,
        current: index,
        total: quotes.length,
        title: `Membuat MP4 ${index + 1} dari ${quotes.length}`,
        detail: modeDetail,
      });

      let blob;
      try {
        if (mode === "webcodecs") {
          blob = await encodeStableMp4({
            musicFile, duration, width, height, fps, renderFrame, quote,
            onFrameProgress: (ratio) => onProgress?.({
              percent: (baseProgress + itemShare * ratio) * 92,
              current: index + ratio,
              total: quotes.length,
              title: `Membuat MP4 ${index + 1} dari ${quotes.length}`,
              detail: `${Math.round(ratio * 100)}% · H.264 + AAC · ${width} × ${height} px`,
            }),
          });
        } else if (mode === "mediarecorder") {
          blob = await encodeRealtimeMp4({
            musicFile, duration, width, height, fps, renderFrame, quote,
            onFrameProgress: (ratio) => onProgress?.({
              percent: (baseProgress + itemShare * ratio) * 92,
              current: index + ratio,
              total: quotes.length,
              title: `Merekam MP4 ${index + 1} dari ${quotes.length}`,
              detail: `${Math.round(ratio * 100)}% · jangan tutup tab selama musik berjalan`,
            }),
          });
        } else {
          blob = await encodeFfmpegMp4({
            musicFile, duration, width, height, fps, renderFrame, quote,
            onFrameProgress: (ratio) => onProgress?.({
              percent: (baseProgress + itemShare * ratio) * 92,
              current: index + ratio,
              total: quotes.length,
              title: `Meng-encode MP4 ${index + 1} dari ${quotes.length}`,
              detail: `${Math.round(ratio * 100)}% · H.264 + AAC · mode kompatibel GPT Work`,
            }),
          });
        }
      } catch (error) {
        if (mode !== "ffmpeg") {
          console.warn(`Encoder ${mode} gagal. Beralih ke FFmpeg MP4.`, error);
          mode = "ffmpeg";
          onProgress?.({
            percent: baseProgress * 92,
            current: index,
            total: quotes.length,
            title: "Beralih ke encoder MP4 kompatibel…",
            detail: "Hasil akhir tetap MP4, bukan WebM.",
          });
          blob = await encodeFfmpegMp4({
            musicFile, duration, width, height, fps, renderFrame, quote,
            onFrameProgress: (ratio) => onProgress?.({
              percent: (baseProgress + itemShare * ratio) * 92,
              current: index + ratio,
              total: quotes.length,
              title: `Meng-encode MP4 ${index + 1} dari ${quotes.length}`,
              detail: `${Math.round(ratio * 100)}% · H.264 + AAC · mode kompatibel GPT Work`,
            }),
          });
        } else {
          throw error;
        }
      }

      if (!blob || blob.type !== "video/mp4") {
        blob = new Blob([blob], { type: "video/mp4" });
      }

      const baseName = normalizeFileName(makeBaseName(index, quote));
      const fileName = `${baseName}.mp4`;
      if (zip) zip.file(fileName, blob, { binary: true });
      else singleResult = { blob, fileName };
    }

    if (zip) {
      zip.file("INFO.txt", [
        `Jumlah video: ${quotes.length}`,
        `Ukuran: ${width} x ${height} px`,
        `Durasi setiap video: ${formatDuration(duration)}`,
        `Musik: ${musicFile.name}`,
        "Format: MP4",
        "Video: H.264/AVC",
        "Audio: AAC",
        "WebM dinonaktifkan sebagai hasil ekspor.",
        "Setiap quotes dibuat menjadi satu video dengan durasi mengikuti musik.",
      ].join("\n"));
      onProgress?.({ percent: 94, current: quotes.length, total: quotes.length, title: "Mengemas ZIP…", detail: "Menyiapkan semua MP4 untuk diunduh." });
      const output = await zip.generateAsync({ type: "blob", compression: "STORE", streamFiles: true }, (metadata) => {
        onProgress?.({ percent: 94 + metadata.percent * .06, current: quotes.length, total: quotes.length, title: "Mengemas ZIP…", detail: `${Math.round(metadata.percent)}%` });
      });
      downloadBlob(output, zipName);
    } else {
      downloadBlob(singleResult.blob, singleResult.fileName);
    }

    onProgress?.({ percent: 100, current: quotes.length, total: quotes.length, title: "MP4 selesai!", detail: `${formatDuration(duration)} · ${width} × ${height} px · MP4 H.264 + AAC` });
    return { extension: "mp4", stable: mode === "webcodecs", mode, count: quotes.length };
  }

  window.addEventListener("beforeunload", () => {
    ffmpegBlobUrls.forEach((url) => URL.revokeObjectURL(url));
    ffmpegBlobUrls = [];
  });

  window.TemplateVideo = {
    getDefaultMusicFile,
    probeAudio,
    formatDuration,
    exportBatch,
  };
})();
