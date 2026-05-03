import { useEffect, useMemo, useState } from "react";
import {
  type VoiceCallEvent,
  type VoiceCallStatus,
  voiceCallService,
} from "./services/voiceCall";

const statusLabels: Record<VoiceCallStatus, string> = {
  idle: "Ready",
  "requesting-microphone": "Microphone",
  connecting: "Connecting",
  connected: "Connected",
  ending: "Ending",
};

const apiBaseUrl =
  import.meta.env.VITE_API_BASE_URL?.trim() || "http://localhost:3000";
const realtimeModel =
  import.meta.env.VITE_OPENAI_REALTIME_MODEL?.trim() || "gpt-realtime";

function formatElapsedTime(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60)
    .toString()
    .padStart(2, "0");
  const seconds = (totalSeconds % 60).toString().padStart(2, "0");

  return `${minutes}:${seconds}`;
}

function App() {
  const [status, setStatus] = useState<VoiceCallStatus>("idle");
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [isMuted, setIsMuted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isBusy, setIsBusy] = useState(false);
  const [lastEvent, setLastEvent] = useState<VoiceCallEvent | null>(null);

  const isConnected = status === "connected";

  useEffect(() => {
    if (!isConnected) {
      setElapsedSeconds(0);
      return;
    }

    const intervalId = window.setInterval(() => {
      setElapsedSeconds((current) => current + 1);
    }, 1000);

    return () => window.clearInterval(intervalId);
  }, [isConnected]);

  useEffect(() => {
    return () => {
      void voiceCallService.endCall();
    };
  }, []);

  useEffect(() => {
    const unsubscribe = voiceCallService.subscribe((event) => {
      setLastEvent(event);

      if (event.type === "status") {
        setStatus(event.status);

        if (event.status === "idle") {
          setIsBusy(false);
          setIsMuted(false);
        }
      }

      if (event.type === "error") {
        setError(event.message);
        setIsBusy(false);
        setStatus("idle");
      }
    });

    return unsubscribe;
  }, []);

  const statusMessage = useMemo(() => {
    if (status === "requesting-microphone") {
      return "Approve microphone access in your browser to continue.";
    }

    if (status === "connecting") {
      return "Creating the OpenAI Realtime session and completing the WebRTC handshake.";
    }

    if (status === "connected") {
      return "The microphone and Realtime connection are active. Start speaking after the connection settles.";
    }

    if (status === "ending") {
      return "Ending the call and cleaning up the peer connection and microphone stream.";
    }

    return "Start a call to request microphone access and connect the browser to OpenAI Realtime.";
  }, [status]);

  async function handleStartCall() {
    setError(null);
    setLastEvent(null);
    setIsBusy(true);

    try {
      await voiceCallService.startCall({
        apiBaseUrl,
        model: realtimeModel,
      });
      setStatus("connected");
      setIsMuted(voiceCallService.isMuted());
      setElapsedSeconds(0);
    } catch (serviceError) {
      setStatus("idle");
      setError(
        serviceError instanceof Error
          ? serviceError.message
          : "Unable to start the voice call.",
      );
    } finally {
      setIsBusy(false);
    }
  }

  async function handleEndCall() {
    setError(null);
    setIsBusy(true);
    setStatus("ending");

    try {
      await voiceCallService.endCall();
      setStatus("idle");
      setIsMuted(false);
    } catch (serviceError) {
      setStatus("idle");
      setError(
        serviceError instanceof Error
          ? serviceError.message
          : "Unable to end the voice call cleanly.",
      );
    } finally {
      setIsBusy(false);
    }
  }

  function handleToggleMute() {
    try {
      const nextMutedState = voiceCallService.toggleMute();
      setIsMuted(nextMutedState);
    } catch (serviceError) {
      setError(
        serviceError instanceof Error
          ? serviceError.message
          : "Unable to update microphone state.",
      );
    }
  }

  return (
    <main className="app-shell">
      <section className="call-card">
        <div className="card-header">
          <div>
            <p className="eyebrow">Realtime UI Starter</p>
            <h1>AI Voice Call</h1>
          </div>
          <span className={`status-pill status-${status}`}>{statusLabels[status]}</span>
        </div>

        <p className="supporting-text">{statusMessage}</p>

        <div className="details-grid">
          <div className="detail-panel">
            <span className="detail-label">Call status</span>
            <strong>{statusLabels[status]}</strong>
          </div>
          <div className="detail-panel">
            <span className="detail-label">Elapsed time</span>
            <strong>{formatElapsedTime(elapsedSeconds)}</strong>
          </div>
        </div>

        <div className="detail-panel event-panel">
          <span className="detail-label">Connection details</span>
          <strong>{lastEvent?.message ?? "No realtime events yet."}</strong>
          <span className="detail-caption">Model: {realtimeModel}</span>
        </div>

        {error ? <div className="feedback error">{error}</div> : null}
        {isBusy ? <div className="feedback loading">Updating call state...</div> : null}

        <div className="controls">
          <button
            className="primary-button"
            onClick={handleStartCall}
            disabled={isConnected || isBusy}
            type="button"
          >
            {status === "connecting" ? "Starting..." : "Start Voice Call"}
          </button>

          <div className="secondary-controls">
            <button
              className="secondary-button"
              onClick={handleToggleMute}
              disabled={!isConnected || isBusy}
              type="button"
            >
              {isMuted ? "Unmute Microphone" : "Mute Microphone"}
            </button>
            <button
              className="danger-button"
              onClick={handleEndCall}
              disabled={!isConnected || isBusy}
              type="button"
            >
              End Call
            </button>
          </div>
        </div>
      </section>
    </main>
  );
}

export default App;
