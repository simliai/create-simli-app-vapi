import type { RefObject } from "react";

type Props = {
    video: RefObject<HTMLVideoElement | null>;
    audio: RefObject<HTMLAudioElement | null>;
};

// Square tile to match the 768x768 stream requested in app/api/simli-token/route.ts.
// For 16:9, request 1366x768 there and use aspect-video with a wider width here.
export default function VideoBox({ video, audio }: Props) {
    return (
        <div className="aspect-square flex rounded-xs overflow-hidden items-center w-[350px] justify-center bg-simligray">
            {/* muted: the voice plays through the separate <audio>, Simli's in-sync audio */}
            <video ref={video} autoPlay playsInline muted id="simli_video" className="w-full h-full object-cover" />
            <audio ref={audio} autoPlay id="simli_audio" />
        </div>
    );
}
