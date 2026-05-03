export type VoiceCallStatus =
  | "idle"
  | "requesting-microphone"
  | "connecting"
  | "connected"
  | "ending";

export type VoiceCallEvent =
  | { type: "status"; status: VoiceCallStatus; message: string }
  | { type: "event"; message: string }
  | { type: "error"; message: string };

type Subscriber = (event: VoiceCallEvent) => void;

type StartCallOptions = {
  apiBaseUrl: string;
  model: string;
};

type ClientSecretResponse = {
  value: string;
  expires_at?: number;
};

class VoiceCallService {
  private mediaStream: MediaStream | null = null;

  private peerConnection: RTCPeerConnection | null = null;

  private dataChannel: RTCDataChannel | null = null;

  private remoteAudioElement: HTMLAudioElement | null = null;

  private status: VoiceCallStatus = "idle";

  private subscribers = new Set<Subscriber>();

  subscribe(subscriber: Subscriber): () => void {
    this.subscribers.add(subscriber);

    return () => {
      this.subscribers.delete(subscriber);
    };
  }

  async startCall(options: StartCallOptions): Promise<void> {
    if (this.status !== "idle") {
      throw new Error("A call is already active.");
    }

    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("This browser does not support microphone access.");
    }

    this.updateStatus(
      "requesting-microphone",
      "Waiting for microphone permission.",
    );

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      this.mediaStream = stream;

      this.updateStatus(
        "connecting",
        "Microphone ready. Creating the Realtime session.",
      );

      const ephemeralKey = await this.fetchClientSecret(options);
      const peerConnection = new RTCPeerConnection();
      this.peerConnection = peerConnection;

      this.remoteAudioElement = document.createElement("audio");
      this.remoteAudioElement.autoplay = true;
      this.remoteAudioElement.setAttribute("playsinline", "true");

      peerConnection.ontrack = (event) => {
        if (this.remoteAudioElement) {
          this.remoteAudioElement.srcObject = event.streams[0];
          void this.remoteAudioElement.play().catch(() => undefined);
        }

        this.publish({
          type: "event",
          message: "Receiving remote audio from the model.",
        });
      };

      peerConnection.onconnectionstatechange = () => {
        const connectionState = peerConnection.connectionState;

        if (connectionState === "connected") {
          this.updateStatus("connected", "Realtime call connected.");
          return;
        }

        if (connectionState === "failed" || connectionState === "disconnected") {
          const message = `Realtime connection ${connectionState}.`;
          this.publish({ type: "error", message });
          void this.endCall();
        }
      };

      stream.getTracks().forEach((track) => {
        peerConnection.addTrack(track, stream);
      });

      this.dataChannel = peerConnection.createDataChannel("oai-events");
      this.dataChannel.addEventListener("open", () => {
        this.publish({
          type: "event",
          message: "Realtime control channel open.",
        });
      });
      this.dataChannel.addEventListener("message", (event) => {
        const parsedMessage = this.parseServerEvent(event.data);
        this.publish({
          type: "event",
          message: parsedMessage,
        });
      });

      const offer = await peerConnection.createOffer();
      await peerConnection.setLocalDescription(offer);

      const answerSdp = await this.fetchSdpAnswer(ephemeralKey, offer.sdp ?? "");

      await peerConnection.setRemoteDescription({
        type: "answer",
        sdp: answerSdp,
      });

      this.updateStatus("connected", "Realtime call connected.");
    } catch (error) {
      await this.endCall();

      if (error instanceof Error) {
        throw error;
      }

      throw new Error("Unable to start the voice call.");
    }
  }

  async endCall(): Promise<void> {
    if (this.status === "idle") {
      return;
    }

    this.updateStatus("ending", "Closing the active voice call.");

    this.dataChannel?.close();
    this.dataChannel = null;

    this.peerConnection?.close();
    this.peerConnection = null;

    if (this.remoteAudioElement) {
      this.remoteAudioElement.srcObject = null;
      this.remoteAudioElement.remove();
      this.remoteAudioElement = null;
    }

    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach((track) => track.stop());
      this.mediaStream = null;
    }

    this.updateStatus("idle", "Voice call ended.");
  }

  toggleMute(): boolean {
    const audioTracks = this.getAudioTracks();

    if (audioTracks.length === 0) {
      throw new Error("No microphone track is available.");
    }

    const nextEnabled = !audioTracks[0].enabled;
    audioTracks.forEach((track) => {
      track.enabled = nextEnabled;
    });

    return !nextEnabled;
  }

  isMuted(): boolean {
    const audioTracks = this.getAudioTracks();

    if (audioTracks.length === 0) {
      return false;
    }

    return audioTracks.every((track) => !track.enabled);
  }

  getStatus(): VoiceCallStatus {
    return this.status;
  }

  getStream(): MediaStream | null {
    return this.mediaStream;
  }

  private async fetchClientSecret({
    apiBaseUrl,
    model,
  }: StartCallOptions): Promise<string> {
    const response = await fetch(`${apiBaseUrl}/api/realtime/client-secret`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model }),
    });

    const payload = (await response.json()) as
      | ClientSecretResponse
      | { error?: string };

    if (!response.ok || !("value" in payload) || !payload.value) {
      throw new Error(
        "error" in payload && payload.error
          ? payload.error
          : "Unable to fetch a Realtime client secret from the backend.",
      );
    }

    return payload.value;
  }

  private async fetchSdpAnswer(ephemeralKey: string, offerSdp: string): Promise<string> {
    if (!offerSdp) {
      throw new Error("Unable to create a valid WebRTC offer.");
    }

    const response = await fetch("https://api.openai.com/v1/realtime/calls", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ephemeralKey}`,
        "Content-Type": "application/sdp",
      },
      body: offerSdp,
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(
        `OpenAI Realtime connection failed: ${response.status} ${errorBody}`,
      );
    }

    return response.text();
  }

  private getAudioTracks(): MediaStreamTrack[] {
    return this.mediaStream?.getAudioTracks() ?? [];
  }

  private updateStatus(status: VoiceCallStatus, message: string): void {
    this.status = status;
    this.publish({ type: "status", status, message });
  }

  private publish(event: VoiceCallEvent): void {
    this.subscribers.forEach((subscriber) => {
      subscriber(event);
    });
  }

  private parseServerEvent(rawEvent: string): string {
    try {
      const parsed = JSON.parse(rawEvent) as { type?: string };
      return parsed.type
        ? `Realtime event: ${parsed.type}`
        : "Received a Realtime server event.";
    } catch {
      return "Received a Realtime server event.";
    }
  }
}

export const voiceCallService = new VoiceCallService();
