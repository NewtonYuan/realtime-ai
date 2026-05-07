import { useEffect, useState } from "react";
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

type TranscriptItem = {
  id: string;
  speaker: "system" | "user" | "assistant" | "error";
  text: string;
  isFinal: boolean;
};

function App() {
  const [status, setStatus] = useState<VoiceCallStatus>("idle");
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [isMuted, setIsMuted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isBusy, setIsBusy] = useState(false);
  const [lastEvent, setLastEvent] = useState<VoiceCallEvent | null>(null);
  const [realtimeVoice, setRealtimeVoice] = useState(voiceCallService.getVoice());
  const [transcriptItems, setTranscriptItems] = useState<TranscriptItem[]>([]);

  const isConnected = status === "connected";
  const lastEventMessage =
    lastEvent?.type === "status" || lastEvent?.type === "event" || lastEvent?.type === "error"
      ? lastEvent.message
      : lastEvent?.type === "transcript"
        ? `${lastEvent.speaker === "user" ? "You" : "Assistant"}: ${lastEvent.text}`
        : "No realtime events yet.";

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

        appendTranscriptItem({
          id: `status-${Date.now()}-${event.status}`,
          speaker: "system",
          text: event.message,
          isFinal: true,
        });
      }

      if (event.type === "error") {
        setError(event.message);
        setIsBusy(false);
        setStatus("idle");
        appendTranscriptItem({
          id: `error-${Date.now()}`,
          speaker: "error",
          text: event.message,
          isFinal: true,
        });
      }

      if (event.type === "event") {
        appendTranscriptItem({
          id: `event-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          speaker: "system",
          text: event.message,
          isFinal: true,
        });
      }

      if (event.type === "transcript") {
        setTranscriptItems((currentItems) => {
          const existingIndex = currentItems.findIndex(
            (item) => item.id === event.entryId,
          );

          if (existingIndex === -1) {
            return [
              ...currentItems,
              {
                id: event.entryId,
                speaker: event.speaker,
                text: event.text,
                isFinal: event.isFinal,
              },
            ];
          }

          return currentItems.map((item) =>
            item.id === event.entryId
              ? {
                  ...item,
                  text: event.text,
                  isFinal: event.isFinal,
                }
              : item,
          );
        });
      }
    });

    return unsubscribe;
  }, []);

  function appendTranscriptItem(item: TranscriptItem) {
    setTranscriptItems((currentItems) => [...currentItems, item]);
  }

  async function handleStartCall() {
    setError(null);
    setLastEvent(null);
    setIsBusy(true);
    setTranscriptItems([
      {
        id: "system-start",
        speaker: "system",
        text: "Starting a new call.",
        isFinal: true,
      },
    ]);

    try {
      await voiceCallService.startCall({
        apiBaseUrl,
        model: realtimeModel,
      });
      setStatus("connected");
      setIsMuted(voiceCallService.isMuted());
      setRealtimeVoice(voiceCallService.getVoice());
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
      <section className="app-grid">
        <div className="call-card">
          <div className="details-grid">
            <div className="detail-panel">
              <span className="detail-label">Call status</span>
              <strong>{statusLabels[status]}</strong>
            </div>
            <div className="detail-panel">
              <span className="detail-label">Elapsed time</span>
              <strong>{formatElapsedTime(elapsedSeconds)}</strong>
            </div>
            <div className="detail-panel">
              <span className="detail-label">Realtime voice</span>
              <strong>{realtimeVoice}</strong>
            </div>
          </div>

          <div className="detail-panel event-panel">
            <span className="detail-label">Connection details</span>
            <strong>{lastEventMessage}</strong>
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

        </div>

        <aside className="call-card transcript-card">
          <div className="card-header transcript-header">
            <div>
              <h2>Transcript</h2>
            </div>
          </div>

          <div className="transcript-list" aria-live="polite">
            {transcriptItems.map((item) => (
              <article
                key={item.id}
                className={`transcript-item transcript-${item.speaker}`}
              >
                <span className="transcript-speaker">
                  {item.speaker === "system"
                    ? "System"
                    : item.speaker === "error"
                      ? "Error"
                      : item.speaker === "user"
                        ? "You"
                        : "Assistant"}
                </span>
                <p>{item.text}</p>
                {!item.isFinal ? (
                  <span className="transcript-state">In progress</span>
                ) : null}
              </article>
            ))}
          </div>
        </aside>
      </section>
    </main>
  );
}

export default App;
