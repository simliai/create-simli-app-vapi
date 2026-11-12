"use client";
import { useState } from "react";
import Image from "next/image";
import SimliVapi from "@/app/SimliVapi";
import DottedFace from "./Components/DottedFace";
import SimliHeaderLogo from "./Components/Logo";
import Navbar from "./Components/Navbar";
import GitHubLogo from "@/media/github-mark-white.svg";

export default function Demo() {
    const [showDottedFace, setShowDottedFace] = useState(true);

    return (
        <div className="bg-black min-h-screen flex flex-col items-center font-abc-repro font-normal text-sm text-white p-8">
            <SimliHeaderLogo />
            <Navbar />

            <div className="absolute top-[32px] right-[32px]">
                <a
                    href="https://github.com/simliai/create-simli-app-vapi"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-bold cursor-pointer mb-8 text-xl leading-8"
                >
                    <Image className="w-[20px] inline mr-2" src={GitHubLogo} alt="" />
                    create-simli-app (Vapi)
                </a>
            </div>
            <div className="flex flex-col items-center gap-6 p-6 pb-[40px] rounded-xl w-full">
                <div>
                    {showDottedFace && <DottedFace />}
                    <SimliVapi onStart={() => setShowDottedFace(false)} onClose={() => setShowDottedFace(true)} />
                </div>
            </div>

            <div className="max-w-[350px] font-thin flex flex-col items-center">
                <span className="font-bold mb-[8px] leading-5">
                    Create Simli App is a starter repo for creating visual avatars with Simli
                </span>
                <ul className="list-decimal list-inside max-w-[350px] ml-[6px] mt-2">
                    <li className="mb-1">
                        Copy <code>.env.example</code> to <code>.env.local</code> and fill in your Simli API key and your
                        Vapi public key and assistant ID.
                    </li>
                    <li className="mb-1">
                        Test out the interaction and have a talk with the Vapi-powered, Simli-visualized avatar.
                    </li>
                    <li className="mb-1">
                        Swap the avatar with <code>SIMLI_FACE_ID</code> and the agent with{" "}
                        <code>NEXT_PUBLIC_VAPI_ASSISTANT_ID</code>.
                    </li>
                </ul>
                <span className="mt-[16px]">
                    Before deploying, protect <code>/api/simli-token</code> with auth or rate limiting (see the README).
                </span>
            </div>
        </div>
    );
}
