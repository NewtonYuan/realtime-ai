export type VoiceCallStatus =
  | "idle"
  | "requesting-microphone"
  | "connecting"
  | "connected"
  | "ending";

export type VoiceCallEvent =
  | { type: "status"; status: VoiceCallStatus; message: string }
  | { type: "event"; message: string }
  | {
      type: "transcript";
      entryId: string;
      speaker: "user" | "assistant";
      text: string;
      isFinal: boolean;
    }
  | { type: "error"; message: string };

type Subscriber = (event: VoiceCallEvent) => void;

type StartCallOptions = {
  apiBaseUrl: string;
  model: string;
  respondentRowId: number;
};

type ClientSecretResponse = {
  value: string;
  expires_at?: number;
  voice?: string;
  instructions?: string;
  initialGreeting?: string;
  questionDocumentContext?: string;
  studentResponseContext?: string;
  submissionContext?: string;
};

class VoiceCallService {
  private mediaStream: MediaStream | null = null;

  private peerConnection: RTCPeerConnection | null = null;

  private dataChannel: RTCDataChannel | null = null;

  private remoteAudioElement: HTMLAudioElement | null = null;

  private status: VoiceCallStatus = "idle";

  private voice = "marin";

  private subscribers = new Set<Subscriber>();

  private pendingSessionInstructions: string | null = null;

  private pendingInitialGreeting: string | null = null;

  private pendingQuestionDocumentContext: string | null = null;

  private pendingStudentResponseContext: string | null = null;

  private pendingSubmissionContext: string | null = null;

  private hasAppliedSessionUpdate = false;

  private hasInjectedContext = false;

  private hasStartedInitialResponse = false;

  private transcriptEntries = new Map<
    string,
    { speaker: "user" | "assistant"; text: string; isFinal: boolean }
  >();

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
      this.transcriptEntries.clear();
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      this.mediaStream = stream;

      this.updateStatus(
        "connecting",
        "Microphone ready. Creating the Realtime session.",
      );

      const clientSecret = await this.fetchClientSecret(options);
      this.voice = clientSecret.voice;
      this.pendingSessionInstructions = clientSecret.instructions;
      this.pendingInitialGreeting = clientSecret.initialGreeting;
      this.pendingQuestionDocumentContext = clientSecret.questionDocumentContext;
      this.pendingStudentResponseContext = clientSecret.studentResponseContext;
      this.pendingSubmissionContext = clientSecret.submissionContext;
      this.hasAppliedSessionUpdate = false;
      this.hasInjectedContext = false;
      this.hasStartedInitialResponse = false;
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
        this.handleRealtimeServerMessage(event.data);
        const parsedEvents = this.parseServerEvent(event.data);
        parsedEvents.forEach((parsedEvent) => {
          this.publish(parsedEvent);
        });
      });

      const offer = await peerConnection.createOffer();
      await peerConnection.setLocalDescription(offer);

      const answerSdp = await this.fetchSdpAnswer(clientSecret.value, offer.sdp ?? "");

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
    this.pendingSessionInstructions = null;
    this.pendingInitialGreeting = null;
    this.pendingQuestionDocumentContext = null;
    this.pendingStudentResponseContext = null;
    this.pendingSubmissionContext = null;
    this.hasAppliedSessionUpdate = false;
    this.hasInjectedContext = false;
    this.hasStartedInitialResponse = false;

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

    this.transcriptEntries.clear();
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

  getVoice(): string {
    return this.voice;
  }

  private async fetchClientSecret({
    apiBaseUrl,
    model,
    respondentRowId,
  }: StartCallOptions): Promise<{
    value: string;
    voice: string;
    instructions: string | null;
    initialGreeting: string | null;
    questionDocumentContext: string | null;
    studentResponseContext: string | null;
    submissionContext: string | null;
  }> {
    const response = await fetch(`${apiBaseUrl}/api/realtime/client-secret`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model, respondentRowId }),
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

    return {
      value: payload.value,
      voice: payload.voice?.trim() || this.voice,
      instructions:
        "instructions" in payload && typeof payload.instructions === "string"
          ? payload.instructions
          : null,
      initialGreeting:
        "initialGreeting" in payload && typeof payload.initialGreeting === "string"
          ? payload.initialGreeting
          : null,
      questionDocumentContext:
        "questionDocumentContext" in payload &&
        typeof payload.questionDocumentContext === "string"
          ? payload.questionDocumentContext
          : null,
      studentResponseContext:
        "studentResponseContext" in payload &&
        typeof payload.studentResponseContext === "string"
          ? payload.studentResponseContext
          : null,
      submissionContext:
        "submissionContext" in payload &&
        typeof payload.submissionContext === "string"
          ? payload.submissionContext
          : null,
    };
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

  private handleRealtimeServerMessage(rawEvent: string): void {
    try {
      const event = JSON.parse(rawEvent) as RealtimeServerEvent;

      if (event.type === "session.created" && !this.hasAppliedSessionUpdate) {
        this.hasAppliedSessionUpdate = true;
        this.sendSessionUpdate();
        return;
      }

      if (event.type === "session.updated" && !this.hasInjectedContext) {
        this.hasInjectedContext = true;
        this.injectSessionContext();
        this.hasStartedInitialResponse = true;
        this.sendInitialPrompt();
      }
    } catch {
      // Ignore non-JSON control messages here; parseServerEvent handles user-visible logging.
    }
  }

  private sendSessionUpdate(): void {
    if (!this.pendingSessionInstructions) {
      return;
    }

    this.sendRealtimeEvent({
      type: "session.update",
      session: {
        type: "realtime",
        instructions: this.pendingSessionInstructions,
      },
    });
  }

  private injectSessionContext(): void {
    if (this.pendingQuestionDocumentContext) {
      this.sendRealtimeEvent({
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "system",
          content: [
            {
              type: "input_text",
              text: this.pendingQuestionDocumentContext,
            },
          ],
        },
      });
    }

    if (this.pendingStudentResponseContext) {
      this.sendRealtimeEvent({
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "system",
          content: [
            {
              type: "input_text",
              text: this.pendingStudentResponseContext,
            },
          ],
        },
      });
    }

    if (this.pendingSubmissionContext) {
      this.sendRealtimeEvent({
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "system",
          content: [
            {
              type: "input_text",
              text: this.pendingSubmissionContext,
            },
          ],
        },
      });
    }
  }

  private sendInitialPrompt(): void {
    const greeting = this.pendingInitialGreeting ?? "Welcome to the feedback session.";
    const reviewInstruction = this.pendingSubmissionContext
      ? [
          "Wait for the student to confirm readiness before asking about the code submission.",
          "After confirmation, say briefly that you will ask about their code and then ask one probing question grounded in the repository context.",
          "Do not ask the student to choose a worksheet question number.",
          "Use the repository submission context as the main basis for the interaction.",
          "Ask about concrete files, methods, commits, tests, and design choices.",
          "After the student answers, ask one deeper follow-up about the same code path before moving to another topic.",
        ]
      : [
          "Wait for the student to confirm readiness before asking which question number they want to start with.",
          "Use only the provided questions and the selected response row as the basis for the interaction.",
          "After reading a selected question and summarizing the saved answer, ask one probing follow-up about the student's reasoning, assumptions, or edge cases.",
          "Keep the conversation focused on the feedback session, the provided questions, and the selected response row.",
        ];

    this.sendRealtimeEvent({
      type: "response.create",
      response: {
        instructions: [
          `Start now by saying exactly: ${greeting}`,
          "Speak only in English.",
          "Immediately after the greeting, ask if the student is ready to continue.",
          "Do not review any question yet.",
          ...reviewInstruction,
          "If the user goes off-topic, redirect with: Let's get back to the topic of the feedback session.",
          "If the user asks for another language, stay in English and return to the feedback session.",
        ].join(" "),
      },
    });
  }

  private sendRealtimeEvent(event: Record<string, unknown>): void {
    if (!this.dataChannel || this.dataChannel.readyState !== "open") {
      return;
    }

    this.dataChannel.send(JSON.stringify(event));
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

  private parseServerEvent(rawEvent: string): VoiceCallEvent[] {
    try {
      const parsed = JSON.parse(rawEvent) as RealtimeServerEvent;
      if (parsed.type === "error") {
        return [
          {
            type: "error",
            message:
              parsed.error?.message ||
              parsed.message ||
              "Received a Realtime API error event.",
          },
        ];
      }

      const events: VoiceCallEvent[] = [
        {
          type: "event",
          message: parsed.type
            ? parsed.error?.message
              ? `Realtime event: ${parsed.type} - ${parsed.error.message}`
              : `Realtime event: ${parsed.type}`
            : "Received a Realtime server event.",
        },
      ];
      const transcriptEvent = this.extractTranscriptEvent(parsed);

      if (transcriptEvent) {
        events.push(transcriptEvent);
      }

      return events;
    } catch {
      return [
        {
          type: "event",
          message: "Received a Realtime server event.",
        },
      ];
    }
  }

  private extractTranscriptEvent(
    event: RealtimeServerEvent,
  ): Extract<VoiceCallEvent, { type: "transcript" }> | null {
    if (event.type === "conversation.item.input_audio_transcription.delta") {
      return this.upsertTranscriptEntry({
        entryId: event.item_id ?? "user-input",
        speaker: "user",
        text: event.delta ?? "",
        isFinal: false,
        append: true,
      });
    }

    if (event.type === "conversation.item.input_audio_transcription.completed") {
      return this.upsertTranscriptEntry({
        entryId: event.item_id ?? "user-input",
        speaker: "user",
        text: event.transcript ?? "",
        isFinal: true,
        append: false,
      });
    }

    if (event.type === "response.audio_transcript.delta") {
      return this.upsertTranscriptEntry({
        entryId:
          event.item_id ?? `${event.response_id ?? "response"}:${event.output_index ?? 0}`,
        speaker: "assistant",
        text: event.delta ?? "",
        isFinal: false,
        append: true,
      });
    }

    if (event.type === "response.audio_transcript.done") {
      return this.upsertTranscriptEntry({
        entryId:
          event.item_id ?? `${event.response_id ?? "response"}:${event.output_index ?? 0}`,
        speaker: "assistant",
        text: event.transcript ?? "",
        isFinal: true,
        append: false,
      });
    }

    if (event.type === "response.output_text.delta") {
      return this.upsertTranscriptEntry({
        entryId:
          event.item_id ?? `${event.response_id ?? "response"}:${event.output_index ?? 0}`,
        speaker: "assistant",
        text: event.delta ?? "",
        isFinal: false,
        append: true,
      });
    }

    if (event.type === "response.output_text.done") {
      return this.upsertTranscriptEntry({
        entryId:
          event.item_id ?? `${event.response_id ?? "response"}:${event.output_index ?? 0}`,
        speaker: "assistant",
        text: event.text ?? "",
        isFinal: true,
        append: false,
      });
    }

    return null;
  }

  private upsertTranscriptEntry({
    entryId,
    speaker,
    text,
    isFinal,
    append,
  }: {
    entryId: string;
    speaker: "user" | "assistant";
    text: string;
    isFinal: boolean;
    append: boolean;
  }): Extract<VoiceCallEvent, { type: "transcript" }> | null {
    const nextText = text.trim();

    if (!nextText) {
      return null;
    }

    const existingEntry = this.transcriptEntries.get(entryId);
    const mergedText = append && existingEntry ? `${existingEntry.text}${text}` : text;
    const normalizedText = mergedText.trim();

    this.transcriptEntries.set(entryId, {
      speaker,
      text: normalizedText,
      isFinal,
    });

    return {
      type: "transcript",
      entryId,
      speaker,
      text: normalizedText,
      isFinal,
    };
  }
}

type RealtimeServerEvent = {
  type?: string;
  item_id?: string;
  response_id?: string;
  output_index?: number;
  delta?: string;
  transcript?: string;
  text?: string;
  message?: string;
  error?: {
    message?: string;
  };
};

export const voiceCallService = new VoiceCallService();
