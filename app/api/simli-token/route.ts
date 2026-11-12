import { generateSimliSessionToken } from "simli-client";

// Never cache: every call must mint a fresh, short-lived session token.
export const dynamic = "force-dynamic";

// Trinity-2 preset "Anna". Override with SIMLI_FACE_ID.
const DEFAULT_FACE_ID = "bf13113a-355a-4d97-8b90-4edccd1da7b2";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * POST /api/simli-token
 *
 * Mints a short-lived Simli session token. SIMLI_API_KEY stays on the server;
 * the browser only ever sees the token.
 *
 * TODO before deploying: this route is public. Anyone who can call it can
 * start Simli sessions and spend your minutes. Check the user's session (auth)
 * and/or rate limit it here. See "Production checklist" in README.md.
 */
export async function POST() {
  const apiKey = process.env.SIMLI_API_KEY?.trim();
  if (!apiKey) {
    return Response.json(
      { error: "SIMLI_API_KEY is not set on the server. Add it to .env.local (see .env.example) and restart the dev server." },
      { status: 500 },
    );
  }
  if (process.env.NEXT_PUBLIC_SIMLI_API_KEY) {
    // Old variable name from earlier versions of this repo: it is bundled into browser code.
    console.warn(
      "NEXT_PUBLIC_SIMLI_API_KEY is set. It is exposed to the browser and is no longer used: remove it and use SIMLI_API_KEY.",
    );
  }

  const faceId = process.env.SIMLI_FACE_ID?.trim() || DEFAULT_FACE_ID; // || so an empty var falls back
  if (!UUID_RE.test(faceId)) {
    return Response.json({ error: `SIMLI_FACE_ID "${faceId}" is not a valid face ID (expected a UUID).` }, { status: 500 });
  }

  try {
    const { session_token, warnings } = await generateSimliSessionToken({
      apiKey,
      config: {
        faceId,
        // Bound every session so a forgotten tab can't bill for an hour.
        maxSessionLength: 600, // seconds
        maxIdleTime: 180, // seconds without audio
        // The page buffers Vapi's audio and sends it in chunks with sendAudioData,
        // with gaps between utterances, so Simli should fill the silences.
        handleSilence: true,
        // Square 768x768 (the default) to match the square video tile in the UI.
        // For 16:9 use streaming_width: 1366, streaming_height: 768 and change the
        // tile's CSS aspect-ratio in app/Components/VideoBox.tsx to match.
        streaming_width: 768,
        streaming_height: 768,
      },
    });
    if (warnings?.length) console.warn("Simli:", warnings);
    return Response.json({ session_token });
  } catch (err) {
    // generateSimliSessionToken throws the API's response body text. It never contains the key.
    console.error("Simli token error:", err);
    return Response.json({ error: `Simli refused the session: ${String(err)}` }, { status: 502 });
  }
}
