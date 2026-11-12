import { generateSimliSessionToken } from "simli-client";

// Never cache: every call must mint a fresh, short-lived session token.
export const dynamic = "force-dynamic";

// Trinity-2 preset "Anna". Override with SIMLI_FACE_ID.
const DEFAULT_FACE_ID = "bf13113a-355a-4d97-8b90-4edccd1da7b2";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UPSTREAM_TIMEOUT_MS = 10_000;

const isProd = process.env.NODE_ENV === "production";

/** Detailed message in development, generic one in production (details go to the server log). */
function fail(status: number, devMessage: string, prodMessage: string, detail?: unknown) {
  console.error(`[simli-token] ${devMessage}`, detail ?? "");
  return Response.json({ error: isProd ? prodMessage : devMessage }, { status });
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  // generateSimliSessionToken takes no AbortSignal, so this bounds how long the
  // route waits; the underlying request is left to finish on its own.
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/**
 * POST /api/simli-token
 *
 * Mints a short-lived Simli session token. SIMLI_API_KEY stays on the server;
 * the browser only ever sees the token.
 */
export async function POST() {
  // TODO before deploying: check the user's session (auth) and/or rate limit here.
  // Anyone who can call this route can start Simli sessions and spend your minutes.
  // Until you do, production builds refuse to mint tokens unless you explicitly opt in
  // with ALLOW_UNAUTHENTICATED_SESSIONS=true. See "Before you deploy" in README.md.
  if (isProd && process.env.ALLOW_UNAUTHENTICATED_SESSIONS !== "true") {
    console.error(
      "[simli-token] Refusing to mint a token: this route has no auth yet. Add auth/rate limiting in app/api/simli-token/route.ts, or set ALLOW_UNAUTHENTICATED_SESSIONS=true to accept the risk.",
    );
    return Response.json({ error: "Avatar sessions are disabled on this deployment." }, { status: 403 });
  }

  const apiKey = process.env.SIMLI_API_KEY?.trim();
  if (!apiKey) {
    return fail(
      500,
      "SIMLI_API_KEY is not set on the server. Add it to .env.local (see .env.example) and restart the dev server.",
      "The avatar service is not configured.",
    );
  }
  if (process.env.NEXT_PUBLIC_SIMLI_API_KEY) {
    console.warn(
      "[simli-token] NEXT_PUBLIC_SIMLI_API_KEY is set. Earlier versions of this repo exposed it to the browser; it is no longer used. Remove it and rotate that key.",
    );
  }

  const faceId = process.env.SIMLI_FACE_ID?.trim() || DEFAULT_FACE_ID; // || so an empty var falls back
  if (!UUID_RE.test(faceId)) {
    return fail(500, `SIMLI_FACE_ID "${faceId}" is not a valid face ID (expected a UUID).`, "The avatar service is not configured.");
  }

  let result: Awaited<ReturnType<typeof generateSimliSessionToken>>;
  try {
    result = await withTimeout(
      generateSimliSessionToken({
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
      }),
      UPSTREAM_TIMEOUT_MS,
    );
  } catch (err) {
    // generateSimliSessionToken throws Simli's raw response body (never the key).
    return fail(502, `Simli refused the session: ${String(err)}`, "Could not start the avatar session.", err);
  }

  const session_token = (result as { session_token?: unknown } | null)?.session_token;
  if (typeof session_token !== "string" || !session_token) {
    return fail(502, "Simli returned an unexpected response (no session_token).", "Could not start the avatar session.", result);
  }
  if (result.warnings?.length) console.warn("[simli-token] Simli warnings:", result.warnings);
  return Response.json({ session_token });
}
