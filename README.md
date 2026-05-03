# AI Voice Call

Minimal React + TypeScript voice-call app wired for OpenAI Realtime over WebRTC. The frontend requests microphone access in the browser, the backend mints a short-lived Realtime client secret using your server-side `OPENAI_API_KEY`, and the browser connects directly to OpenAI with WebRTC.

## Setup

1. Install dependencies:

```bash
npm install
```

2. Copy the example environment file:

```bash
cp .env.example .env
```

On Windows PowerShell:

```powershell
Copy-Item .env.example .env
```

3. Fill in the server-side key and optional frontend values:

```env
OPENAI_API_KEY=your_openai_api_key
OPENAI_REALTIME_VOICE=marin
OPENAI_REALTIME_INSTRUCTIONS=You are a concise and helpful voice assistant.
PORT=3000
VITE_OPENAI_REALTIME_MODEL=gpt-realtime
VITE_API_BASE_URL=http://localhost:3000
```

`VITE_API_BASE_URL` can stay blank if you want the frontend to fall back to `http://localhost:3000` in local development.

4. Start the frontend and backend together:

```bash
npm run dev
```

Frontend:
- Vite app on `http://localhost:5173`

Backend:
- Express API on `http://localhost:3000`

## Environment Variables

Required for a working call:

```env
OPENAI_API_KEY=
```

Frontend/runtime configuration:

```env
VITE_OPENAI_REALTIME_MODEL=
VITE_API_BASE_URL=
```

Optional backend defaults:

```env
OPENAI_REALTIME_VOICE=marin
OPENAI_REALTIME_INSTRUCTIONS=You are a concise and helpful voice assistant.
PORT=3000
```

## Current Implementation

- React + TypeScript UI built with Vite
- Node backend that creates OpenAI Realtime client secrets
- Browser microphone access via `navigator.mediaDevices.getUserMedia({ audio: true })`
- WebRTC connection from the browser to OpenAI Realtime
- Remote audio playback from the model
- Mute/unmute support by toggling the local audio track `enabled` flag
- Proper cleanup of peer connection, data channel, audio element, and media tracks when ending the call

## Notes

- No API keys are hardcoded in the frontend.
- The browser never receives your standard `OPENAI_API_KEY`; it only gets a short-lived client secret from the backend.
- The app is structured so the OpenAI Realtime logic stays isolated in `src/services/voiceCall.ts` and the backend token/session setup stays isolated in `server/index.js`.
