import "dotenv/config";
import cors from "cors";
import express from "express";

const app = express();
const port = Number(process.env.PORT || 3000);

const defaultModel = process.env.VITE_OPENAI_REALTIME_MODEL?.trim() || "gpt-realtime";
const defaultVoice = process.env.OPENAI_REALTIME_VOICE?.trim() || "marin";
const defaultInstructions =
  process.env.OPENAI_REALTIME_INSTRUCTIONS?.trim() ||
  "You are a concise and helpful voice assistant.";

app.use(cors());
app.use(express.json());

app.get("/api/health", (_request, response) => {
  response.json({ ok: true });
});

app.post("/api/realtime/client-secret", async (request, response) => {
  const apiKey = process.env.OPENAI_API_KEY?.trim();

  if (!apiKey) {
    response.status(500).json({
      error:
        "Missing OPENAI_API_KEY. Add it to your .env file before starting a voice call.",
    });
    return;
  }

  const requestedModel =
    typeof request.body?.model === "string" && request.body.model.trim()
      ? request.body.model.trim()
      : defaultModel;

  try {
    const openAiResponse = await fetch(
      "https://api.openai.com/v1/realtime/client_secrets",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          session: {
            type: "realtime",
            model: requestedModel,
            instructions: defaultInstructions,
            audio: {
              input: {
                turn_detection: {
                  type: "server_vad",
                  create_response: true,
                  interrupt_response: true,
                },
              },
              output: {
                voice: defaultVoice,
              },
            },
          },
        }),
      },
    );

    const payload = await openAiResponse.json();

    if (!openAiResponse.ok) {
      const errorMessage =
        typeof payload?.error?.message === "string"
          ? payload.error.message
          : "OpenAI rejected the Realtime session request.";

      response.status(openAiResponse.status).json({ error: errorMessage });
      return;
    }

    if (typeof payload?.value !== "string" || !payload.value) {
      response.status(502).json({
        error: "OpenAI returned an invalid Realtime client secret payload.",
      });
      return;
    }

    response.json({
      value: payload.value,
      expires_at: payload.expires_at,
      model: requestedModel,
      voice: defaultVoice,
    });
  } catch (error) {
    const errorMessage =
      error instanceof Error
        ? error.message
        : "Unexpected server error while creating a Realtime client secret.";

    response.status(500).json({ error: errorMessage });
  }
});

app.listen(port, () => {
  console.log(`Realtime backend listening on http://localhost:${port}`);
});
