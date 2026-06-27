import { after } from "@vendetta/patcher";
import { storage } from "@vendetta/plugin";
import { showToast } from "@vendetta/ui/toasts";
import { findByProps } from "@vendetta/metro";
import { FluxDispatcher } from "@vendetta/metro/common";
import { showConfirmationAlert, showInputAlert } from "@vendetta/ui/alerts";
import { Linking } from "react-native";

// ---- Constants ----------------------------------------------------------
const META_APP_ID = "1417273808645259344";
const REDIRECT_URI = "https://oculus.com/oauth_account_linking/login_redirect";
const AUTHORIZE_URL = "https://discord.com/oauth2/authorize";
const SCOPES = "identify activities.read activities.write";
const API = "https://discord.com/api/v10";
const TOKEN_URL = `${API}/oauth2/token`;
const HEADLESS_URL = `${API}/users/@me/headless-sessions`;

// Discord deletes headless sessions after 20 min, so renew every 10 min
const KEEPALIVE_MS = 10 * 60_000;
const REFRESH_SKEW_MS = 5 * 60_000;

// ---- Types --------------------------------------------------------------
interface Tokens {
    accessToken: string;
    refreshToken: string;
    expires: number;
}

// ---- State --------------------------------------------------------------
// State lives in module scope; storage is used only for persistence.
let tokens: Tokens | null = null;
let sessionToken: string | null = null;
let keepAlive: ReturnType<typeof setInterval> | null = null;
let myId: string | undefined;
let pendingAuth: { verifier: string; state: string } | null = null;
let unsubscribeVoice: (() => void) | null = null;

// ---- Helpers ------------------------------------------------------------
const ok = (status: number) => status >= 200 && status < 300;

const base64url = (bytes: Uint8Array) =>
    btoa(String.fromCharCode(...bytes))
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");

const randomToken = () =>
    base64url(crypto.getRandomValues(new Uint8Array(48)));

const sha256 = async (s: string) =>
    base64url(
        new Uint8Array(
            await crypto.subtle.digest(
                "SHA-256",
                new TextEncoder().encode(s)
            )
        )
    );

// ---- HTTP helpers -------------------------------------------------------
// On mobile (React Native) there is no Electron / main-process, so all
// HTTP runs directly in the renderer. Discord's mobile API doesn't enforce
// CORS on these endpoints.
interface Result {
    status: number;
    data: any;
}

const parse = (text: string) => {
    try {
        return JSON.parse(text);
    } catch {
        return text;
    }
};

async function httpPost(
    url: string,
    headers: Record<string, string>,
    body: string
): Promise<Result> {
    try {
        const res = await fetch(url, { method: "POST", headers, body });
        return {
            status: res.status,
            data: res.status === 204 ? null : parse(await res.text()),
        };
    } catch (e) {
        return { status: -1, data: String(e) };
    }
}

const formPost = (body: Record<string, string>) =>
    httpPost(
        TOKEN_URL,
        { "Content-Type": "application/x-www-form-urlencoded" },
        new URLSearchParams(body).toString()
    );

const bearerPost = (url: string, accessToken: string, body: any) =>
    httpPost(
        url,
        {
            "Content-Type": "application/json",
            Authorization: `Bearer ${accessToken}`,
        },
        JSON.stringify(body)
    );

// ---- OAuth calls --------------------------------------------------------
const oauthExchange = (code: string, verifier: string) =>
    formPost({
        client_id: META_APP_ID,
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT_URI,
        code_verifier: verifier,
    });

const oauthRefresh = (refreshToken: string) =>
    formPost({
        client_id: META_APP_ID,
        grant_type: "refresh_token",
        refresh_token: refreshToken,
    });

const headlessCreate = (accessToken: string, sessionTok: string | null) =>
    bearerPost(HEADLESS_URL, accessToken, {
        activities: [
            {
                application_id: META_APP_ID,
                name: "~~",
                type: 6,
                platform: "meta_quest",
            },
        ],
        ...(sessionTok ? { token: sessionTok } : {}),
    });

const headlessDelete = (accessToken: string, sessionTok: string) =>
    bearerPost(`${HEADLESS_URL}/delete`, accessToken, { token: sessionTok });

// ---- Token persistence --------------------------------------------------
async function saveTokens(t: Tokens | null) {
    tokens = t;
    storage.tokens = t ? JSON.stringify(t) : null;
}

function loadTokens(): Tokens | null {
    if (!storage.tokens) return null;
    try {
        return JSON.parse(storage.tokens) as Tokens;
    } catch {
        return null;
    }
}

const persist = (data: any, fallbackRefresh?: string) =>
    saveTokens({
        accessToken: data.access_token,
        refreshToken: data.refresh_token ?? fallbackRefresh!,
        expires: Date.now() + (data.expires_in ?? 3600) * 1000,
    });

// ---- Access token (auto-refresh) ----------------------------------------
async function getAccessToken(): Promise<string | null> {
    if (!tokens) return null;
    if (tokens.expires - Date.now() > REFRESH_SKEW_MS)
        return tokens.accessToken;

    const { status, data } = await oauthRefresh(tokens.refreshToken);
    if (status !== 200 || !data?.access_token) {
        console.warn("[FakeVRStatus] token refresh failed:", status, data);
        await saveTokens(null);
        return null;
    }
    await persist(data, tokens.refreshToken);
    return data.access_token;
}

// ---- Headless session ---------------------------------------------------
async function startSession() {
    if (sessionToken) return;
    const at = await getAccessToken();
    if (!at) return;

    const { status, data } = await headlessCreate(at, null);
    if (!ok(status) || !data?.token) {
        console.warn("[FakeVRStatus] headless session create failed:", status, data);
        return;
    }
    sessionToken = data.token;
    keepAlive ??= setInterval(refreshSession, KEEPALIVE_MS);
}

async function refreshSession() {
    if (!sessionToken) return;
    const at = await getAccessToken();
    if (!at) return;
    const { status, data } = await headlessCreate(at, sessionToken);
    if (ok(status) && data?.token) sessionToken = data.token;
}

async function stopSession() {
    if (keepAlive) {
        clearInterval(keepAlive);
        keepAlive = null;
    }
    if (!sessionToken) return;
    const tok = sessionToken;
    sessionToken = null;
    const at = await getAccessToken();
    if (at) await headlessDelete(at, tok);
}

// ---- Login flow (mobile) ------------------------------------------------
// On mobile we open the OAuth URL in the system browser, then ask the user
// to paste back the redirected URL (same approach as the Vencord plugin).
export async function startLogin() {
    const verifier = randomToken();
    const state = randomToken();
    pendingAuth = { verifier, state };

    const url =
        `${AUTHORIZE_URL}?response_type=code&client_id=${META_APP_ID}` +
        `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
        `&scope=${encodeURIComponent(SCOPES)}` +
        `&state=${encodeURIComponent(state)}` +
        `&code_challenge=${await sha256(verifier)}&code_challenge_method=S256`;

    Linking.openURL(url);

    // Give the user a moment to complete auth in the browser, then prompt
    // for the redirect URL.
    showInputAlert({
        title: "FakeVRStatus – Paste redirect URL",
        placeholder: "https://oculus.com/...?code=...&state=...",
        confirmText: "Submit",
        onConfirm: async (pasted: string) => {
            if (!pendingAuth) {
                showToast("No pending auth. Tap Login again.", { type: "danger" });
                return;
            }

            let redirectUrl: URL;
            try {
                redirectUrl = new URL(pasted.trim());
            } catch {
                showToast("Invalid URL.", { type: "danger" });
                return;
            }

            const code = redirectUrl.searchParams.get("code");
            if (!code) {
                showToast("No code in the URL.", { type: "danger" });
                return;
            }
            if (redirectUrl.searchParams.get("state") !== pendingAuth.state) {
                showToast("State mismatch. Tap Login again.", { type: "danger" });
                return;
            }

            const { status, data } = await oauthExchange(
                code,
                pendingAuth.verifier
            );
            if (status !== 200 || !data?.access_token) {
                console.error("[FakeVRStatus] token exchange failed:", status, data);
                showToast(`Login failed (${status}).`, { type: "danger" });
                return;
            }

            await persist(data);
            pendingAuth = null;
            showToast("Logged in!", { type: "success" });

            // Start session immediately if alwaysOn
            if (storage.alwaysOn !== false) startSession();
        },
    });
}

export async function logout() {
    showConfirmationAlert({
        title: "Logout",
        content: "Stop the VR session and remove stored credentials?",
        confirmText: "Logout",
        confirmColor: "red",
        onConfirm: async () => {
            await stopSession();
            await saveTokens(null);
            showToast("Logged out.", { type: "success" });
        },
    });
}

// ---- Voice state listener -----------------------------------------------
function handleVoiceStateUpdates({ voiceStates }: { voiceStates: { userId: string; channelId?: string | null }[] }) {
    if (storage.alwaysOn !== false) return;
    for (const s of voiceStates) {
        if (s.userId === myId) {
            if (s.channelId) startSession();
            else stopSession();
        }
    }
}

// ---- Plugin lifecycle ---------------------------------------------------
export default {
    onLoad() {
        // Restore persisted tokens
        tokens = loadTokens();

        // Resolve current user ID
        try {
            const UserStore = findByProps("getCurrentUser");
            myId = UserStore?.getCurrentUser()?.id;
        } catch {
            console.warn("[FakeVRStatus] could not get user ID");
        }

        // Subscribe to voice state changes for non-alwaysOn mode
        FluxDispatcher.subscribe(
            "VOICE_STATE_UPDATES",
            handleVoiceStateUpdates
        );
        unsubscribeVoice = () =>
            FluxDispatcher.unsubscribe(
                "VOICE_STATE_UPDATES",
                handleVoiceStateUpdates
            );

        // If we have tokens and alwaysOn (default), start immediately
        if (tokens && storage.alwaysOn !== false) {
            startSession();
        }
    },

    onUnload() {
        unsubscribeVoice?.();
        unsubscribeVoice = null;
        stopSession();
    },

    // Exposed for the settings page
    get isLoggedIn() {
        return !!tokens;
    },
    get hasSession() {
        return !!sessionToken;
    },
};
