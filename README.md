# Create Simli App (Vapi)

A Next.js starter where a [Vapi](https://vapi.ai) voice assistant speaks through a real-time [Simli](https://simli.com) talking avatar. Click **Test Interaction**, allow the microphone, and talk: Vapi runs the conversation, and Simli turns the assistant's voice into a lip-synced video face.

Stack: Next.js 16 (App Router), React 19, TypeScript, Tailwind CSS 4, [`simli-client`](https://www.npmjs.com/package/simli-client) 3.2, [`@vapi-ai/web`](https://www.npmjs.com/package/@vapi-ai/web) 3.1.

Simli docs: https://docs.simli.com

## How it works

1. The browser asks this app's server route `POST /api/simli-token` for a short-lived Simli session token. `SIMLI_API_KEY` never leaves the server.
2. The page starts the Simli session and waits until the avatar is on screen.
3. Only then does it start the Vapi call (`new Vapi(publicKey).start(assistantId)`), so the assistant's first words aren't lost.
4. Vapi's own playback is silenced (`vapi.setVolume(0)`). The assistant's audio track is tapped with Web Audio at 16 kHz, buffered per utterance (using Vapi's `speech-start` / `speech-end` events) and sent to Simli with `sendAudioData`. You only hear Simli's audio, in sync with the video.
5. When you interrupt, Vapi sends a `user-interrupted` message and the page calls `ClearBuffer()` so the avatar stops talking.
6. Ending either side ends both: the Stop button, the Vapi call ending, the Simli session ending (`maxSessionLength` / `maxIdleTime`), errors, closing the tab, or unmounting the component.

## Setup

### 1. Simli

Get an API key from https://app.simli.com. The default avatar is the Trinity-2 preset **Anna** (`bf13113a-355a-4d97-8b90-4edccd1da7b2`); pick another from the [preset faces](https://docs.simli.com/api-reference/preset-faces) or create your own in the dashboard.

### 2. Vapi dashboard

1. **Create an assistant** at https://dashboard.vapi.ai/assistants and copy its ID.
2. **Set a First Message** on the assistant (for example "Hi! How can I help?"), so the avatar greets the user as soon as the call connects.
3. **Copy your Public key** from https://dashboard.vapi.ai/org/api-keys. Use the **public** key only. The **private** key can access your whole Vapi organization and must never be used in browser code, `NEXT_PUBLIC_*` variables, logs or the repo.
4. **Restrict the public key** (recommended, required before deploying): set *Allowed origins* to your site (and `http://localhost:3000` for development), set *Allowed assistants* to this assistant, and leave *Transient assistants* disabled. A public key without restrictions works from any origin. See [Vapi API keys](https://docs.vapi.ai/security-and-privacy/api-keys).

### 3. Environment variables

```bash
cp .env.example .env.local
```

| Variable | Where it's used | Value |
|---|---|---|
| `SIMLI_API_KEY` | server only (`app/api/simli-token/route.ts`) | Simli API key |
| `SIMLI_FACE_ID` | server only | avatar face ID; empty = Anna preset |
| `NEXT_PUBLIC_VAPI_PUBLIC_KEY` | browser | Vapi **public** key |
| `NEXT_PUBLIC_VAPI_ASSISTANT_ID` | browser | Vapi assistant ID |

Anything prefixed `NEXT_PUBLIC_` is bundled into the browser JavaScript. Only the Vapi public key and assistant ID belong there.

> **Upgrading from an older version of this repo?** Variables were renamed: `NEXT_PUBLIC_SIMLI_API_KEY` → `SIMLI_API_KEY` (now server-only), `NEXT_PUBLIC_SIMLI_FACE_ID` → `SIMLI_FACE_ID`, `NEXT_PUBLIC_VAPI_API_KEY` → `NEXT_PUBLIC_VAPI_PUBLIC_KEY`, `NEXT_PUBLIC_VAPI_AGENT_ID` → `NEXT_PUBLIC_VAPI_ASSISTANT_ID`. Delete the old `NEXT_PUBLIC_SIMLI_API_KEY`: it exposed your Simli key to every visitor. If it was ever deployed, rotate the key in the Simli dashboard.

### 4. Run

Requires Node.js 22.14 or newer.

```bash
npm install
npm run dev
```

Open http://localhost:3000, click **Test Interaction** and allow the microphone. Use headphones if the assistant hears itself through your speakers.

Other scripts: `npm run build`, `npm start`, `npm run lint`, `npm run typecheck`.

## Customizing

- **Avatar:** set `SIMLI_FACE_ID`.
- **Assistant (voice, prompt, model, first message):** edit it in the Vapi dashboard, or point `NEXT_PUBLIC_VAPI_ASSISTANT_ID` at another one.
- **Video shape:** the UI uses a square tile, so the token route requests a 768x768 stream. For 16:9, set `streaming_width: 1366, streaming_height: 768` in `app/api/simli-token/route.ts` and change the tile in `app/Components/VideoBox.tsx` to `aspect-video` with a wider width. See [Trinity-2 framing](https://docs.simli.com/api-reference/trinity-2).
- **Session limits:** `maxSessionLength` (600 s) and `maxIdleTime` (180 s) in the token route.
- **Latency vs. lip-sync:** the page waits for 1 s of assistant audio before the avatar starts speaking each reply (better lip-sync, about 1 s more latency). Tune `INITIAL_BUFFER_SAMPLES` and `CHUNK_SAMPLES` in `app/SimliVapi.tsx`.

## Production checklist

- [ ] **Protect `POST /api/simli-token`.** It is public in this starter: anyone who can reach it can start Simli sessions and spend your minutes. Require your app's sign-in and/or add rate limiting (per user / IP) in `app/api/simli-token/route.ts` (see the `TODO`).
- [ ] **Restrict the Vapi public key** to your origins and assistant in the Vapi dashboard, with transient assistants disabled. For stricter control, have a server route sign a short-lived Vapi JWT with your private key and pass that to `new Vapi(...)` instead of the public key ([JWT authentication](https://docs.vapi.ai/customization/jwt-authentication)); the private key stays in that server route.
- [ ] Keep `SIMLI_API_KEY` (and any Vapi private key) in your host's secret store, never in `NEXT_PUBLIC_*` variables or the repo. `.env*` files are git-ignored, except `.env.example`.
- [ ] Review `maxSessionLength` / `maxIdleTime` for your use case.
- [ ] Set the assistant's First Message so the avatar greets users right away.
- [ ] Test on the browsers you support (microphone permission, autoplay, echo).

## Using a coding agent?

This repo includes the Simli agent skill in [`.agents/skills/simli`](.agents/skills/simli) (also linked at `.claude/skills/simli`), so coding agents such as Claude Code pick up how to use Simli correctly. To install it in another project, run `npx skills add simliai/skills`.

## Characters

You can swap out the character by picking one of the [preset faces](https://docs.simli.com/api-reference/preset-faces), or [create your own](https://app.simli.com/).

![alt text](media/image.png) ![alt text](media/image-4.png) ![alt text](media/image-2.png) ![alt text](media/image-3.png) ![alt text](media/image-5.png) ![alt text](media/image-6.png)

## Deploy

Deploy to [Vercel](https://vercel.com/new) or any Node.js host. Set the four environment variables in the host's settings, and work through the production checklist above first.

## Help

Discord: https://discord.gg/yQx49zNF4d · Simli docs: https://docs.simli.com · Vapi Web SDK: https://docs.vapi.ai/sdk/web
