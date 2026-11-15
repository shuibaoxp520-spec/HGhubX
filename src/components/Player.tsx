import { Button, Input } from "./ios/controls";
import { Loader } from "./ios/effects";
import React, { useEffect, useRef, useState } from "react";
import Hls from "hls.js";
import { fmtTime, isMobile, platform, playlist } from "../api";
import { mediaErrorMessage } from "../mediaErrors";
import { mediaHost, mediaResource, observeHls, usePlayerDiagnostics } from "../playbackDiagnostics";
import { usePlaybackActivity } from "../usePlaybackActivity";
import { useProxyPlaybackRecovery } from "../useProxyPlaybackRecovery";
import { useSeekInput } from "../useSeekInput";
import PlaybackLock from "./PlaybackLock";
import { ICompress, IExpand, ILockF, IPauseF, IPlayF, IVol, IVolMute } from "../icons";

type Props = {
  src: string;              // 原始 m3u8 地址
  poster?: string;          // 已处理好的封面地址（本地协议）
  autoPlay?: boolean;
  active?: boolean;
  muted?: boolean;
  loop?: boolean;
  onEnded?: () => void;
  onPlaying?: () => void;
  onTogglePlay?: (playing: boolean) => void;
  onToggleMute?: () => void;
  controls?: boolean;
  className?: string;
  diagnosticContext?: Record<string, unknown>;
};

/** iPhone 的 WKWebView 没有元素级 Fullscreen API，只能走视频元素自己的
 *  webkitEnterFullscreen（交给系统播放器，顺带能用侧键调音量）。 */
type WebkitVideo = HTMLVideoElement & {
  webkitEnterFullscreen?: () => void;
  webkitExitFullscreen?: () => void;
  webkitDisplayingFullscreen?: boolean;
};

export default function Player({
  src, poster, autoPlay, active = true, muted = false, loop = false, onEnded, onPlaying,
  onTogglePlay, onToggleMute, controls = true, className = "", diagnosticContext = {},
}: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const recoverCountRef = useRef(0);
  const { trace, requestSeek } = usePlayerDiagnostics(videoRef, hlsRef, { view: "post_detail", ...diagnosticContext, active, resource: mediaResource(src) });
  const activity = usePlaybackActivity(videoRef, hlsRef, { active, autoPlay: !!autoPlay, src, trace });
  const proxyRecovery = useProxyPlaybackRecovery(videoRef, src, activity, trace);
  const [playing, setPlaying] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [full, setFull] = useState(false);
  const [rate, setRate] = useState(1);
  const [errMsg, setErrMsg] = useState<string>("");
  const [controlsLocked, setControlsLocked] = useState(false);
  /* 安卓 WebView 的 HTMLMediaElement.volume 可写（iOS 只读），简化版播放器
     原本没有音量状态，这里自己维护一份。volumeAvailable 用于运行时探测：
     部分 WebView 把音量完全交给系统，写进去读回来不变，就不留一个假滑块。 */
  const [volume, setVolume] = useState(1);
  const [volumeAvailable, setVolumeAvailable] = useState(true);
  /* 安卓 WebView 宿主未必实现 WebChromeClient.onShowCustomView，
     requestFullscreen 会静默失败；用 CSS 铺满视口兜底，保证点全屏一定有反应。 */
  const [cssFull, setCssFull] = useState(false);
  const seek = useSeekInput({ time, duration, enabled: active && !controlsLocked, resetKey: src,
    onInteraction: (phase, input, target, pointerTarget) => trace(`seek.input.${phase}`, { input, target, pointer_target: pointerTarget }),
    onSeek: (target, input) => {
      const video = videoRef.current;
      if (!video || !activity.isActive()) return;
      requestSeek(target, `legacy_${input}`);
      setWaiting(true);
      if (hlsRef.current) {
        try { hlsRef.current.startLoad(target); } catch { /* ignore */ }
      }
      video.currentTime = target;
      trace("seek.assigned", { target });
      setTime(video.currentTime);
    },
  });

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !src) return;
    setErrMsg("");
    setWaiting(false);
    recoverCountRef.current = 0;
    const resume = proxyRecovery.resume();
    const url = playlist(src);
    trace("source.load", { engine: Hls.isSupported() ? "hls.js" : "native", auto_play: autoPlay, resource: mediaResource(src), host: mediaHost(src) });

    if (hlsRef.current) { hlsRef.current.destroy(); hlsRef.current = null; }

    if (Hls.isSupported()) {
      const hls = new Hls({
        // 禁用从插播/内容引导 JSON 派生直连 URL 的可选功能。
        interstitialsController: undefined,
        contentSteeringController: undefined,
        enableInterstitialPlayback: false,
        // WKWebView 里 hls.js 的 worker 不稳，iOS 关掉
        enableWorker: platform !== "ios",
        // Keep the same macOS seek workaround as the shared player.
        preferManagedMediaSource: false,
        autoStartLoad: false,
        startPosition: resume?.time ?? -1,
        lowLatencyMode: false,
        maxBufferLength: 30,
        maxMaxBufferLength: 60,
        backBufferLength: 30,
        maxBufferHole: 0.5,
        nudgeOffset: 0.25,
        nudgeMaxRetry: 6,
        manifestLoadingTimeOut: 20000,
        manifestLoadingMaxRetry: 4,
        fragLoadingTimeOut: 25000,
        fragLoadingMaxRetry: 6,
        fragLoadingRetryDelay: 400,
      });
      hlsRef.current = hls;
      observeHls(hls, trace);
      hls.loadSource(url);
      hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        if (activity.isActive()) hls.startLoad(resume?.time ?? -1);
        if (autoPlay && !resume) activity.play("manifest_autoplay", true);
      });
      hls.on(Hls.Events.FRAG_BUFFERED, () => {
        recoverCountRef.current = 0;
        setErrMsg("");
      });
      hls.on(Hls.Events.ERROR, (_e, data) => {
        if (!data.fatal) {
          if (
            data.details === Hls.ErrorDetails.BUFFER_STALLED_ERROR ||
            data.details === Hls.ErrorDetails.FRAG_LOAD_ERROR
          ) {
            try { hls.startLoad(video.currentTime || -1); } catch { /* ignore */ }
          }
          return;
        }
        if (!activity.isActive()) return;
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR && recoverCountRef.current < 4) {
          recoverCountRef.current += 1;
          try { hls.startLoad(video.currentTime || -1); } catch { /* ignore */ }
          return;
        }
        if (data.type === Hls.ErrorTypes.MEDIA_ERROR && recoverCountRef.current < 4) {
          recoverCountRef.current += 1;
          try { hls.recoverMediaError(); video.play().catch(() => {}); } catch { /* ignore */ }
          return;
        }
        const detail = `${data.type}/${data.details}/${data.response?.code ?? ""}/${String(data.reason ?? "").slice(0, 80)}`;
        (window as unknown as { __hlsErr?: string }).__hlsErr = detail;
        setErrMsg(detail);
        if (!activity.isActive()) return;
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR) hls.startLoad();
        else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError();
        else { hls.destroy(); hlsRef.current = null; }
      });
    } else {
      // Safari / 部分 WebView 原生支持 HLS
      video.src = url;
      if (autoPlay && !resume) activity.play("native_autoplay", true);
    }

    return () => {
      trace("source.cleanup");
      if (hlsRef.current) { hlsRef.current.destroy(); hlsRef.current = null; }
    };
  }, [src, autoPlay, proxyRecovery.revision]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.muted = muted;
  }, [muted]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || platform !== "android") return;
    try { video.volume = volume; } catch { /* 系统接管音量，忽略 */ }
  }, [volume]);

  const changeVolume = (v: number) => {
    const video = videoRef.current;
    if (!video) return;
    try {
      video.volume = v;
      if (Math.abs(video.volume - v) > 0.02) { setVolumeAvailable(false); return; }
    } catch { setVolumeAvailable(false); return; }
    setVolume(v);
    if (muted && v > 0) onToggleMute?.();
  };

  // iOS 内联播放：部分 WKWebView 只认 HTML 属性，不认 React 的 playsInline
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.setAttribute("webkit-playsinline", "true");
  }, []);

  useEffect(() => {
    const video = videoRef.current as WebkitVideo | null;
    const onFs = () => setFull(!!document.fullscreenElement || !!video?.webkitDisplayingFullscreen);
    document.addEventListener("fullscreenchange", onFs);
    video?.addEventListener("webkitbeginfullscreen", onFs);
    video?.addEventListener("webkitendfullscreen", onFs);
    return () => {
      document.removeEventListener("fullscreenchange", onFs);
      video?.removeEventListener("webkitbeginfullscreen", onFs);
      video?.removeEventListener("webkitendfullscreen", onFs);
    };
  }, []);

  const toggle = () => {
    const video = videoRef.current;
    if (!video) return;
    trace("toggle.request");
    if (video.paused) activity.play("toggle");
    else activity.pause("toggle");
  };

  const cycleRate = () => {
    const video = videoRef.current;
    if (!video) return;
    const next = rate === 1 ? 1.25 : rate === 1.25 ? 1.5 : rate === 1.5 ? 2 : 1;
    video.playbackRate = next;
    setRate(next);
  };

  const toggleFull = () => {
    const video = videoRef.current as WebkitVideo | null;
    // iOS：交给系统播放器，顺带能用侧键调音量
    if (platform === "ios" && video && typeof video.webkitEnterFullscreen === "function") {
      if (video.webkitDisplayingFullscreen) video.webkitExitFullscreen?.();
      else video.webkitEnterFullscreen();
      return;
    }
    if (platform === "android") {
      // 元素级 Fullscreen API 在部分 Android WebView 上会静默失败（宿主没接
      // onShowCustomView），所以这里直接用 CSS 把播放器铺满视口，退出也由自己管。
      if (cssFull || document.fullscreenElement) {
        if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
        setCssFull(false);
        try { screen.orientation?.unlock?.(); } catch { /* 无方向锁 API */ }
      } else {
        setCssFull(true);
        // best-effort：能转横屏就转，Activity 锁死竖屏时静默忽略
        try { screen.orientation?.lock?.("landscape")?.catch?.(() => {}); } catch { /* ignore */ }
      }
      return;
    }
    const el = wrapRef.current;
    if (!el) return;
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else el.requestFullscreen().catch(() => {});
  };

  const pct = duration > 0 ? (seek.time / duration) * 100 : 0;
  const fullIcon = full || cssFull;

  return (
    <div ref={wrapRef}
      className={`${cssFull ? "" : "relative"} bg-black overflow-hidden group ${className}`}
      style={cssFull ? { position: "fixed", inset: 0, zIndex: 9999, width: "100%", height: "100%" } : undefined}>
      <div className="absolute inset-0" inert={controlsLocked}>
      <video
        ref={videoRef}
        poster={poster}
        playsInline
        preload="auto"
        muted={muted}
        loop={loop}
        className="w-full h-full object-contain bg-black"
        onClick={toggle}
        onPlay={() => { if (activity.isActive()) { setPlaying(true); onTogglePlay?.(true); } }}
        onPause={() => { setPlaying(false); onTogglePlay?.(false); }}
        onWaiting={() => setWaiting(true)}
        onPlaying={() => { if (activity.isActive()) { setWaiting(false); setErrMsg(""); onPlaying?.(); } }}
        onSeeked={() => setWaiting(false)}
        onTimeUpdate={(e) => setTime((e.target as HTMLVideoElement).currentTime)}
        onLoadedMetadata={(e) => setDuration((e.target as HTMLVideoElement).duration || 0)}
        onEnded={() => { if (activity.isActive()) onEnded?.(); }}
        onError={() => {
          if (hlsRef.current) return;
          setWaiting(false);
          setPlaying(false);
          setErrMsg(mediaErrorMessage(videoRef.current?.error ?? null));
        }}
      />

      {errMsg && (
        <div className="absolute left-2 top-2 z-30 max-w-[80%] rounded bg-black/70 px-2 py-1 text-[12px] leading-tight text-red-300 break-all">
          {errMsg}
        </div>
      )}

      {waiting && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <Loader className="w-9 h-9 spinner" />
        </div>
      )}

      {!playing && !waiting && (
        <Button onClick={toggle} aria-label="播放"
          className="absolute inset-0 flex items-center justify-center">
          <span className="w-16 h-16 rounded-full bg-black/45 backdrop-blur-sm flex items-center justify-center elev-2 pressable">
            <IPlayF size={26} className="text-white ml-0.5" />
          </span>
        </Button>
      )}

      {controls && (
        <div className={`player-inline-controls absolute inset-x-0 bottom-0 px-3 pb-2 pt-8 transition-opacity ${isMobile ? "opacity-100" : "opacity-0 group-hover:opacity-100"}`}>
          <Input aria-label="播放进度" type="range" {...seek.inputProps}
            className="hg-range w-full" style={{ ...seek.inputProps.style, "--fill": `${pct}%` } as React.CSSProperties} />
          <div className="flex items-center gap-3 mt-1 text-white">
            <Button onClick={toggle} aria-label={playing ? "暂停" : "播放"} className="pressable">
              {playing ? <IPauseF size={16} /> : <IPlayF size={16} />}
            </Button>
            <Button onClick={() => onToggleMute?.()} aria-label={muted ? "取消静音" : "静音"}
              title={platform === "android" && volumeAvailable ? "静音切换（音量拖动右侧滑块，或用手机侧键）" : "静音切换（音量大小请用手机侧键调节）"}
              className="pressable">
              {muted ? <IVolMute size={16} /> : <IVol size={16} />}
            </Button>
            {platform === "android" && volumeAvailable && (
              <Input aria-label="音量" type="range" min={0} max={1} step={0.05}
                value={muted ? 0 : volume} onChange={(e) => changeVolume(Number(e.target.value))}
                className="hg-range player-inline-volume"
                style={{ "--fill": `${(muted ? 0 : volume) * 100}%` } as React.CSSProperties} />
            )}
            <span className="text-[12px] tabular-nums text-white/85">{fmtTime(seek.time)} / {fmtTime(duration)}</span>
            <div className="flex-1" />
            <Button onClick={() => setControlsLocked(true)} aria-label="锁定播放控制" title="锁定播放控制" aria-pressed={false} className="pressable">
              <ILockF size={16} />
            </Button>
            <Button onClick={cycleRate} className="text-[12px] font-bold text-white/85 pressable tabular-nums">{rate}x</Button>
            <Button onClick={toggleFull} aria-label={fullIcon ? "退出全屏" : "全屏"} className="pressable">
              {fullIcon ? <ICompress size={16} /> : <IExpand size={16} />}
            </Button>
          </div>
        </div>
      )}
      </div>
      {controlsLocked && <PlaybackLock active={active} onUnlock={() => setControlsLocked(false)} />}
    </div>
  );
}
