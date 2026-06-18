import React, { use, useCallback, useEffect, useRef, useState } from "react";
import Vapi from "@vapi-ai/web";
import { generateIceServers, generateSimliSessionToken, LogLevel, SimliClient } from "simli-client";
import VideoBox from "./Components/VideoBox";
import cn from "./utils/TailwindMergeAndClsx";
import IconSparkleLoader from "@/media/IconSparkleLoader";

interface SimliVapiProps {
    simli_faceid: string;
    agentId: string; // Vapi agent ID
    onStart: () => void;
    onClose: () => void;
    showDottedFace: boolean;
}

const vapi = new Vapi(process.env.NEXT_PUBLIC_VAPI_API_KEY as string);
let simliClient: SimliClient | null = null

// Audio constants. Simli expects PCM16 little-endian mono @ 16kHz.
const SIMLI_SAMPLE_RATE = 16000;
// Chunk size (in samples) sent to SimliClient.sendAudioData — must match the
// audioBufferSize passed as the last SimliClient constructor argument.
const SIMLI_AUDIO_BUFFER_SIZE = 4800;
// On speech-start we buffer 1 second before the initial immediate playback.
const INITIAL_BUFFER_SAMPLES = SIMLI_SAMPLE_RATE; // 1 second @ 16kHz
const SimliVapi: React.FC<SimliVapiProps> = ({
    simli_faceid,
    agentId,
    onStart,
    onClose,
    showDottedFace,
}) => {
    // State management
    const [isLoading, setIsLoading] = useState(false);
    const [isAvatarVisible, setIsAvatarVisible] = useState(false);
    const [error, setError] = useState("");
    const doRunOnce = useRef(false);

    // Refs for media elements
    const videoRef = useRef<HTMLVideoElement>(null);
    const audioRef = useRef<HTMLAudioElement>(null);

    // Refs for capturing/processing the Vapi assistant audio track
    const audioContextRef = useRef<AudioContext | null>(null);
    const sourceNodeRef = useRef<MediaStreamAudioSourceNode | null>(null);
    const processorRef = useRef<ScriptProcessorNode | null>(null);
    const mediaStreamRef = useRef<MediaStream | null>(null);

    // Buffering state. We only accumulate audio while the assistant is speaking.
    const pcmBufferRef = useRef<Int16Array>(new Int16Array(0));
    const isAssistantSpeakingRef = useRef(false);
    const initialChunkSentRef = useRef(false);
    // Keeps the gate open for a short grace period after speech-end.
    const speechEndTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    /**
     * Handles the start of the interaction
     */
    const handleStart = useCallback(async () => {
        setIsLoading(true);
        setError("");
        onStart();

        try {
            initializeSimliClient();

            // Request microphone access
            await navigator.mediaDevices.getUserMedia({ audio: true });

        } catch (error: any) {
            console.error("Error starting interaction:", error);
            setError(`Error starting interaction: ${error.message}`);
            setIsLoading(false);
        }
    }, [agentId, onStart]);

    /**
     * Handles stopping the interaction
     */
    const handleStop = useCallback(() => {
        console.log("Stopping interaction...");
        setIsLoading(false);
        setError("");
        setIsAvatarVisible(false);

        // Remove Vapi listeners so a restart doesn't stack duplicate handlers
        // (which would attach a second audio pipeline sharing the same buffer).
        vapi.removeAllListeners();

        // Tear down the audio capture pipeline
        if (speechEndTimeoutRef.current) {
            clearTimeout(speechEndTimeoutRef.current);
            speechEndTimeoutRef.current = null;
        }
        isAssistantSpeakingRef.current = false;
        pcmBufferRef.current = new Int16Array(0);
        processorRef.current?.disconnect();
        sourceNodeRef.current?.disconnect();
        processorRef.current = null;
        sourceNodeRef.current = null;
        mediaStreamRef.current = null;
        if (audioContextRef.current && audioContextRef.current.state !== "closed") {
            audioContextRef.current.close();
        }
        audioContextRef.current = null;

        // Clean up Simli client
        simliClient?.stop();

        onClose();
        console.log("Interaction stopped");
    }, [onClose]);

    /**
     * Initializes the Simli client with the provided configuration.
     */
    const initializeSimliClient = useCallback(async () => {
        if (videoRef.current && audioRef.current) {
            const SimliConfig = {
                faceId: simli_faceid,
                handleSilence: true,
                maxSessionLength: 600,
                maxIdleTime: 600,
            };

            simliClient = new SimliClient((
                await generateSimliSessionToken(
                    { apiKey: (process.env.NEXT_PUBLIC_SIMLI_API_KEY as string), config: SimliConfig },
                )).session_token,
                videoRef.current,
                audioRef.current,
                await generateIceServers(
                    (process.env.NEXT_PUBLIC_SIMLI_API_KEY as string),

                ),
                LogLevel.DEBUG,
                "livekit",
                'websockets',
                'wss://api.simli.ai',
                SIMLI_AUDIO_BUFFER_SIZE,
            )
            simliClient?.on("start", () => {
                console.log("SimliClient connected");
                const audioData = new Uint8Array(6000).fill(0);
                simliClient?.sendAudioData(audioData);
                // Start Vapi interaction
                startVapiInteraction();
                console.log("Sent initial audio data");
            });

            simliClient?.on("stop", () => {
                console.log("SimliClient disconnected");
                vapi.stop();
            });
            simliClient?.on("error", (_) => {
                console.log("SimliClient errored");
                vapi.stop();
            });

            simliClient?.on("startup_error", (_) => {
                console.log("SimliClient Failed To Start");
                vapi.stop();
            });
            await simliClient.start()

        }

    }, [simli_faceid]);

    /**
     * Start Vapi interaction
     */
    const startVapiInteraction = async () => {
        try {
            await vapi.start(agentId);
            console.log("Vapi interaction started");
            eventListenerVapi();
        } catch (error: any) {
            console.error("Error starting Vapi interaction:", error);
            setError(`Error starting Vapi interaction: ${error.message}`);
        }
    };

    /**
     * Mute Vapi internal audio and only keep simli's audio
     */
    const muteVapiInternalAudio = () => {
        const audioElements = document.getElementsByTagName("audio");
        for (let i = 0; i < audioElements.length; i++) {
            if (audioElements[i].id !== "simli_audio") {
                audioElements[i].muted = true;
            }
        }
    };

    /**
     * Locate the "Vapi Speaker" assistant audio track and start processing it.
     * Retries until the participant/track actually exists (it may not be present
     * yet at call-start) rather than doing a single-shot scan.
     */
    const getAudioElementAndSendToSimli = () => {
        if (!simliClient) {
            setTimeout(getAudioElementAndSendToSimli, 100);
            return;
        }
        muteVapiInternalAudio();
        try {
            const dailyCall = vapi.getDailyCallObject();
            const participants = dailyCall?.participants();
            let vapiAudioTrack: MediaStreamTrack | null = null;
            if (participants) {
                Object.values(participants).forEach((participant: any) => {
                    if (participant.user_name === "Vapi Speaker") {
                        vapiAudioTrack = participant.tracks?.audio?.track ?? null;
                    }
                });
            }

            if (vapiAudioTrack) {
                console.log("Vapi Speaker detected, setting up audio processing");
                setupAudioProcessing(vapiAudioTrack);
            } else {
                // Track not ready yet — keep polling.
                setTimeout(getAudioElementAndSendToSimli, 100);
            }
        } catch (error: any) {
            console.error("Error getting audio track:", error);
            setTimeout(getAudioElementAndSendToSimli, 100);
        }
    };

    /**
     * Sets up a Web Audio pipeline on the assistant's audio track. The capture
     * AudioContext runs at 16kHz, so the MediaStreamSource is auto-resampled and
     * we get 16kHz mono samples directly — no manual downsampling needed.
     */
    const setupAudioProcessing = (audioTrack: MediaStreamTrack) => {
        const audioContext = new AudioContext({ sampleRate: SIMLI_SAMPLE_RATE });
        audioContextRef.current = audioContext;

        const mediaStream = new MediaStream([audioTrack]);
        mediaStreamRef.current = mediaStream;

        const source = audioContext.createMediaStreamSource(mediaStream);
        sourceNodeRef.current = source;

        const processor = audioContext.createScriptProcessor(2048, 1, 1);
        processorRef.current = processor;

        processor.onaudioprocess = (e) => {
            // Only buffer/forward audio while the assistant is actually speaking.
            if (!isAssistantSpeakingRef.current || !simliClient) return;

            const inputData = e.inputBuffer.getChannelData(0);
            const samples = new Int16Array(inputData.length);
            for (let i = 0; i < inputData.length; i++) {
                const s = Math.max(-1, Math.min(1, inputData[i]));
                samples[i] = s < 0 ? Math.round(s * 32768) : Math.round(s * 32767);
            }
            processAudioForSimli(samples);
        };

        source.connect(processor);
        // ScriptProcessor must be connected to keep firing; it writes no output,
        // so this routes silence to the speakers (Simli plays the real audio).
        processor.connect(audioContext.destination);
    };

    /**
     * Appends new 16kHz PCM16 samples and forwards them to Simli following the
     * "1 second immediate, then fixed-size chunks" scheme.
     */
    const processAudioForSimli = (samples: Int16Array) => {
        if (!simliClient) return;

        const merged = new Int16Array(pcmBufferRef.current.length + samples.length);
        merged.set(pcmBufferRef.current, 0);
        merged.set(samples, pcmBufferRef.current.length);
        pcmBufferRef.current = merged;

        // Phase 1: buffer the first ~1 second of the utterance, then play it
        // immediately to minimize startup latency.
        if (!initialChunkSentRef.current) {
            if (pcmBufferRef.current.length < INITIAL_BUFFER_SAMPLES) {
                return; // keep buffering until we have 1 second
            }
            const initial = pcmBufferRef.current.slice(0, INITIAL_BUFFER_SAMPLES);
            pcmBufferRef.current = pcmBufferRef.current.slice(INITIAL_BUFFER_SAMPLES);
            simliClient.sendAudioDataImmediate(new Uint8Array(initial.buffer));
            initialChunkSentRef.current = true;
        }

        // Phase 2: forward the rest in SIMLI_AUDIO_BUFFER_SIZE-sample chunks.
        while (pcmBufferRef.current.length >= SIMLI_AUDIO_BUFFER_SIZE) {
            const chunk = pcmBufferRef.current.slice(0, SIMLI_AUDIO_BUFFER_SIZE);
            pcmBufferRef.current = pcmBufferRef.current.slice(SIMLI_AUDIO_BUFFER_SIZE);
            simliClient.sendAudioData(new Uint8Array(chunk.buffer));
        }
    };

    /**
     * Flushes whatever audio remains when the assistant stops speaking, so we
     * don't drop sub-1-second utterances or clip the tail of a chunk.
     */
    const flushRemainingBuffer = () => {
        if (!simliClient || pcmBufferRef.current.length === 0) {
            pcmBufferRef.current = new Int16Array(0);
            return;
        }
        const remaining = pcmBufferRef.current;
        if (!initialChunkSentRef.current) {
            // Utterance was shorter than 1s — still play it immediately.
            simliClient.sendAudioDataImmediate(new Uint8Array(remaining.buffer));
            initialChunkSentRef.current = true;
        } else {
            simliClient.sendAudioData(new Uint8Array(remaining.buffer));
        }
        pcmBufferRef.current = new Int16Array(0);
    };

    /**
     * Vapi Event listeners
     */
    const eventListenerVapi = useCallback(() => {
        vapi.on("message", (message) => {
            console.log("Vapi message:", message);
            if (
                message.type === "speech-update" &&
                message.status === "started" &&
                message.role === "user"
            ) {
                console.log("User started speaking");
                // simliClient?.ClearBuffer();
            }
        });

        vapi.on("call-start", () => {
            console.log("Vapi call started");
            setIsAvatarVisible(true);
            getAudioElementAndSendToSimli();
        });

        vapi.on("call-end", () => {
            console.log("Vapi call ended");
            setIsAvatarVisible(false);
        });

        // Assistant started speaking — open the gate. Audio is only ever sent
        // within [speech-start, speech-end + 0.5s].
        vapi.on("speech-start", () => {
            // Cancel any pending close from a previous speech-end.
            if (speechEndTimeoutRef.current) {
                clearTimeout(speechEndTimeoutRef.current);
                speechEndTimeoutRef.current = null;
            }
            if (!isAssistantSpeakingRef.current) {
                // Genuinely new utterance — buffer fresh.
                console.log("Assistant speech started — buffering");
                pcmBufferRef.current = new Int16Array(0);
                initialChunkSentRef.current = false;
                isAssistantSpeakingRef.current = true;
            } else {
                // Re-detected within the trailing grace window — continue.
                console.log("Assistant speech resumed within grace window");
            }
        });

        // Assistant stopped speaking — keep the gate open 0.5s more to catch
        // trailing audio, then close it and flush whatever remains.
        vapi.on("speech-end", () => {
            console.log("Assistant speech ended — closing gate in 0.5s");
            if (speechEndTimeoutRef.current) {
                clearTimeout(speechEndTimeoutRef.current);
            }
            speechEndTimeoutRef.current = setTimeout(() => {
                isAssistantSpeakingRef.current = false;
                flushRemainingBuffer();
                speechEndTimeoutRef.current = null;
            }, 500);
        });
    }, []);


    return (
        <>
            <div
                className={`transition-all duration-300 ${showDottedFace ? "h-0 overflow-hidden" : "h-auto"
                    }`}
            >
                <VideoBox video={videoRef} audio={audioRef} />
            </div>
            <div className="flex flex-col items-center">
                {!isAvatarVisible ? (
                    <button
                        onClick={handleStart}
                        disabled={isLoading}
                        className={cn(
                            "w-full h-[52px] mt-4 disabled:bg-[#343434] disabled:text-white disabled:hover:rounded-[100px] bg-simliblue text-white py-3 px-6 rounded-[100px] transition-all duration-300 hover:text-black hover:bg-white hover:rounded-sm",
                            "flex justify-center items-center"
                        )}
                    >
                        {isLoading ? (
                            <IconSparkleLoader className="h-[20px] animate-loader" />
                        ) : (
                            <span className="font-abc-repro-mono font-bold w-[164px]">
                                Test Interaction
                            </span>
                        )}
                    </button>
                ) : (
                    <>
                        <div className="flex items-center gap-4 w-full">
                            <button
                                onClick={handleStop}
                                className={cn(
                                    "mt-4 group text-white flex-grow bg-red hover:rounded-sm hover:bg-white h-[52px] px-6 rounded-[100px] transition-all duration-300"
                                )}
                            >
                                <span className="font-abc-repro-mono group-hover:text-black font-bold w-[164px] transition-all duration-300">
                                    Stop Interaction
                                </span>
                            </button>
                        </div>
                    </>
                )}
            </div>
        </>
    );
};

export default SimliVapi;
