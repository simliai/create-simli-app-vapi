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
4. **Restrict the public key**: set *Allowed origins* to your site (and `http://localhost:3000` for development), set *Allowed assistants* to this assistant, and leave *Transient assistants* disabled. Treat these as guard rails, not a security boundary: the key is public, *Allowed origins* only checks the `Origin` header (which scripts outside a browser can set to anything), and Vapi's [API keys docs](https://docs.vapi.ai/security-and-privacy/api-keys) say restricting assistants does **not** stop callers from sending `assistantOverrides`. So don't put secrets in the assistant's prompt, server URL, credentials or tool configuration, and see [Before you deploy](#before-you-deploy) for the stronger option.
5. **Cap cost on the Vapi side**: set a maximum call duration on the assistant, keep your organization's concurrency limit low, and watch spend in the dashboard.

### 3. Environment variables

```bash
cp .env.example .env.local
```

| Variable | Where it's used | Value |
|---|---|---|
| `SIMLI_API_KEY` | server only (`app/api/simli-token/route.ts`) | Simli API key |
| `SIMLI_FACE_ID` | server only | avatar face ID; empty = Anna preset |
| `ALLOW_UNAUTHENTICATED_SESSIONS` | server only | `false` (default). Production builds refuse to mint Simli tokens unless this is `true` or you've added auth (see below) |
| `NEXT_PUBLIC_VAPI_PUBLIC_KEY` | browser | Vapi **public** key |
| `NEXT_PUBLIC_VAPI_ASSISTANT_ID` | browser | Vapi assistant ID |

Anything prefixed `NEXT_PUBLIC_` is bundled into the browser JavaScript. Only the Vapi public key and assistant ID belong there.

> **Upgrading from an older version of this repo?** Variables were renamed: `NEXT_PUBLIC_SIMLI_API_KEY` → `SIMLI_API_KEY` (now server-only), `NEXT_PUBLIC_SIMLI_FACE_ID` → `SIMLI_FACE_ID`, `NEXT_PUBLIC_VAPI_API_KEY` → `NEXT_PUBLIC_VAPI_PUBLIC_KEY`, `NEXT_PUBLIC_VAPI_AGENT_ID` → `NEXT_PUBLIC_VAPI_ASSISTANT_ID`. `NEXT_PUBLIC_SIMLI_API_KEY` was exposed to every visitor in earlier versions: remove it and rotate that key in the Simli dashboard.

### 4. Run

Requires Node.js 22.14 or newer.

```bash
npm install
npm run dev
```

The dev server listens on 127.0.0.1 only. Open http://localhost:3000, click **Test Interaction** and allow the microphone. Use headphones if the assistant hears itself through your speakers.

Other scripts: `npm run build`, `npm start`, `npm run lint`, `npm run typecheck`.

## Customizing

- **Avatar:** set `SIMLI_FACE_ID`.
- **Assistant (voice, prompt, model, first message):** edit it in the Vapi dashboard, or point `NEXT_PUBLIC_VAPI_ASSISTANT_ID` at another one.
- **Video shape:** the UI uses a square tile, so the token route requests a 768x768 stream. For 16:9, set `streaming_width: 1366, streaming_height: 768` in `app/api/simli-token/route.ts` and change the tile in `app/Components/VideoBox.tsx` to `aspect-video` with a wider width. See [Trinity-2 framing](https://docs.simli.com/api-reference/trinity-2).
- **Session limits:** `maxSessionLength` (600 s) and `maxIdleTime` (180 s) in the token route.
- **Latency vs. lip-sync:** the page waits for 1 s of assistant audio before the avatar starts speaking each reply (better lip-sync, about 1 s more latency). Tune `INITIAL_BUFFER_SAMPLES` and `CHUNK_SAMPLES` in `app/SimliVapi.tsx`.

## Before you deploy

What is capped on the server, and what only an honest client respects:

| Control | Enforced by |
|---|---|
| Simli API key never reaches the browser | server (`/api/simli-token`) |
| Simli session length (600 s) and idle time (180 s) | server: baked into each token |
| Who may start Simli sessions | **nobody yet**: production builds return 403 until you add auth, or set `ALLOW_UNAUTHENTICATED_SESSIONS=true` |
| Simli audio limited to the Vapi assistant, Stop button, ending both sides | client only: anyone with a token can send their own audio until the limits above end the session |
| Who may start Vapi calls, which assistant, what overrides | Vapi only: the public key is public, origin checks can be spoofed, `assistantOverrides` are not blocked |

Checklist:

- [ ] **Protect `POST /api/simli-token`.** Add your app's sign-in and/or per-user/IP rate limiting at the `TODO` in `app/api/simli-token/route.ts`. Only set `ALLOW_UNAUTHENTICATED_SESSIONS=true` if you accept that anyone can spend your Simli minutes.
- [ ] **Vapi: when cost matters, use a short-lived JWT instead of the public key.** Add a server route, behind the same auth as the Simli token, that signs a JWT with your Vapi **private** key (HS256, `exp` of at most 1 h, `token.restrictions.allowedAssistantIds` set to your assistant). Return only the JWT and pass it to `new Vapi(jwt)`, creating a new instance per call. See [JWT authentication](https://docs.vapi.ai/customization/jwt-authentication). The private key stays in that route. Note that Vapi's JWT docs don't say whether a restricted token blocks `assistantOverrides`, so keep secrets out of the assistant either way.
- [ ] **Set provider-side limits:** a maximum call duration on the Vapi assistant, a low Vapi concurrency limit, spend alerts in both dashboards, and a Simli plan whose concurrent-session limit you're comfortable with.
- [ ] **Restrict the Vapi public key** (allowed origins, allowed assistants, transient assistants off), even though it isn't a hard boundary.
- [ ] **Don't put secrets in the Vapi assistant** (prompt, server URL, credentials, tools): treat its configuration as readable and overridable by callers.
- [ ] Keep `SIMLI_API_KEY` (and any Vapi private key) in your host's secret store, never in `NEXT_PUBLIC_*` variables or the repo. **Rotate any key that was ever in a `NEXT_PUBLIC_*` variable.**
- [ ] Error details are only returned in development. In production, the token route sends generic messages and logs details on the server.
- [ ] Security headers are set in `next.config.ts` (`frame-ancestors 'self'`, microphone-only `Permissions-Policy`, `nosniff`, `strict-origin-when-cross-origin`). Add a fuller CSP if your app needs one.
- [ ] Set the assistant's First Message so the avatar greets users right away, and test on the browsers you support (microphone permission, autoplay, echo).

## Using a coding agent?

This repo includes the Simli agent skill in [`.agents/skills/simli`](.agents/skills/simli) (also linked at `.claude/skills/simli`), so coding agents such as Claude Code pick up how to use Simli correctly. To install it in another project, run `npx skills add simliai/skills`.

## Characters

You can swap out the character by picking one of the [preset faces](https://docs.simli.com/api-reference/preset-faces), or [create your own](https://app.simli.com/).

![alt text](media/image.png) ![alt text](media/image-4.png) ![alt text](media/image-2.png) ![alt text](media/image-3.png) ![alt text](media/image-5.png) ![alt text](media/image-6.png)

## Deploy

Deploy to [Vercel](https://vercel.com/new) or any Node.js host. Set the environment variables in the host's settings, and work through [Before you deploy](#before-you-deploy) first.

## Help

Discord: https://discord.gg/yQx49zNF4d · Simli docs: https://docs.simli.com · Vapi Web SDK: https://docs.vapi.ai/sdk/web
