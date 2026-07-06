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

Optional repository-analysis defaults:

```env
REPOSITORY_ANALYSIS_CACHE_DIR=
REFACTORING_MINER_COMMAND=
REFACTORING_MINER_JAVA_HOME=
REFACTORING_MINER_REQUIRED=true
REFACTORING_MINER_MAX_COMMITS=20
```

`REFACTORING_MINER_COMMAND` can point to the RefactoringMiner executable, for example `C:\tools\RefactoringMiner\bin\RefactoringMiner.bat` on Windows. If it is blank, the backend tries to run `RefactoringMiner.bat` or `RefactoringMiner` from PATH. Repository rows can also set `requireRefactoringMiner: true` in `data/submissions.json`; when required, the voice-call API fails fast if RefactoringMiner is unavailable instead of quietly falling back to Git-only scoring.

Recent RefactoringMiner releases may require a newer Java runtime than the rest of the app. Set `REFACTORING_MINER_JAVA_HOME` to a Java 21 runtime if your system `JAVA_HOME` points at Java 17.

RefactoringMiner is called with the local-repository commit mode:

```bash
RefactoringMiner -c <repo-path> <commit-sha> -json <output-file>
```

## Repository Submission Context

Repository-backed sessions are configured in `data/submissions.json` by worksheet row ID. When a row has a submission entry, the backend builds a compact repository context and sends it to the Realtime model as a hidden system message after the call connects.

The context includes:

- assignment and repository metadata
- instructor review focus from `data/submissions.json`
- repository analysis status
- the selected top high-signal commits with reasons, touched files, RefactoringMiner output, and trimmed diffs
- selected final file excerpts with line numbers
- suggested probing questions for the assistant to adapt during the voice call

The backend does not pass the entire commit history or entire repository to the model. For the example assignment row, `topCommitCount` is `3`, `requireRefactoringMiner` is `true`, and `ignoreCommitPrefixes` excludes scaffold/documentation/admin commits so the assistant focuses on code the student actually wrote.

Preview the exact context without an OpenAI key:

```bash
npm run inspect:submission -- 2
```

The inspection command is diagnostic: it still prints the context preview when RefactoringMiner is missing, including the missing-tool status, so setup problems can be fixed before starting a call.

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
