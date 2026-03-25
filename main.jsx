import React, { useState, useRef, useCallback, useEffect, useMemo } from "react";

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function detectSilentRegions(channelData, sampleRate, opts = {}) {
  const { threshold = 0.015, minSilenceDuration = 0.3, minSegmentDuration = 0.5 } = opts;
  const minSilSamples = Math.floor(minSilenceDuration * sampleRate);
  const minSegSamples = Math.floor(minSegmentDuration * sampleRate);
  const len = channelData.length;
  let silStart = -1;
  const silences = [];
  const bs = 512;
  for (let i = 0; i < len; i += bs) {
    const end = Math.min(i + bs, len);
    let mx = 0;
    for (let j = i; j < end; j++) { const a = Math.abs(channelData[j]); if (a > mx) mx = a; }
    if (mx < threshold) { if (silStart === -1) silStart = i; }
    else { if (silStart !== -1 && i - silStart >= minSilSamples) silences.push([silStart, i]); silStart = -1; }
  }
  if (silStart !== -1 && len - silStart >= minSilSamples) silences.push([silStart, len]);
  const segs = [];
  let cur = 0;
  for (const [s, e] of silences) {
    if (s > cur && s - cur >= minSegSamples) segs.push({ start: cur, end: s });
    cur = e;
  }
  if (cur < len && len - cur >= minSegSamples) segs.push({ start: cur, end: len });
  return segs;
}

function encodeWav(buf) {
  const n = buf.numberOfChannels, sr = buf.sampleRate, len = buf.length;
  const ab = new ArrayBuffer(44 + len * n * 2);
  const v = new DataView(ab);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, "RIFF"); v.setUint32(4, 36 + len * n * 2, true); w(8, "WAVE"); w(12, "fmt ");
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, n, true);
  v.setUint32(24, sr, true); v.setUint32(28, sr * n * 2, true); v.setUint16(32, n * 2, true);
  v.setUint16(34, 16, true); w(36, "data"); v.setUint32(40, len * n * 2, true);
  let off = 44;
  for (let i = 0; i < len; i++) for (let ch = 0; ch < n; ch++) {
    const s = clamp(buf.getChannelData(ch)[i], -1, 1);
    v.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7FFF, true); off += 2;
  }
  return new Blob([ab], { type: "audio/wav" });
}

function mergeBuffers(ctx, bufs) {
  if (!bufs.length) return null;
  const sr = bufs[0].sampleRate, n = bufs[0].numberOfChannels;
  const total = bufs.reduce((s, b) => s + b.length, 0);
  const out = ctx.createBuffer(n, total, sr);
  let off = 0;
  for (const b of bufs) { for (let ch = 0; ch < n; ch++) out.getChannelData(ch).set(b.getChannelData(ch), off); off += b.length; }
  return out;
}

function bufferFromChannels(ctx, channelData, sr) {
  const channels = channelData?.length || 1;
  const length = channelData?.[0]?.length || 0;
  const b = ctx.createBuffer(channels, length, sr);
  for (let ch = 0; ch < channels; ch++) b.copyToChannel(channelData[ch], ch);
  return b;
}

function mixToMono(channelData) {
  if (!channelData?.length) return new Float32Array(0);
  if (channelData.length === 1) return channelData[0].slice();
  const len = channelData[0].length;
  const mixed = new Float32Array(len);
  for (let ch = 0; ch < channelData.length; ch++) {
    const src = channelData[ch];
    for (let i = 0; i < len; i++) mixed[i] += src[i];
  }
  for (let i = 0; i < len; i++) mixed[i] /= channelData.length;
  return mixed;
}

function sliceChannels(channelData, start, end) {
  return channelData.map((channel) => channel.slice(start, end));
}

function concatChannels(...parts) {
  const channels = parts[0]?.length || 0;
  return Array.from({ length: channels }, (_, ch) => {
    const total = parts.reduce((sum, part) => sum + (part[ch]?.length || 0), 0);
    const merged = new Float32Array(total);
    let offset = 0;
    parts.forEach((part) => {
      const chunk = part[ch];
      if (!chunk?.length) return;
      merged.set(chunk, offset);
      offset += chunk.length;
    });
    return merged;
  });
}

function cloneSourceRanges(ranges = []) {
  return ranges.map((range) => ({ ...range }));
}

function normalizeSourceRanges(ranges = []) {
  const merged = [];
  ranges
    .filter((range) => range && range.end > range.start)
    .sort((a, b) => a.start - b.start)
    .forEach((range) => {
      const last = merged[merged.length - 1];
      if (last && range.start <= last.end) {
        last.end = Math.max(last.end, range.end);
      } else {
        merged.push({ ...range });
      }
    });
  return merged;
}

function sliceSourceRanges(ranges, start, end) {
  const out = [];
  let cursor = 0;
  for (const range of ranges || []) {
    const rangeLength = range.end - range.start;
    const overlapStart = Math.max(start, cursor);
    const overlapEnd = Math.min(end, cursor + rangeLength);
    if (overlapEnd > overlapStart) {
      out.push({
        start: range.start + (overlapStart - cursor),
        end: range.start + (overlapEnd - cursor),
      });
    }
    cursor += rangeLength;
    if (cursor >= end) break;
  }
  return normalizeSourceRanges(out);
}

function applySegmentData(segment, updates) {
  const sourceRanges = normalizeSourceRanges(updates.sourceRanges ?? segment.sourceRanges ?? []);
  const firstRange = sourceRanges[0];
  const lastRange = sourceRanges[sourceRanges.length - 1];
  return {
    ...segment,
    ...updates,
    sourceRanges,
    origStart: firstRange?.start ?? segment.origStart,
    origEnd: lastRange?.end ?? segment.origEnd,
  };
}

function cloneSegments(segments) {
  return segments.map((segment) => ({
    ...segment,
    channelData: segment.channelData.slice(),
    channels: segment.channels.map((channel) => channel.slice()),
    sourceRanges: cloneSourceRanges(segment.sourceRanges),
  }));
}

function buildTimelineSegments(segments) {
  let cursor = 0;
  return segments.map((segment) => {
    const length = segment.channelData.length;
    const timelineStart = cursor;
    const timelineEnd = timelineStart + length;
    cursor = timelineEnd;
    return { ...segment, timelineStart, timelineEnd };
  });
}

function mergeWaveformData(segments) {
  const total = segments.reduce((sum, segment) => sum + segment.channelData.length, 0);
  const merged = new Float32Array(total);
  let offset = 0;
  segments.forEach((segment) => {
    merged.set(segment.channelData, offset);
    offset += segment.channelData.length;
  });
  return merged;
}

async function getOriginalSampleRate(file) {
  try {
    const { parseBlob } = await import("music-metadata");
    const metadata = await parseBlob(file);
    return metadata.format.sampleRate || null;
  } catch {
    return null;
  }
}

async function resampleAudioBuffer(source, targetSampleRate) {
  if (!targetSampleRate || source.sampleRate === targetSampleRate) return source;
  const frameCount = Math.ceil(source.duration * targetSampleRate);
  const offlineCtx = new OfflineAudioContext(source.numberOfChannels, frameCount, targetSampleRate);
  const src = offlineCtx.createBufferSource();
  src.buffer = source;
  src.connect(offlineCtx.destination);
  src.start(0);
  return offlineCtx.startRendering();
}

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

function normalizeDownloadBaseName(fileName) {
  const raw = (fileName || "audio").replace(/\.[^.]+$/, "");
  return raw.replace(/[\\/:*?"<>|]+/g, "_") || "audio";
}

function useResizeVersion(containerRef) {
  const [resizeVersion, setResizeVersion] = useState(0);

  useEffect(() => {
    if (!containerRef.current || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setResizeVersion((v) => v + 1));
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, [containerRef]);

  return resizeVersion;
}

const fmtLong = (sec) => { const m = Math.floor(sec / 60); const s = (sec % 60).toFixed(2); return `${m}:${s.padStart(5, "0")}`; };

/* ═══════════════════════════════════════════
   WAVEFORM DRAWING
   ═══════════════════════════════════════════ */
function drawDetailWave(canvas, data, color, progress, selStart, selEnd) {
  if (!canvas || !data) return;
  const c = canvas.getContext("2d");
  const W = canvas.width, H = canvas.height;
  c.clearRect(0, 0, W, H);

  // selection highlight
  if (selStart != null && selEnd != null && selStart !== selEnd) {
    const x1 = Math.min(selStart, selEnd) * W;
    const x2 = Math.max(selStart, selEnd) * W;
    c.fillStyle = "rgba(232,197,71,0.15)";
    c.fillRect(x1, 0, x2 - x1, H);
    // borders
    c.strokeStyle = "rgba(232,197,71,0.6)";
    c.lineWidth = 1;
    c.beginPath(); c.moveTo(x1, 0); c.lineTo(x1, H); c.stroke();
    c.beginPath(); c.moveTo(x2, 0); c.lineTo(x2, H); c.stroke();
  }

  const step = Math.max(1, Math.floor(data.length / (W / 2)));
  const mid = H / 2;
  c.beginPath();
  for (let x = 0; x < W; x++) {
    const idx = Math.floor((x / W) * data.length);
    let mn = 1, mx = -1;
    for (let j = 0; j < step; j++) { const v = data[idx + j] || 0; if (v < mn) mn = v; if (v > mx) mx = v; }
    c.moveTo(x, mid - mx * mid * 0.85);
    c.lineTo(x, mid - mn * mid * 0.85);
  }
  c.strokeStyle = color;
  c.lineWidth = 1;
  c.stroke();

  if (progress > 0 && progress <= 1) {
    const px = progress * W;
    c.strokeStyle = "#fff"; c.lineWidth = 1.5;
    c.beginPath(); c.moveTo(px, 0); c.lineTo(px, H); c.stroke();
  }
}

function drawMiniWave(canvas, data, color, progress) {
  if (!canvas || !data) return;
  const c = canvas.getContext("2d");
  const W = canvas.width, H = canvas.height;
  c.clearRect(0, 0, W, H);
  const step = Math.max(1, Math.floor(data.length / (W / 2)));
  const mid = H / 2;
  c.beginPath();
  for (let x = 0; x < W; x++) {
    const idx = Math.floor((x / W) * data.length);
    let mn = 1, mx = -1;
    for (let j = 0; j < step; j++) { const v = data[idx + j] || 0; if (v < mn) mn = v; if (v > mx) mx = v; }
    c.moveTo(x, mid - mx * mid * 0.85);
    c.lineTo(x, mid - mn * mid * 0.85);
  }
  c.strokeStyle = color; c.lineWidth = 1; c.stroke();
  if (progress > 0 && progress <= 1) {
    c.strokeStyle = "#fff"; c.lineWidth = 1.5;
    c.beginPath(); c.moveTo(progress * W, 0); c.lineTo(progress * W, H); c.stroke();
  }
}

function drawOverviewWave(canvas, data, segments, totalSamples, activeIdx) {
  if (!canvas || !data) return;
  const c = canvas.getContext("2d");
  const W = canvas.width, H = canvas.height;
  c.clearRect(0, 0, W, H);
  c.strokeStyle = "rgba(255,255,255,0.04)"; c.lineWidth = 0.5;
  for (let i = 0; i < 10; i++) { const x = (i / 10) * W; c.beginPath(); c.moveTo(x, 0); c.lineTo(x, H); c.stroke(); }
  c.beginPath(); c.moveTo(0, H / 2); c.lineTo(W, H / 2); c.stroke();
  if (segments[activeIdx]) {
    const s = segments[activeIdx];
    const x1 = (s.timelineStart / totalSamples) * W, x2 = (s.timelineEnd / totalSamples) * W;
    c.fillStyle = "rgba(232,197,71,0.12)"; c.fillRect(x1, 0, x2 - x1, H);
    c.strokeStyle = "rgba(232,197,71,0.5)"; c.lineWidth = 1; c.strokeRect(x1, 0, x2 - x1, H);
  }
  const step = Math.max(1, Math.floor(data.length / W));
  const mid = H / 2;
  c.beginPath();
  for (let x = 0; x < W; x++) {
    const idx = Math.floor((x / W) * data.length);
    let mn = 1, mx = -1;
    for (let j = 0; j < step; j++) { const v = data[idx + j] || 0; if (v < mn) mn = v; if (v > mx) mx = v; }
    c.moveTo(x, mid - mx * mid * 0.9); c.lineTo(x, mid - mn * mid * 0.9);
  }
  c.strokeStyle = "rgba(255,255,255,0.35)"; c.lineWidth = 1; c.stroke();
  segments.forEach((seg) => {
    const x1 = (seg.timelineStart / totalSamples) * W, x2 = (seg.timelineEnd / totalSamples) * W;
    const color = seg.status === "accepted" ? "#e8c547" : seg.status === "rejected" ? "#ff4f5e" : "rgba(255,255,255,0.15)";
    c.fillStyle = color; c.fillRect(x1, 0, Math.max(x2 - x1, 2), 3);
  });
}

/* ═══════════════════════════════════════════
   COMPONENTS
   ═══════════════════════════════════════════ */
function DetailWaveform({ data, color, progress, selStart, selEnd, onDragStart, onDragMove, onDragEnd }) {
  const ref = useRef(null);
  const containerRef = useRef(null);
  const activePointerIdRef = useRef(null);
  const resizeVersion = useResizeVersion(containerRef);

  useEffect(() => {
    const cvs = ref.current; if (!cvs || !data) return;
    const pr = cvs.parentElement.getBoundingClientRect();
    cvs.width = pr.width * 2; cvs.height = pr.height * 2;
    cvs.style.width = pr.width + "px"; cvs.style.height = pr.height + "px";
    drawDetailWave(cvs, data, color, progress, selStart, selEnd);
  }, [data, color, progress, selStart, selEnd, resizeVersion]);

  const getRatio = (e) => {
    if (!containerRef.current) return 0;
    const r = containerRef.current.getBoundingClientRect();
    return clamp((e.clientX - r.left) / r.width, 0, 1);
  };

  const handlePointerDown = (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    activePointerIdRef.current = e.pointerId;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    onDragStart(getRatio(e));
  };

  const handlePointerMove = (e) => {
    if (activePointerIdRef.current !== e.pointerId) return;
    e.preventDefault();
    onDragMove(getRatio(e));
  };

  const finishPointerDrag = (e) => {
    if (activePointerIdRef.current !== e.pointerId) return;
    e.preventDefault();
    onDragEnd(getRatio(e));
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    activePointerIdRef.current = null;
  };

  return (
    <div ref={containerRef}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={finishPointerDrag}
      onPointerCancel={finishPointerDrag}
      style={{ width: "100%", height: "100%", cursor: "crosshair", userSelect: "none", position: "relative", touchAction: "none" }}>
      <canvas ref={ref} style={{ display: "block", width: "100%", height: "100%", pointerEvents: "none" }} />
    </div>
  );
}

function MiniWaveform({ data, color, progress, style }) {
  const ref = useRef(null);
  const containerRef = useRef(null);
  const resizeVersion = useResizeVersion(containerRef);
  useEffect(() => {
    const cvs = ref.current; if (!cvs || !data) return;
    const pr = cvs.parentElement.getBoundingClientRect();
    cvs.width = pr.width * 2; cvs.height = pr.height * 2;
    cvs.style.width = pr.width + "px"; cvs.style.height = pr.height + "px";
    drawMiniWave(cvs, data, color, progress);
  }, [data, color, progress, resizeVersion]);
  return <div ref={containerRef} style={{ width: "100%", height: "100%", ...style }}><canvas ref={ref} style={{ display: "block", width: "100%", height: "100%" }} /></div>;
}

function OverviewWaveform({ data, segments, totalSamples, activeIdx, onClickPosition }) {
  const ref = useRef(null);
  const containerRef = useRef(null);
  const resizeVersion = useResizeVersion(containerRef);
  useEffect(() => {
    const cvs = ref.current; if (!cvs || !data) return;
    const pr = cvs.parentElement.getBoundingClientRect();
    cvs.width = pr.width * 2; cvs.height = pr.height * 2;
    cvs.style.width = pr.width + "px"; cvs.style.height = pr.height + "px";
    drawOverviewWave(cvs, data, segments, totalSamples, activeIdx);
  }, [data, segments, totalSamples, activeIdx, resizeVersion]);
  return (
    <div ref={containerRef} onClick={e => { if (!containerRef.current || !onClickPosition) return; const r = containerRef.current.getBoundingClientRect(); onClickPosition((e.clientX - r.left) / r.width); }}
      style={{ width: "100%", height: "100%", cursor: "crosshair" }}>
      <canvas ref={ref} style={{ display: "block", width: "100%", height: "100%" }} />
    </div>
  );
}

const FILTERS = ["all", "pending", "accepted", "rejected"];
const FILTER_LABELS = { all: "すべて", pending: "未選択", accepted: "採用", rejected: "不採用" };

/* ═══════════════════════════════════════════
   MAIN APP
   ═══════════════════════════════════════════ */
export default function App() {
  const [audioBuffer, setAudioBuffer] = useState(null);
  const [fileName, setFileName] = useState("");
  const [segments, setSegments] = useState([]);
  const [activeIdx, setActiveIdx] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [playProgress, setPlayProgress] = useState(0);
  const [loading, setLoading] = useState(false);
  const [threshold, setThreshold] = useState(0.015);
  const [minSilence, setMinSilence] = useState(0.3);
  const [minSegment, setMinSegment] = useState(0.5);
  const [showSettings, setShowSettings] = useState(false);
  const [filter, setFilter] = useState("all");
  const [autoPlay, setAutoPlay] = useState(true);
  const [toast, setToast] = useState(null);
  const [undoStack, setUndoStack] = useState([]);
  const [dragOver, setDragOver] = useState(false);
  const [zipDownloading, setZipDownloading] = useState(false);
  // Selection state for cut editing (ratios 0-1)
  const [selStart, setSelStart] = useState(null);
  const [selEnd, setSelEnd] = useState(null);
  const isDraggingRef = useRef(false);

  const audioCtxRef = useRef(null);
  const sourceRef = useRef(null);
  const animRef = useRef(null);
  const playStartRef = useRef(0);
  const playDurRef = useRef(0);
  const fileInputRef = useRef(null);
  const toastTimer = useRef(null);
  const autoPlayTimerRef = useRef(null);

  const getCtx = () => { if (!audioCtxRef.current) audioCtxRef.current = new (window.AudioContext || window.webkitAudioContext)(); return audioCtxRef.current; };

  const clearPendingAutoPlay = useCallback(() => {
    if (autoPlayTimerRef.current) {
      clearTimeout(autoPlayTimerRef.current);
      autoPlayTimerRef.current = null;
    }
  }, []);

  const showToast = useCallback((msg, type = "info") => {
    clearTimeout(toastTimer.current);
    setToast({ msg, type });
    toastTimer.current = setTimeout(() => setToast(null), 1800);
  }, []);

  const filteredIndices = useMemo(() => {
    if (filter === "all") return segments.map((_, i) => i);
    return segments.reduce((acc, s, i) => { if (s.status === filter) acc.push(i); return acc; }, []);
  }, [segments, filter]);

  const downloadBaseName = useMemo(() => normalizeDownloadBaseName(fileName), [fileName]);
  const timelineSegments = useMemo(() => buildTimelineSegments(segments), [segments]);
  const overviewData = useMemo(() => mergeWaveformData(segments), [segments]);
  const overviewTotalSamples = timelineSegments.at(-1)?.timelineEnd || 0;

  const stopPlay = useCallback(() => {
    clearPendingAutoPlay();
    if (sourceRef.current) { try { sourceRef.current.stop(); } catch (e) { } sourceRef.current = null; }
    if (animRef.current) cancelAnimationFrame(animRef.current);
    setPlaying(false); setPlayProgress(0);
  }, [clearPendingAutoPlay]);

  const clearSelection = useCallback(() => {
    setSelStart(null); setSelEnd(null); isDraggingRef.current = false;
  }, []);

  const playSegment = useCallback((idx) => {
    stopPlay();
    const seg = segments[idx]; if (!seg) return;
    const ctx = getCtx();
    const b = bufferFromChannels(ctx, seg.channels, seg.sampleRate);
    const src = ctx.createBufferSource();
    src.buffer = b; src.connect(ctx.destination); src.start();
    sourceRef.current = src; setPlaying(true);
    playStartRef.current = ctx.currentTime; playDurRef.current = b.duration;
    const tick = () => {
      const el = ctx.currentTime - playStartRef.current;
      setPlayProgress(clamp(el / playDurRef.current, 0, 1));
      if (el < playDurRef.current) animRef.current = requestAnimationFrame(tick);
      else { setPlaying(false); setPlayProgress(0); }
    };
    animRef.current = requestAnimationFrame(tick);
    src.onended = () => { setPlaying(false); setPlayProgress(0); };
  }, [segments, stopPlay]);

  // Play only the selected region
  const playSelection = useCallback(() => {
    if (selStart == null || selEnd == null) return;
    stopPlay();
    const seg = segments[activeIdx]; if (!seg) return;
    const ctx = getCtx();
    const lo = Math.floor(Math.min(selStart, selEnd) * seg.channelData.length);
    const hi = Math.floor(Math.max(selStart, selEnd) * seg.channelData.length);
    if (hi - lo < 100) return;
    const b = bufferFromChannels(ctx, sliceChannels(seg.channels, lo, hi), seg.sampleRate);
    const src = ctx.createBufferSource();
    src.buffer = b; src.connect(ctx.destination); src.start();
    sourceRef.current = src; setPlaying(true);
    playStartRef.current = ctx.currentTime; playDurRef.current = b.duration;
    const tick = () => {
      const el = ctx.currentTime - playStartRef.current;
      const localProg = clamp(el / playDurRef.current, 0, 1);
      const globalLo = Math.min(selStart, selEnd);
      const globalHi = Math.max(selStart, selEnd);
      setPlayProgress(globalLo + localProg * (globalHi - globalLo));
      if (el < playDurRef.current) animRef.current = requestAnimationFrame(tick);
      else { setPlaying(false); setPlayProgress(0); }
    };
    animRef.current = requestAnimationFrame(tick);
    src.onended = () => { setPlaying(false); setPlayProgress(0); };
  }, [segments, activeIdx, selStart, selEnd, stopPlay]);

  const processAudio = useCallback((decoded) => {
    const mixed = mixToMono(Array.from({ length: decoded.numberOfChannels }, (_, ch) => decoded.getChannelData(ch)));
    const rawSegs = detectSilentRegions(mixed, decoded.sampleRate, { threshold, minSilenceDuration: minSilence, minSegmentDuration: minSegment });
    let idCounter = 0;
    const segs = rawSegs.map((s) => ({
      id: idCounter++, origStart: s.start, origEnd: s.end,
      channelData: mixed.slice(s.start, s.end),
      channels: Array.from({ length: decoded.numberOfChannels }, (_, ch) => decoded.getChannelData(ch).slice(s.start, s.end)),
      sourceRanges: [{ start: s.start, end: s.end }],
      sampleRate: decoded.sampleRate,
      status: "pending",
    }));
    setSegments(segs); setActiveIdx(0); setUndoStack([]); clearSelection();
  }, [threshold, minSilence, minSegment, clearSelection]);

  const handleFile = useCallback(async (file) => {
    stopPlay(); setLoading(true); setFileName(file.name);
    try {
      const ctx = getCtx();
      const [sourceSampleRate, fileBuffer] = await Promise.all([
        getOriginalSampleRate(file),
        file.arrayBuffer(),
      ]);
      let decoded = await ctx.decodeAudioData(fileBuffer);
      if (sourceSampleRate) decoded = await resampleAudioBuffer(decoded, sourceSampleRate);
      setAudioBuffer(decoded);
      processAudio(decoded);
    } catch (e) { alert("読み込み失敗: " + e.message); }
    setLoading(false);
  }, [processAudio, stopPlay]);

  const reanalyze = useCallback(() => { if (audioBuffer) { stopPlay(); processAudio(audioBuffer); showToast("再分析完了"); } }, [audioBuffer, processAudio, stopPlay, showToast]);

  const pushUndo = useCallback(() => {
    setUndoStack(prev => [...prev.slice(-30), cloneSegments(segments)]);
  }, [segments]);

  const undo = useCallback(() => {
    setUndoStack(prev => {
      if (!prev.length) return prev;
      const last = prev[prev.length - 1]; setSegments(last); showToast("元に戻しました"); clearSelection();
      return prev.slice(0, -1);
    });
  }, [showToast, clearSelection]);

  const setStatus = useCallback((idx, status) => {
    pushUndo();
    setSegments(prev => prev.map((s, i) => i === idx ? { ...s, status } : s));
    showToast(`#${idx + 1} → ${status === "accepted" ? "採用" : "不採用"}`, status === "accepted" ? "accept" : "reject");
  }, [pushUndo, showToast]);

  /* ─── CUT EDITING ─── */
  const hasSelection = selStart != null && selEnd != null && Math.abs(selStart - selEnd) > 0.005;

  const cutSelection = useCallback(() => {
    if (!hasSelection) return;
    const seg = segments[activeIdx]; if (!seg) return;
    pushUndo(); stopPlay();
    const lo = Math.floor(Math.min(selStart, selEnd) * seg.channelData.length);
    const hi = Math.floor(Math.max(selStart, selEnd) * seg.channelData.length);
    const before = seg.channelData.slice(0, lo);
    const after = seg.channelData.slice(hi);
    const nextChannels = concatChannels(sliceChannels(seg.channels, 0, lo), sliceChannels(seg.channels, hi, seg.channelData.length));
    const nextSourceRanges = normalizeSourceRanges([
      ...sliceSourceRanges(seg.sourceRanges, 0, lo),
      ...sliceSourceRanges(seg.sourceRanges, hi, seg.channelData.length),
    ]);
    const newData = new Float32Array(before.length + after.length);
    newData.set(before, 0); newData.set(after, before.length);
    if (newData.length < 100) { showToast("セグメントが短すぎます", "reject"); return; }
    setSegments(prev => prev.map((s, i) => i === activeIdx
      ? applySegmentData(s, { channelData: newData, channels: nextChannels, sourceRanges: nextSourceRanges })
      : s));
    clearSelection();
    showToast("選択範囲をカット");
  }, [hasSelection, segments, activeIdx, selStart, selEnd, pushUndo, stopPlay, clearSelection, showToast]);

  const keepSelection = useCallback(() => {
    if (!hasSelection) return;
    const seg = segments[activeIdx]; if (!seg) return;
    pushUndo(); stopPlay();
    const lo = Math.floor(Math.min(selStart, selEnd) * seg.channelData.length);
    const hi = Math.floor(Math.max(selStart, selEnd) * seg.channelData.length);
    const newData = seg.channelData.slice(lo, hi);
    const nextChannels = sliceChannels(seg.channels, lo, hi);
    const nextSourceRanges = sliceSourceRanges(seg.sourceRanges, lo, hi);
    if (newData.length < 100) { showToast("セグメントが短すぎます", "reject"); return; }
    setSegments(prev => prev.map((s, i) => i === activeIdx
      ? applySegmentData(s, { channelData: newData, channels: nextChannels, sourceRanges: nextSourceRanges })
      : s));
    clearSelection();
    showToast("選択範囲のみ保持");
  }, [hasSelection, segments, activeIdx, selStart, selEnd, pushUndo, stopPlay, clearSelection, showToast]);

  const splitAtCursor = useCallback(() => {
    // split at selection start (or midpoint if range)
    const seg = segments[activeIdx]; if (!seg) return;
    const ratio = selStart != null ? (selEnd != null ? (Math.min(selStart, selEnd) + Math.max(selStart, selEnd)) / 2 : selStart) : 0.5;
    const splitPoint = Math.floor(ratio * seg.channelData.length);
    if (splitPoint < 100 || seg.channelData.length - splitPoint < 100) { showToast("分割点が端すぎます", "reject"); return; }
    pushUndo(); stopPlay();
    const part1 = seg.channelData.slice(0, splitPoint);
    const part2 = seg.channelData.slice(splitPoint);
    const part1Channels = sliceChannels(seg.channels, 0, splitPoint);
    const part2Channels = sliceChannels(seg.channels, splitPoint, seg.channelData.length);
    const part1SourceRanges = sliceSourceRanges(seg.sourceRanges, 0, splitPoint);
    const part2SourceRanges = sliceSourceRanges(seg.sourceRanges, splitPoint, seg.channelData.length);
    const newSegs = [...segments];
    const seg1 = applySegmentData(seg, { id: Date.now(), channelData: part1, channels: part1Channels, sourceRanges: part1SourceRanges });
    const seg2 = applySegmentData(seg, { id: Date.now() + 1, channelData: part2, channels: part2Channels, sourceRanges: part2SourceRanges });
    newSegs.splice(activeIdx, 1, seg1, seg2);
    setSegments(newSegs);
    clearSelection();
    showToast("セグメントを分割");
  }, [segments, activeIdx, selStart, selEnd, pushUndo, stopPlay, clearSelection, showToast]);

  const nextFiltered = useCallback((from) => { const c = filteredIndices.indexOf(from); return c < filteredIndices.length - 1 ? filteredIndices[c + 1] : from; }, [filteredIndices]);
  const prevFiltered = useCallback((from) => { const c = filteredIndices.indexOf(from); return c > 0 ? filteredIndices[c - 1] : from; }, [filteredIndices]);

  const navigateTo = useCallback((idx) => {
    clearPendingAutoPlay();
    setActiveIdx(idx); clearSelection();
    if (autoPlay) {
      autoPlayTimerRef.current = setTimeout(() => {
        autoPlayTimerRef.current = null;
        playSegment(idx);
      }, 50);
    }
  }, [autoPlay, playSegment, clearSelection, clearPendingAutoPlay]);

  const downloadSeg = useCallback((idx) => {
    const seg = segments[idx]; if (!seg) return;
    const ctx = getCtx();
    const b = bufferFromChannels(ctx, seg.channels, seg.sampleRate);
    const blob = encodeWav(b);
    triggerDownload(blob, `${downloadBaseName}_seg_${String(idx + 1).padStart(3, "0")}.wav`);
    showToast(`#${idx + 1} ダウンロード`);
  }, [segments, downloadBaseName, showToast]);

  const downloadMerged = useCallback(() => {
    const ctx = getCtx();
    const acc = segments.filter(s => s.status === "accepted");
    if (!acc.length) { showToast("採用セグメントなし", "reject"); return; }
    const bufs = acc.map(seg => bufferFromChannels(ctx, seg.channels, seg.sampleRate));
    const blob = encodeWav(mergeBuffers(ctx, bufs));
    triggerDownload(blob, `${downloadBaseName}_accepted.wav`);
    showToast("結合DL完了");
  }, [segments, downloadBaseName, showToast]);

  const downloadIndividual = useCallback(async () => {
    if (zipDownloading) return;
    const ctx = getCtx();
    const acc = segments.filter(s => s.status === "accepted");
    if (!acc.length) { showToast("採用セグメントなし", "reject"); return; }
    setZipDownloading(true);
    showToast("ZIP作成中...");
    try {
      const [{ default: JSZip }] = await Promise.all([import("jszip")]);
      const zip = new JSZip();
      for (let i = 0; i < acc.length; i++) {
        const seg = acc[i];
        const blob = encodeWav(bufferFromChannels(ctx, seg.channels, seg.sampleRate));
        zip.file(`${downloadBaseName}_${String(i + 1).padStart(3, "0")}.wav`, blob);
        if ((i + 1) % 10 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
      }
      const zipBlob = await zip.generateAsync({
        type: "blob",
        compression: "DEFLATE",
        compressionOptions: { level: 6 },
        streamFiles: true,
      });
      triggerDownload(zipBlob, `${downloadBaseName}_accepted_segments.zip`);
      showToast(`${acc.length}ファイルをZIP保存`);
    } catch (e) {
      showToast(`ZIP作成失敗: ${e.message}`, "reject");
    } finally {
      setZipDownloading(false);
    }
  }, [segments, downloadBaseName, zipDownloading, showToast]);

  const overviewClick = useCallback((ratio) => {
    if (!timelineSegments.length || !overviewTotalSamples) return;
    const pos = ratio * overviewTotalSamples;
    let closest = 0, minD = Infinity;
    timelineSegments.forEach((seg, i) => { const d = Math.abs((seg.timelineStart + seg.timelineEnd) / 2 - pos); if (d < minD) { minD = d; closest = i; } });
    navigateTo(closest);
  }, [timelineSegments, overviewTotalSamples, navigateTo]);

  // Keyboard
  useEffect(() => {
    const h = (e) => {
      if (!segments.length) return;
      if (!(e.target instanceof Element)) return;
      if (e.target.closest("input, textarea, select, button, a, [role='button'], [contenteditable='true']")) return;
      const key = e.key.toLowerCase();
      if (key === " ") {
        e.preventDefault();
        if (playing) stopPlay();
        else if (hasSelection) playSelection();
        else playSegment(activeIdx);
      }
      else if (key === "a" && !e.ctrlKey && !e.metaKey) { e.preventDefault(); setStatus(activeIdx, "accepted"); const n = nextFiltered(activeIdx); if (n !== activeIdx) navigateTo(n); }
      else if (key === "r") { e.preventDefault(); setStatus(activeIdx, "rejected"); const n = nextFiltered(activeIdx); if (n !== activeIdx) navigateTo(n); }
      else if (key === "arrowdown" || key === "j") { e.preventDefault(); navigateTo(nextFiltered(activeIdx)); }
      else if (key === "arrowup" || key === "k") { e.preventDefault(); navigateTo(prevFiltered(activeIdx)); }
      else if (key === "d") { e.preventDefault(); downloadSeg(activeIdx); }
      else if (key === "x") { e.preventDefault(); cutSelection(); }
      else if (key === "c" && !e.ctrlKey && !e.metaKey) { e.preventDefault(); keepSelection(); }
      else if (key === "s" && !e.ctrlKey && !e.metaKey) { e.preventDefault(); splitAtCursor(); }
      else if (key === "escape") { e.preventDefault(); clearSelection(); }
      else if (key === "z" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); undo(); }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [segments, activeIdx, playing, stopPlay, playSegment, playSelection, setStatus, downloadSeg, navigateTo, nextFiltered, prevFiltered, undo, cutSelection, keepSelection, splitAtCursor, clearSelection, hasSelection]);

  useEffect(() => {
    const el = document.getElementById(`seg-${activeIdx}`);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [activeIdx]);

  useEffect(() => {
    if (!autoPlay) clearPendingAutoPlay();
  }, [autoPlay, clearPendingAutoPlay]);

  useEffect(() => () => {
    clearPendingAutoPlay();
    if (toastTimer.current) clearTimeout(toastTimer.current);
  }, [clearPendingAutoPlay]);

  const stats = useMemo(() => {
    const a = segments.filter(s => s.status === "accepted").length;
    const r = segments.filter(s => s.status === "rejected").length;
    const p = segments.length - a - r;
    const dur = segments.filter(s => s.status === "accepted")
      .reduce((sum, s) => sum + s.channelData.length / s.sampleRate, 0);
    const progress = segments.length ? ((a + r) / segments.length) * 100 : 0;
    return { a, r, p, dur, progress };
  }, [segments]);

  const hasAudio = !!audioBuffer;
  const activeSeg = segments[activeIdx];
  const activeDur = activeSeg ? activeSeg.channelData.length / activeSeg.sampleRate : 0;
  const selDur = (hasSelection && activeSeg) ? Math.abs(selEnd - selStart) * activeSeg.channelData.length / activeSeg.sampleRate : 0;

  const css = `
    @import url('https://fonts.googleapis.com/css2?family=DM+Mono:wght@300;400;500&family=Outfit:wght@300;400;500;600;700&display=swap');
    * { box-sizing: border-box; margin: 0; padding: 0; }
    ::-webkit-scrollbar { width: 5px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.07); border-radius: 3px; }
    @keyframes fadeIn { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: translateY(0); } }
    @keyframes slideToast { from { opacity: 0; transform: translateY(12px) scale(0.96); } to { opacity: 1; transform: translateY(0) scale(1); } }
    @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.4; } }
    @keyframes selPulse { 0%,100% { border-color: rgba(232,197,71,0.5); } 50% { border-color: rgba(232,197,71,0.2); } }
  `;

  const Btn = ({ children, onClick, style: s, ...rest }) => (
    <button onClick={onClick} style={{
      border: "none", cursor: "pointer", fontFamily: "'DM Mono', monospace",
      transition: "all 0.12s", outline: "none", ...s
    }} {...rest}>{children}</button>
  );

  return (
    <>
      <style>{css}</style>
      <div style={{ minHeight: "100vh", height: "100dvh", overflow: "auto", background: "#111118", fontFamily: "'DM Mono', monospace", display: "flex", flexDirection: "column", color: "#d8d8e0" }}>

        {/* ━━━ HEADER ━━━ */}
        <header style={{
          padding: "0 20px", height: 48, display: "flex", alignItems: "center", gap: 12,
          borderBottom: "1px solid rgba(255,255,255,0.06)", background: "#16161f", flexShrink: 0,
        }}>
          <div style={{
            width: 26, height: 26, borderRadius: 5, display: "flex", alignItems: "center", justifyContent: "center",
            background: "linear-gradient(135deg, #e8c547, #c49520)", fontSize: 12, fontWeight: 700, color: "#111"
          }}>R</div>
          <div style={{ fontSize: 13, fontWeight: 600, letterSpacing: -0.3, fontFamily: "'Outfit', sans-serif" }}>RVC Audio Prep</div>
          {hasAudio && (
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginLeft: 12 }}>
              <span style={{ fontSize: 10, color: "#55556a" }}>{fileName}</span>
              <span style={{ fontSize: 9, color: "#55556a" }}>·</span>
              <span style={{ fontSize: 10, color: "#55556a" }}>{fmtLong(audioBuffer.duration)}</span>
              <span style={{ fontSize: 9, color: "#55556a" }}>·</span>
              <span style={{ fontSize: 10, color: "#55556a" }}>{audioBuffer.sampleRate}Hz</span>
            </div>
          )}
          <div style={{ flex: 1 }} />
          {hasAudio && (
            <div onClick={() => setAutoPlay(!autoPlay)} style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
              <div style={{
                width: 26, height: 14, borderRadius: 7, background: autoPlay ? "#e8c547" : "#1c1c27",
                border: "1px solid rgba(255,255,255,0.1)", position: "relative", transition: "all 0.2s",
              }}>
                <div style={{ width: 10, height: 10, borderRadius: 5, background: "#fff", position: "absolute", top: 1, left: autoPlay ? 13 : 1, transition: "left 0.2s" }} />
              </div>
              <span style={{ fontSize: 10, color: "#8888a0" }}>自動再生</span>
            </div>
          )}
          <Btn onClick={() => setShowSettings(!showSettings)} style={{
            background: showSettings ? "#1c1c27" : "transparent", color: "#8888a0",
            border: "1px solid rgba(255,255,255,0.06)", borderRadius: 5, padding: "4px 8px", fontSize: 10,
          }}>⚙</Btn>
        </header>

        {/* ━━━ SETTINGS ━━━ */}
        {showSettings && (
          <div style={{
            padding: "8px 20px", background: "#16161f", borderBottom: "1px solid rgba(255,255,255,0.06)",
            display: "flex", gap: 20, alignItems: "center", flexWrap: "wrap", animation: "fadeIn 0.15s ease",
          }}>
            {[
              ["無音閾値", threshold, setThreshold, 0.005, 0.1, 0.001, v => v.toFixed(3)],
              ["最小無音長(s)", minSilence, setMinSilence, 0.1, 2, 0.05, v => v.toFixed(2)],
              ["最小セグメント長(s)", minSegment, setMinSegment, 0.2, 5, 0.1, v => v.toFixed(1)],
            ].map(([label, val, set, min, max, step, f]) => (
              <label key={label} style={{ fontSize: 10, color: "#55556a", display: "flex", alignItems: "center", gap: 5 }}>
                {label}
                <input type="range" min={min} max={max} step={step} value={val}
                  onChange={e => set(+e.target.value)} style={{ width: 80, accentColor: "#e8c547" }} />
                <span style={{ color: "#e8c547", minWidth: 32, fontSize: 10 }}>{f(val)}</span>
              </label>
            ))}
            <Btn onClick={reanalyze} style={{
              background: "rgba(232,197,71,0.08)", border: "1px solid #e8c547", color: "#e8c547",
              borderRadius: 5, padding: "3px 10px", fontSize: 10,
            }}>再分析</Btn>
          </div>
        )}

        {/* ━━━ MAIN ━━━ */}
        {!hasAudio ? (
          <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", padding: 40 }}
            onDrop={e => { e.preventDefault(); setDragOver(false); e.dataTransfer?.files?.[0] && handleFile(e.dataTransfer.files[0]); }}
            onDragOver={e => { e.preventDefault(); setDragOver(true); }} onDragLeave={() => setDragOver(false)}>
            <div onClick={() => fileInputRef.current?.click()} style={{
              width: "100%", maxWidth: 480, padding: "56px 36px", textAlign: "center",
              border: `1.5px dashed ${dragOver ? "#e8c547" : "rgba(255,255,255,0.08)"}`,
              borderRadius: 16, cursor: "pointer", background: dragOver ? "rgba(232,197,71,0.04)" : "transparent", transition: "all 0.3s",
            }}>
              <div style={{ fontSize: 40, marginBottom: 16, opacity: 0.5 }}>⟡</div>
              <div style={{ fontFamily: "'Outfit', sans-serif", fontSize: 18, fontWeight: 600, marginBottom: 6 }}>音声ファイルをドロップ</div>
              <div style={{ fontSize: 11, color: "#55556a", lineHeight: 1.6 }}>クリックでも選択可 — MP3 / WAV / OGG / FLAC</div>
              <div style={{ marginTop: 20, display: "flex", justifyContent: "center", gap: 5, flexWrap: "wrap" }}>
                {["Space 再生", "A 採用", "R 不採用", "J/K 移動", "X カット", "S 分割"].map(s => (
                  <span key={s} style={{ fontSize: 9, color: "#55556a", background: "#1c1c27", padding: "2px 7px", borderRadius: 3, border: "1px solid rgba(255,255,255,0.06)" }}>{s}</span>
                ))}
              </div>
              <input ref={fileInputRef} type="file" accept="audio/*" style={{ display: "none" }}
                onChange={e => {
                  const nextFile = e.target.files?.[0];
                  e.target.value = "";
                  if (nextFile) handleFile(nextFile);
                }} />
            </div>
          </div>
        ) : loading ? (
          <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center" }}>
            <div style={{ fontSize: 13, color: "#e8c547", animation: "pulse 1.5s infinite", fontFamily: "'Outfit', sans-serif" }}>解析中...</div>
          </div>
        ) : (
          <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>

            <div style={{ position: "sticky", top: 0, zIndex: 20, background: "#14141c", boxShadow: "0 10px 28px rgba(0,0,0,0.28)" }}>
              {/* ─── OVERVIEW ─── */}
              <div style={{ height: 58, flexShrink: 0, borderBottom: "1px solid rgba(255,255,255,0.06)", background: "#16161f", padding: "4px 20px" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 2 }}>
                  <span style={{ fontSize: 8, color: "#55556a", textTransform: "uppercase", letterSpacing: 1.5, fontWeight: 500 }}>Overview</span>
                  <div style={{ flex: 1, height: 1, background: "rgba(255,255,255,0.04)" }} />
                  <div style={{ width: 80, height: 2, background: "#111118", borderRadius: 1, overflow: "hidden" }}>
                    <div style={{ width: `${stats.progress}%`, height: "100%", background: "#e8c547", borderRadius: 1, transition: "width 0.3s" }} />
                  </div>
                  <span style={{ fontSize: 8, color: "#55556a" }}>{Math.round(stats.progress)}%</span>
                </div>
                <div style={{ height: 36, borderRadius: 5, overflow: "hidden", background: "rgba(0,0,0,0.3)" }}>
                  <OverviewWaveform data={overviewData} segments={timelineSegments} totalSamples={overviewTotalSamples} activeIdx={activeIdx} onClickPosition={overviewClick} />
                </div>
              </div>

              {/* ─── ACTIVE DETAIL + CUT EDITOR ─── */}
              {activeSeg && (
                <div style={{ flexShrink: 0, borderBottom: "1px solid rgba(255,255,255,0.06)", background: "#14141c", padding: "10px 20px" }}>
                  {/* Info row */}
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                    <span style={{ fontSize: 11, fontWeight: 500, fontFamily: "'Outfit', sans-serif" }}>#{activeIdx + 1}</span>
                    <span style={{
                      fontSize: 9, padding: "1px 7px", borderRadius: 3, fontWeight: 500,
                      background: activeSeg.status === "accepted" ? "rgba(232,197,71,0.08)" : activeSeg.status === "rejected" ? "rgba(255,82,102,0.08)" : "#1c1c27",
                      color: activeSeg.status === "accepted" ? "#e8c547" : activeSeg.status === "rejected" ? "#ff5266" : "#55556a",
                      border: `1px solid ${activeSeg.status === "accepted" ? "rgba(232,197,71,0.3)" : activeSeg.status === "rejected" ? "rgba(255,82,102,0.3)" : "rgba(255,255,255,0.06)"}`,
                    }}>{activeSeg.status === "accepted" ? "採用" : activeSeg.status === "rejected" ? "不採用" : "未選択"}</span>
                    <span style={{ fontSize: 9, color: "#55556a" }}>{activeDur.toFixed(2)}s</span>

                    {hasSelection && (
                      <span style={{
                        fontSize: 9, padding: "1px 7px", borderRadius: 3,
                        background: "rgba(232,197,71,0.1)", color: "#e8c547",
                        border: "1px solid rgba(232,197,71,0.25)",
                        animation: "selPulse 2s infinite",
                      }}>
                        選択: {selDur.toFixed(2)}s
                      </span>
                    )}

                    <div style={{ flex: 1 }} />

                    <Btn onClick={() => { if (playing) stopPlay(); else if (hasSelection) playSelection(); else playSegment(activeIdx); }} style={{
                      background: playing ? "#e8c547" : "rgba(232,197,71,0.08)", color: playing ? "#111" : "#e8c547",
                      border: "1px solid rgba(232,197,71,0.4)", borderRadius: 5, padding: "3px 14px", fontSize: 10, fontWeight: 500,
                    }}>{playing ? "■ 停止" : hasSelection ? "▶ 選択再生" : "▶ 再生"}</Btn>
                    <Btn onClick={() => setStatus(activeIdx, "accepted")} style={{
                      background: "rgba(232,197,71,0.08)", color: "#e8c547",
                      border: "1px solid rgba(232,197,71,0.25)", borderRadius: 5, padding: "3px 12px", fontSize: 10,
                    }}>✓ 採用 [A]</Btn>
                    <Btn onClick={() => setStatus(activeIdx, "rejected")} style={{
                      background: "rgba(255,82,102,0.08)", color: "#ff5266",
                      border: "1px solid rgba(255,82,102,0.25)", borderRadius: 5, padding: "3px 12px", fontSize: 10,
                    }}>✗ 不採用 [R]</Btn>
                  </div>

                  {/* Detail waveform with drag-to-select */}
                  <div style={{ height: 80, borderRadius: 6, overflow: "hidden", background: "rgba(0,0,0,0.35)", border: "1px solid rgba(255,255,255,0.04)" }}>
                    <DetailWaveform
                      data={activeSeg.channelData}
                      color={activeSeg.status === "accepted" ? "#e8c547" : activeSeg.status === "rejected" ? "#ff5266" : "rgba(255,255,255,0.4)"}
                      progress={playProgress}
                      selStart={selStart} selEnd={selEnd}
                      onDragStart={(r) => { stopPlay(); setSelStart(r); setSelEnd(r); isDraggingRef.current = true; }}
                      onDragMove={(r) => { if (isDraggingRef.current) setSelEnd(r); }}
                      onDragEnd={(r) => { setSelEnd(r); isDraggingRef.current = false; }}
                    />
                  </div>

                  {/* Cut editing toolbar */}
                  <div style={{ display: "flex", gap: 5, marginTop: 6, alignItems: "center" }}>
                    <span style={{ fontSize: 8, color: "#55556a", textTransform: "uppercase", letterSpacing: 1, marginRight: 4 }}>編集</span>

                    <Btn onClick={cutSelection} style={{
                      background: hasSelection ? "rgba(255,82,102,0.1)" : "#1c1c27",
                      color: hasSelection ? "#ff5266" : "#44445a",
                      border: `1px solid ${hasSelection ? "rgba(255,82,102,0.3)" : "rgba(255,255,255,0.06)"}`,
                      borderRadius: 5, padding: "3px 10px", fontSize: 10,
                      opacity: hasSelection ? 1 : 0.4,
                    }} disabled={!hasSelection}>✂ カット [X]</Btn>

                    <Btn onClick={keepSelection} style={{
                      background: hasSelection ? "rgba(232,197,71,0.1)" : "#1c1c27",
                      color: hasSelection ? "#e8c547" : "#44445a",
                      border: `1px solid ${hasSelection ? "rgba(232,197,71,0.3)" : "rgba(255,255,255,0.06)"}`,
                      borderRadius: 5, padding: "3px 10px", fontSize: 10,
                      opacity: hasSelection ? 1 : 0.4,
                    }} disabled={!hasSelection}>⊏ 残す [C]</Btn>

                    <Btn onClick={splitAtCursor} style={{
                      background: "rgba(130,160,255,0.08)", color: "#8ea0ff",
                      border: "1px solid rgba(130,160,255,0.25)", borderRadius: 5, padding: "3px 10px", fontSize: 10,
                    }}>⫼ 分割 [S]</Btn>

                    {hasSelection && (
                      <Btn onClick={clearSelection} style={{
                        background: "transparent", color: "#55556a",
                        border: "1px solid rgba(255,255,255,0.06)", borderRadius: 5, padding: "3px 8px", fontSize: 9,
                      }}>選択解除 [Esc]</Btn>
                    )}

                    <div style={{ flex: 1 }} />
                    <span style={{ fontSize: 9, color: "#44445a" }}>ドラッグで範囲選択</span>
                  </div>
                </div>
              )}
            </div>

            {/* ─── LIST + SIDEBAR ─── */}
            <div style={{ flex: 1, display: "flex", overflow: "hidden" }}>
              {/* List */}
              <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
                <div style={{
                  padding: "6px 16px", display: "flex", alignItems: "center", gap: 4,
                  borderBottom: "1px solid rgba(255,255,255,0.06)", flexShrink: 0,
                }}>
                  {FILTERS.map(f => (
                    <button key={f} onClick={() => setFilter(f)} style={{
                      padding: "3px 10px", borderRadius: 5, fontSize: 10,
                      background: filter === f ? "#1c1c27" : "transparent",
                      color: filter === f ? "#d8d8e0" : "#55556a",
                      border: filter === f ? "1px solid rgba(255,255,255,0.1)" : "1px solid transparent",
                      cursor: "pointer", fontFamily: "'DM Mono', monospace", transition: "all 0.15s",
                    }}>
                      {FILTER_LABELS[f]}
                      {f !== "all" && <span style={{ marginLeft: 3, opacity: 0.5 }}>{f === "pending" ? stats.p : f === "accepted" ? stats.a : stats.r}</span>}
                    </button>
                  ))}
                  <div style={{ flex: 1 }} />
                  <Btn onClick={() => fileInputRef.current?.click()} style={{
                    background: "transparent", color: "#55556a", border: "1px solid rgba(255,255,255,0.06)",
                    borderRadius: 5, padding: "3px 8px", fontSize: 9,
                  }}>ファイル変更</Btn>
                  <input ref={fileInputRef} type="file" accept="audio/*" style={{ display: "none" }}
                    onChange={e => {
                      const nextFile = e.target.files?.[0];
                      e.target.value = "";
                      if (nextFile) handleFile(nextFile);
                    }} />
                </div>
                <div style={{ flex: 1, overflow: "auto", padding: "6px 10px" }}>
                  {filteredIndices.length === 0 ? (
                    <div style={{ padding: 40, textAlign: "center", color: "#55556a", fontSize: 11 }}>該当セグメントなし</div>
                  ) : filteredIndices.map(idx => {
                    const seg = segments[idx];
                    const isActive = idx === activeIdx;
                    const dur = (seg.channelData.length / seg.sampleRate).toFixed(1);
                    const sc = seg.status === "accepted" ? "#e8c547" : seg.status === "rejected" ? "#ff5266" : "#55556a";
                    return (
                      <div key={seg.id} id={`seg-${idx}`} onClick={() => navigateTo(idx)}
                        style={{
                          display: "flex", alignItems: "center", gap: 8, padding: "5px 10px", borderRadius: 6,
                          cursor: "pointer", marginBottom: 1, transition: "all 0.1s",
                          background: isActive ? "rgba(232,197,71,0.05)" : "transparent",
                          borderLeft: isActive ? "2px solid #e8c547" : "2px solid transparent",
                        }}
                        onMouseEnter={e => { if (!isActive) e.currentTarget.style.background = "rgba(255,255,255,0.02)"; }}
                        onMouseLeave={e => { if (!isActive) e.currentTarget.style.background = "transparent"; }}>
                        <div style={{ width: 6, height: 6, borderRadius: "50%", background: sc, flexShrink: 0 }} />
                        <span style={{ fontSize: 9, color: isActive ? "#d8d8e0" : "#55556a", minWidth: 20, fontWeight: isActive ? 500 : 400 }}>
                          {String(idx + 1).padStart(2, "0")}
                        </span>
                        <div style={{ flex: 1, height: 24, borderRadius: 3, overflow: "hidden", background: "rgba(0,0,0,0.25)" }}>
                          <MiniWaveform data={seg.channelData}
                            color={seg.status === "accepted" ? "rgba(232,197,71,0.55)" : seg.status === "rejected" ? "rgba(255,82,102,0.35)" : "rgba(255,255,255,0.18)"}
                            progress={isActive ? playProgress : 0} />
                        </div>
                        <span style={{ fontSize: 9, color: "#55556a", minWidth: 30, textAlign: "right" }}>{dur}s</span>
                        <Btn onClick={e => { e.stopPropagation(); downloadSeg(idx); }} style={{
                          background: "transparent", border: "none", color: "#55556a", fontSize: 11, padding: "1px 3px", opacity: 0.6,
                        }} title="DL" aria-label={`セグメント ${idx + 1} をダウンロード`}>↓</Btn>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* ─── SIDEBAR ─── */}
              <div style={{
                width: 200, flexShrink: 0, borderLeft: "1px solid rgba(255,255,255,0.06)",
                padding: "10px 12px", overflow: "auto", display: "flex", flexDirection: "column", gap: 12, background: "#16161f",
              }}>
                <div>
                  <div style={{ fontSize: 8, color: "#55556a", textTransform: "uppercase", letterSpacing: 1.5, marginBottom: 6, fontWeight: 500 }}>統計</div>
                  <div style={{ display: "flex", gap: 3, marginBottom: 6 }}>
                    {[[stats.a, "採用", "#e8c547", "rgba(232,197,71,0.08)"],
                      [stats.r, "不採用", "#ff5266", "rgba(255,82,102,0.08)"],
                      [stats.p, "未選択", "#55556a", "#1c1c27"]].map(([n, l, c, bg]) => (
                      <div key={l} style={{ flex: 1, background: bg, borderRadius: 5, padding: "5px 3px", textAlign: "center" }}>
                        <div style={{ fontSize: 16, fontWeight: 600, color: c, fontFamily: "'Outfit', sans-serif" }}>{n}</div>
                        <div style={{ fontSize: 7, color: c, opacity: 0.7, textTransform: "uppercase", letterSpacing: 0.5 }}>{l}</div>
                      </div>
                    ))}
                  </div>
                  <div style={{ fontSize: 9, color: "#8888a0", textAlign: "center" }}>
                    合計 <span style={{ color: "#e8c547", fontWeight: 500 }}>{fmtLong(stats.dur)}</span>
                  </div>
                </div>

                <div style={{ height: 1, background: "rgba(255,255,255,0.04)" }} />

                <div>
                  <div style={{ fontSize: 8, color: "#55556a", textTransform: "uppercase", letterSpacing: 1.5, marginBottom: 6, fontWeight: 500 }}>ダウンロード</div>
                  <Btn onClick={downloadMerged} style={{
                    width: "100%", background: "#e8c547", color: "#111", borderRadius: 6, padding: "7px",
                    fontSize: 10, fontWeight: 600, marginBottom: 4,
                  }}>採用を結合DL</Btn>
                  <Btn onClick={downloadIndividual} style={{
                    width: "100%", background: zipDownloading ? "#1c1c27" : "rgba(232,197,71,0.08)", color: zipDownloading ? "#8888a0" : "#e8c547",
                    border: "1px solid rgba(232,197,71,0.25)", borderRadius: 6, padding: "5px", fontSize: 10, marginBottom: 4,
                    opacity: zipDownloading ? 0.8 : 1,
                  }} disabled={zipDownloading}>{zipDownloading ? "ZIP作成中..." : "採用をZIP DL"}</Btn>
                  <Btn onClick={() => downloadSeg(activeIdx)} style={{
                    width: "100%", background: "#1c1c27", color: "#8888a0",
                    border: "1px solid rgba(255,255,255,0.06)", borderRadius: 6, padding: "5px", fontSize: 9,
                  }}>選択中DL [D]</Btn>
                </div>

                <div style={{ height: 1, background: "rgba(255,255,255,0.04)" }} />

                <div>
                  <div style={{ fontSize: 8, color: "#55556a", textTransform: "uppercase", letterSpacing: 1.5, marginBottom: 6, fontWeight: 500 }}>一括操作</div>
                  <div style={{ display: "flex", gap: 3 }}>
                    <Btn onClick={() => { pushUndo(); setSegments(p => p.map(s => ({ ...s, status: "accepted" }))); showToast("すべて採用"); }} style={{
                      flex: 1, background: "rgba(232,197,71,0.08)", color: "#e8c547",
                      border: "1px solid rgba(232,197,71,0.2)", borderRadius: 5, padding: "4px 0", fontSize: 9,
                    }}>全採用</Btn>
                    <Btn onClick={() => { pushUndo(); setSegments(p => p.map(s => ({ ...s, status: "pending" }))); showToast("リセット"); }} style={{
                      flex: 1, background: "#1c1c27", color: "#55556a",
                      border: "1px solid rgba(255,255,255,0.06)", borderRadius: 5, padding: "4px 0", fontSize: 9,
                    }}>リセット</Btn>
                  </div>
                  <Btn onClick={undo} style={{
                    width: "100%", background: "transparent", color: "#55556a",
                    border: "1px solid rgba(255,255,255,0.06)", borderRadius: 5, padding: "4px 0", fontSize: 9, marginTop: 3,
                  }}>↩ Undo [⌘Z]</Btn>
                </div>

                <div style={{ height: 1, background: "rgba(255,255,255,0.04)" }} />

                <div>
                  <div style={{ fontSize: 8, color: "#55556a", textTransform: "uppercase", letterSpacing: 1.5, marginBottom: 6, fontWeight: 500 }}>ショートカット</div>
                  {[
                    ["Space", "再生/停止"],
                    ["A", "採用→次"],
                    ["R", "不採用→次"],
                    ["↑ K", "前へ"],
                    ["↓ J", "次へ"],
                    ["X", "選択カット"],
                    ["C", "選択のみ残す"],
                    ["S", "分割"],
                    ["Esc", "選択解除"],
                    ["D", "DL"],
                    ["⌘Z", "Undo"],
                  ].map(([k, d]) => (
                    <div key={k} style={{ display: "flex", alignItems: "center", gap: 5, marginBottom: 3 }}>
                      <kbd style={{
                        background: "#111118", border: "1px solid rgba(255,255,255,0.06)", borderRadius: 3,
                        padding: "1px 5px", fontSize: 8, color: "#8888a0", minWidth: 32, textAlign: "center",
                      }}>{k}</kbd>
                      <span style={{ fontSize: 9, color: "#55556a" }}>{d}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ━━━ TOAST ━━━ */}
        {toast && (
          <div style={{
            position: "fixed", bottom: 20, left: "50%", transform: "translateX(-50%)",
            background: toast.type === "accept" ? "#e8c547" : toast.type === "reject" ? "#ff5266" : "#1c1c27",
            color: toast.type === "accept" ? "#111" : toast.type === "reject" ? "#fff" : "#d8d8e0",
            padding: "6px 18px", borderRadius: 7, fontSize: 11, fontWeight: 500,
            animation: "slideToast 0.15s ease", boxShadow: "0 6px 24px rgba(0,0,0,0.5)",
            fontFamily: "'DM Mono', monospace", zIndex: 100,
            border: `1px solid ${toast.type === "accept" ? "#e8c547" : toast.type === "reject" ? "#ff5266" : "rgba(255,255,255,0.1)"}`,
          }}>{toast.msg}</div>
        )}
      </div>
    </>
  );
}
