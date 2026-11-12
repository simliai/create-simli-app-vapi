"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Vapi from "@vapi-ai/web";
import { LogLevel, SimliClient } from "simli-client";
import VideoBox from "./Components/VideoBox";
import cn from "./utils/TailwindMergeAndClsx";
import IconSparkleLoader from "@/media/IconSparkleLoader";

// Vapi's PUBLIC key is designed to be used in the browser. Never put the
// private key here: it can access your whole Vapi organization.
const VAPI_PUBLIC_KEY = process.env.NEXT_PUBLIC_VAPI_PUBLIC_KEY?.trim() ?? "";
const VAPI_ASSISTANT_ID = process.env.NEXT_PUBLIC_VAPI_ASSISTANT_ID?.trim() ?? "";

// --- Audio routing ----------------------------------------------------------
// Simli takes PCM16 little-endian mono @ 16 kHz. We tap Vapi's assistant track
// with an AudioContext running at 16 kHz, so the browser resamples for us.
//
// Why buffer instead of client.listenToMediastreamTrack(track)? Streaming the
// live track gave noticeably worse lip-sync, so audio is gated on Vapi's
// speech-start / speech-end events and sent in buffered chunks:
//   1. the first INITIAL_BUFFER_SAMPLES of an utterance go out at once with
//      sendAudioDataImmediate, so Simli starts with a full second of context;
//   2. the rest follows in CHUNK_SAMPLES-sized sendAudioData calls;
//   3. whatever is left is flushed shortly after speech-end.
// Because audio arrives in bursts, the token route sets handleSilence: true.
// Trade-off: about 1 s of extra latency before the avatar starts talking.
const SAMPLE_RATE = 16000;
const INITIAL_BUFFER_SAMPLES = SAMPLE_RATE; // 1 s
const CHUNK_SAMPLES = 4800; // 300 ms (9600 bytes)
// Vapi fires speech-start on the first loud audio frame (its level observer
// runs every 100 ms), so keep a little audio from before it to avoid clipping
// the first syllable. Only Simli's audio is heard, so dropped audio is lost.
const PREROLL_SAMPLES = 4800; // 300 ms
// Vapi fires speech-end ~1 s after the last loud frame; keep the gate open a
// little longer to catch trailing audio.
const SPEECH_END_GRACE_MS = 500;

// Converts Float32 frames to PCM16 and posts ~40 ms chunks to the main thread.
const TAP_WORKLET = `
class VapiTap extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Int16Array(640); this.n = 0; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) {
      for (let i = 0; i < ch.length; i++) {
        const s = Math.max(-1, Math.min(1, ch[i]));
        this.buf[this.n++] = s < 0 ? Math.round(s * 32768) : Math.round(s * 32767);
        if (this.n === this.buf.length) { this.port.postMessage(this.buf.slice(0)); this.n = 0; }
      }
    }
    return true;
  }
}
registerProcessor("vapi-tap", VapiTap);
`;

// Vapi errors that don't end the call.
const NON_FATAL_VAPI_ERRORS = new Set([
  "audio-observer-setup-error",
  "audio-processing-setup-error",
  "audio-processor-recovery-error",
  "audio-start-failed", // Vapi's own player failed; we read the track from Daily instead
]);

type Status = "idle" | "starting" | "live";

type Pipeline = {
  ctx: AudioContext;
  track: MediaStreamTrack;
  // Keeps the remote WebRTC track flowing into Web Audio (Chrome needs the
  // stream attached to a media element). Muted: only Simli's audio is heard.
  sink: HTMLAudioElement;
};

const toBytes = (a: Int16Array) => new Uint8Array(a.buffer, a.byteOffset, a.byteLength);

function concat(parts: Int16Array[]): Int16Array {
  let length = 0;
  for (const p of parts) length += p.length;
  const out = new Int16Array(length);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

async function errorText(res: Response) {
  try {
    const j = await res.json();
    return j.error ?? JSON.stringify(j);
  } catch {
    return res.statusText;
  }
}

// Human-readable hints for common Simli failures.
function explainSimliError(raw: string): string {
  const m = raw.toUpperCase();
  if (m.includes("401") || m.includes("UNAUTHORIZED")) return `${raw}: check SIMLI_API_KEY on the server.`;
  if (m.includes("INVALID_FACE_ID")) return `${raw}: the face ID doesn't exist. Use a preset or copy it from the Simli dashboard.`;
  if (m.includes("FACE_NOT_ALLOWED")) return `${raw}: that face belongs to another Simli account.`;
  if (m.includes("422")) return `${raw}: invalid video framing (must be 1:1, 16:9 or 9:16, each side >= 512).`;
  if (m.includes("429") || m.includes("RATE")) return `${raw}: too many Simli sessions running. Stop others or upgrade the plan.`;
  if (m.includes("TOO MANY RETRY")) return `${raw}: the browser can't reach Simli's media servers (firewall or VPN?).`;
  return raw;
}

// Vapi emits { type, error: { message, ... } } objects on "error".
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function explainVapiError(e: any): string {
  const type: string = typeof e?.type === "string" ? e.type : "";
  const inner = e?.error ?? e;
  const detail: string =
    inner?.message ?? inner?.errorMsg ?? inner?.error?.message ?? (typeof inner === "string" ? inner : JSON.stringify(inner));
  if (type.startsWith("microphone-preflight")) return `Microphone unavailable or blocked (${detail}). Allow microphone access and try again.`;
  const m = `${detail}`.toUpperCase();
  if (m.includes("401") || m.includes("UNAUTHORIZED") || m.includes("INVALID KEY"))
    return `Vapi: ${detail}. Check NEXT_PUBLIC_VAPI_PUBLIC_KEY (it must be the PUBLIC key).`;
  if (m.includes("403")) return `Vapi: ${detail}. Check the public key's allowed origins and allowed assistants in the Vapi dashboard.`;
  return `Vapi error${type ? ` (${type})` : ""}: ${detail}`;
}

export default function SimliVapi({ onStart, onClose }: { onStart: () => void; onClose: () => void }) {
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState("");

  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const simliRef = useRef<SimliClient | null>(null);
  const vapiRef = useRef<Vapi | null>(null);
  const pipelineRef = useRef<Pipeline | null>(null);
  const trackPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Bumped whenever an interaction ends, so late callbacks from it are ignored.
  const sessionRef = useRef(0);

  // Gate / buffering state, only touched from audio callbacks and Vapi events.
  const gateOpenRef = useRef(false);
  const initialSentRef = useRef(false);
  const pendingRef = useRef<Int16Array[]>([]);
  const pendingLenRef = useRef(0);
  const prerollRef = useRef<Int16Array[]>([]);
  const prerollLenRef = useRef(0);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  const resetBuffers = useCallback(() => {
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
    closeTimerRef.current = null;
    gateOpenRef.current = false;
    initialSentRef.current = false;
    pendingRef.current = [];
    pendingLenRef.current = 0;
    prerollRef.current = [];
    prerollLenRef.current = 0;
  }, []);

  const teardownPipeline = useCallback(() => {
    if (trackPollRef.current) clearInterval(trackPollRef.current);
    trackPollRef.current = null;
    const p = pipelineRef.current;
    pipelineRef.current = null;
    if (p) {
      p.sink.srcObject = null;
      p.sink.remove();
      void p.ctx.close().catch(() => {});
    }
  }, []);

  /** Ends both sides. Idempotent: several events can report the same failure. */
  const cleanup = useCallback(() => {
    sessionRef.current += 1;
    teardownPipeline();
    resetBuffers();
    const vapi = vapiRef.current;
    vapiRef.current = null;
    if (vapi) {
      vapi.removeAllListeners();
      void vapi.stop().catch(() => {});
    }
    const simli = simliRef.current;
    simliRef.current = null;
    if (simli) void simli.stop().catch(() => {});
  }, [resetBuffers, teardownPipeline]);

  /** Ends the interaction and returns the UI to its idle state. */
  const end = useCallback(
    (message?: string) => {
      cleanup();
      setStatus("idle");
      setError(message ?? "");
      onCloseRef.current();
    },
    [cleanup],
  );

  // --- Buffered forwarding to Simli ---------------------------------------

  const takePending = (n: number): Int16Array => {
    const all = concat(pendingRef.current);
    const head = all.slice(0, n);
    const rest = all.slice(n);
    pendingRef.current = rest.length ? [rest] : [];
    pendingLenRef.current = rest.length;
    return head;
  };

  const forward = (samples: Int16Array) => {
    const simli = simliRef.current;
    if (!simli) return;

    if (!gateOpenRef.current) {
      // Assistant is quiet: keep only the most recent PREROLL_SAMPLES.
      prerollRef.current.push(samples);
      prerollLenRef.current += samples.length;
      while (prerollLenRef.current - prerollRef.current[0].length >= PREROLL_SAMPLES) {
        prerollLenRef.current -= prerollRef.current.shift()!.length;
      }
      return;
    }

    pendingRef.current.push(samples);
    pendingLenRef.current += samples.length;

    if (!initialSentRef.current) {
      if (pendingLenRef.current < INITIAL_BUFFER_SAMPLES) return;
      simli.sendAudioDataImmediate(toBytes(takePending(INITIAL_BUFFER_SAMPLES)));
      initialSentRef.current = true;
    }
    while (pendingLenRef.current >= CHUNK_SAMPLES) {
      simli.sendAudioData(toBytes(takePending(CHUNK_SAMPLES)));
    }
  };

  const flush = () => {
    const simli = simliRef.current;
    if (simli && pendingLenRef.current > 0) {
      const rest = takePending(pendingLenRef.current);
      if (!initialSentRef.current) simli.sendAudioDataImmediate(toBytes(rest)); // utterance shorter than 1 s
      else simli.sendAudioData(toBytes(rest));
    }
    pendingRef.current = [];
    pendingLenRef.current = 0;
  };

  const onSpeechStart = () => {
    if (closeTimerRef.current) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
    if (gateOpenRef.current) return; // resumed within the grace window
    gateOpenRef.current = true;
    initialSentRef.current = false;
    pendingRef.current = prerollRef.current;
    pendingLenRef.current = prerollLenRef.current;
    prerollRef.current = [];
    prerollLenRef.current = 0;
  };

  const onSpeechEnd = () => {
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
    closeTimerRef.current = setTimeout(() => {
      closeTimerRef.current = null;
      gateOpenRef.current = false;
      flush();
    }, SPEECH_END_GRACE_MS);
  };

  const onUserInterrupted = () => {
    // Drop what the avatar hasn't said yet, and what we haven't sent yet.
    simliRef.current?.ClearBuffer();
    pendingRef.current = [];
    pendingLenRef.current = 0;
    initialSentRef.current = false;
  };

  /** Taps the assistant's remote audio track and feeds it to Simli. */
  const attachTrack = async (track: MediaStreamTrack) => {
    if (pipelineRef.current?.track === track) return;
    teardownPipeline(); // a renegotiated call can hand us a new track
    resetBuffers();

    const stream = new MediaStream([track]);
    const sink = document.createElement("audio");
    sink.muted = true;
    sink.srcObject = stream;
    void sink.play().catch(() => {});

    const ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
    pipelineRef.current = { ctx, track, sink };
    const url = URL.createObjectURL(new Blob([TAP_WORKLET], { type: "application/javascript" }));
    try {
      await ctx.audioWorklet.addModule(url);
    } finally {
      URL.revokeObjectURL(url);
    }
    if (pipelineRef.current?.ctx !== ctx) return; // ended while loading
    // No outputs: a pure sink, so nothing from Vapi reaches the speakers.
    const node = new AudioWorkletNode(ctx, "vapi-tap", { numberOfInputs: 1, numberOfOutputs: 0 });
    node.port.onmessage = (e: MessageEvent<Int16Array>) => forward(e.data);
    ctx.createMediaStreamSource(stream).connect(node);
    if (ctx.state === "suspended") await ctx.resume();
  };

  /** Fallback when Vapi's own player couldn't start: read the track from Daily. */
  const pollDailyForTrack = (vapi: Vapi) => {
    if (trackPollRef.current) return;
    let tries = 0;
    trackPollRef.current = setInterval(() => {
      if (vapiRef.current !== vapi || pipelineRef.current) {
        if (trackPollRef.current) clearInterval(trackPollRef.current);
        trackPollRef.current = null;
        return;
      }
      const participants = vapi.getDailyCallObject()?.participants();
      const speaker = participants && Object.values(participants).find((p) => p.user_name === "Vapi Speaker");
      const track = speaker?.tracks?.audio?.persistentTrack ?? speaker?.tracks?.audio?.track;
      if (track) {
        void attachTrack(track).catch((err) => end(`Could not route the assistant's audio to the avatar: ${err}`));
      } else if (++tries > 100) {
        end("Could not find the assistant's audio track.");
      }
    }, 100);
  };

  // --- Start / stop ---------------------------------------------------------

  async function start() {
    // Runs from a click, so the browser allows audio playback.
    if (!VAPI_PUBLIC_KEY || !VAPI_ASSISTANT_ID) {
      setError(
        "Missing NEXT_PUBLIC_VAPI_PUBLIC_KEY or NEXT_PUBLIC_VAPI_ASSISTANT_ID. Copy .env.example to .env.local, fill them in and restart the dev server. (Older versions of this repo called them NEXT_PUBLIC_VAPI_API_KEY and NEXT_PUBLIC_VAPI_AGENT_ID.)",
      );
      return;
    }
    if (!videoRef.current || !audioRef.current) return;
    setError("");
    setStatus("starting");
    onStart();
    const session = ++sessionRef.current;

    try {
      // 1. Simli first: the avatar must be on screen before the assistant speaks.
      const tokenRes = await fetch("/api/simli-token", { method: "POST", signal: AbortSignal.timeout(15_000) });
      if (!tokenRes.ok) {
        throw new Error(explainSimliError(`Simli token route failed (${tokenRes.status}): ${await errorText(tokenRes)}`));
      }
      const { session_token } = (await tokenRes.json().catch(() => ({}))) as { session_token?: string };
      if (!session_token) throw new Error("The token route returned no session token.");

      const simli = new SimliClient(session_token, videoRef.current, audioRef.current, null, LogLevel.ERROR);
      simliRef.current = simli;
      simli.on("error", (detail) => {
        if (simliRef.current === simli) end(explainSimliError(`Simli error: ${detail}`));
      });
      simli.on("stop", () => {
        // maxSessionLength / maxIdleTime reached, or the connection dropped.
        if (simliRef.current === simli) end("The avatar session ended (session or idle time limit reached).");
      });
      simli.on("destination", (info) => console.info("Simli destination (session id):", info));
      await simli.start(); // resolves when the first video frame is on screen
      if (sessionRef.current !== session) return; // stopped while starting

      // 2. Then Vapi. Its own playback is silenced; the avatar speaks instead.
      const vapi = new Vapi(VAPI_PUBLIC_KEY);
      vapiRef.current = vapi;
      vapi.setVolume(0); // applied before Vapi's player starts, so it never plays audibly
      vapi.on("audio", (player) => {
        player.muted = true;
        const track = (player.srcObject as MediaStream | null)?.getAudioTracks()[0];
        if (track) void attachTrack(track).catch((err) => end(`Could not route the assistant's audio to the avatar: ${err}`));
      });
      vapi.on("speech-start", onSpeechStart);
      vapi.on("speech-end", onSpeechEnd);
      vapi.on("message", (msg) => {
        if (msg?.type === "user-interrupted") onUserInterrupted();
      });
      vapi.on("call-end", () => {
        if (vapiRef.current === vapi) end();
      });
      vapi.on("error", (e) => {
        if (vapiRef.current !== vapi) return;
        if (NON_FATAL_VAPI_ERRORS.has(e?.type)) {
          console.warn("Vapi:", e);
          if (e?.type === "audio-start-failed") pollDailyForTrack(vapi);
          return;
        }
        end(explainVapiError(e));
      });

      const call = await vapi.start(VAPI_ASSISTANT_ID);
      if (sessionRef.current !== session) {
        // Ended while start() was in flight. In @vapi-ai/web 3.1, a stop() issued
        // before the call object exists doesn't cancel the join, so the call (and
        // the mic) would stay up: stop it again now that it exists.
        void vapi.stop().catch(() => {});
        return;
      }
      if (!call) {
        // start() resolves null on failure; the "error" handler normally reports why.
        void vapi.stop().catch(() => {});
        end("Vapi could not start the call. Check the assistant ID and public key.");
        return;
      }
      setStatus("live");
    } catch (e) {
      // Ignore if this attempt was already ended (e.g. by Simli's "error" event, which
      // fires for the same failure that rejects start()).
      if (sessionRef.current === session) end(explainSimliError(e instanceof Error ? e.message : String(e)));
    }
  }

  // Stop everything on unmount and when the tab is closed, so sessions don't keep billing.
  useEffect(() => {
    const onHide = () => cleanup();
    window.addEventListener("pagehide", onHide);
    return () => {
      window.removeEventListener("pagehide", onHide);
      cleanup();
    };
  }, [cleanup]);

  return (
    <>
      <div className={cn("transition-all duration-300", status === "idle" ? "h-0 overflow-hidden" : "h-auto")}>
        <VideoBox video={videoRef} audio={audioRef} />
      </div>
      <div className="flex flex-col items-center">
        {status !== "live" ? (
          <button
            onClick={start}
            disabled={status === "starting"}
            className={cn(
              "w-full h-[52px] mt-4 cursor-pointer disabled:cursor-default disabled:bg-[#343434] disabled:text-white disabled:hover:rounded-[100px] bg-simliblue text-white py-3 px-6 rounded-[100px] transition-all duration-300 hover:text-black hover:bg-white hover:rounded-xs",
              "flex justify-center items-center",
            )}
          >
            {status === "starting" ? (
              <IconSparkleLoader className="h-[20px] animate-loader" />
            ) : (
              <span className="font-abc-repro-mono font-bold w-[164px]">Test Interaction</span>
            )}
          </button>
        ) : (
          <div className="flex items-center gap-4 w-full">
            <button
              onClick={() => end()}
              className="mt-4 group cursor-pointer text-white grow bg-red hover:rounded-xs hover:bg-white h-[52px] px-6 rounded-[100px] transition-all duration-300"
            >
              <span className="font-abc-repro-mono group-hover:text-black font-bold w-[164px] transition-all duration-300">
                Stop Interaction
              </span>
            </button>
          </div>
        )}
        {error && (
          <p role="alert" className="mt-4 max-w-[350px] text-center text-red">
            {error}
          </p>
        )}
      </div>
    </>
  );
}
