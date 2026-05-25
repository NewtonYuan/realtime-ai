import "dotenv/config";
import cors from "cors";
import express from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import xlsx from "xlsx";

const app = express();
const port = Number(process.env.PORT || 3000);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const questionsFilePath = path.resolve(__dirname, "../data/questions.txt");
const responsesFilePath = path.resolve(__dirname, "../data/responses.xlsx");

const defaultModel = process.env.VITE_OPENAI_REALTIME_MODEL?.trim() || "gpt-realtime";
const defaultVoice = process.env.OPENAI_REALTIME_VOICE?.trim() || "marin";

app.use(cors());
app.use(express.json());

app.get("/api/health", (_request, response) => {
  response.json({ ok: true });
});

app.get("/api/questions", (_request, response) => {
  response.json({
    file: questionsFilePath,
    questions: loadQuestions(),
  });
});

app.get("/api/respondents/:rowId", (request, response) => {
  const rowId = parseRowId(request.params.rowId);

  if (rowId === null) {
    response.status(400).json({
      error: "Row ID must be a positive worksheet row number.",
    });
    return;
  }

  const respondent = loadRespondentByRowId(rowId);

  if (!respondent) {
    response.status(404).json({
      error: `No response row was found for worksheet row ${rowId}.`,
    });
    return;
  }

  response.json({
    respondent,
  });
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
  const respondentRowId = parseRowId(request.body?.respondentRowId);
  const respondent = respondentRowId === null ? null : loadRespondentByRowId(respondentRowId);
  const realtimeInstructions = buildRealtimeInstructions({ respondent });
  const initialGreeting = respondent
    ? `Welcome to the feedback session ${respondent.rowId}.`
    : "Welcome to the feedback session.";
  const questionDocumentContext = buildQuestionDocumentContext();
  const studentResponseContext = respondent
    ? buildStudentResponseContext(respondent)
    : null;

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
            instructions: realtimeInstructions,
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
      instructions: realtimeInstructions,
      initialGreeting,
      questionDocumentContext,
      studentResponseContext,
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

function buildRealtimeInstructions({ respondent } = {}) {
  const configuredInstructions = process.env.OPENAI_REALTIME_INSTRUCTIONS?.trim();

  if (configuredInstructions) {
    return configuredInstructions;
  }

  const questions = loadQuestions();
  const fullQuestionDocument = loadQuestionDocument();
  const reviewPairs = respondent ? buildReviewPairs(respondent) : [];
  const totalQuestionCount = reviewPairs.length;

  if (questions.length === 0) {
    return "You are a concise and helpful voice assistant.";
  }

  const respondentContext = respondent
    ? [
        `Current worksheet row ID: ${respondent.rowId}.`,
        "The selected worksheet row is the student's feedback record for this session.",
        "Treat the row ID as the user identifier for this app session.",
        "The user's prior written responses are provided as background context.",
        "Use them to personalize the conversation, but still ask the spoken feedback questions in order.",
        "If a prior response already answers the current question, briefly acknowledge that and ask the user to confirm, expand, or clarify it verbally.",
        "",
        "Selected worksheet row summary:",
        `State: ${respondent.state || "[Unknown]"}`,
        `Started on: ${respondent.startedOn || "[Unknown]"}`,
        `Completed: ${respondent.completed || "[Unknown]"}`,
        `Time taken: ${respondent.timeTaken || "[Unknown]"}`,
        `Grade: ${respondent.grade || "[Unknown]"}`,
        "",
        "Selected worksheet row responses:",
        respondent.responses
          .map(
            ({ questionNumber, questionLabel, responseText }) =>
              `${questionNumber}. ${questionLabel}\nPrior response: ${responseText || "[No response recorded]"}`,
          )
          .join("\n\n"),
        "",
        "Exact review pairs to use in this session:",
        reviewPairs
          .map(
            ({ questionNumber, questionText, responseText }) =>
              `Question ${questionNumber}:\n${questionText}\nStudent response:\n${responseText || "[No response recorded]"}`,
          )
          .join("\n\n"),
        "",
      ].join("\n")
    : "";

  return [
    "You are conducting a spoken feedback review tied to a specific worksheet row.",
    "This is not a general assistant conversation.",
    "Speak only in English.",
    "Only discuss the exact question-response pairs provided in this session.",
    "Do not invent, paraphrase, merge, simplify, or substitute questions.",
    "Treat questions.txt as the source of truth for the question text.",
    "Follow this interaction flow exactly.",
    "Step 1. Start by saying exactly: Welcome to the feedback session {row id}. Replace {row id} with the actual worksheet row ID.",
    "Step 2. Immediately ask if the student is ready to continue.",
    "Step 3. Wait for the student to confirm readiness.",
    `Step 4. After confirmation, ask exactly which question they want to start with out of the ${totalQuestionCount} questions.`,
    "Step 5. Wait for the student to answer with a question number.",
    "Step 6. When the student selects a question number, read the exact question text for that number out loud.",
    "Step 7. After reading the exact question, give a short summary of the student's corresponding written answer from the selected worksheet row.",
    "Step 8. Keep the discussion centered on that selected question and answer unless the student chooses another question number.",
    "If the student picks an invalid question number, tell them the valid range and ask again.",
    "If the student asks to move to another question, ask which question number they want next.",
    "If the response is blank, minimal, off-topic, or mismatched, say that clearly in the summary.",
    "If the user goes off-topic or asks for unrelated help, reply with a short redirect such as: Let's get back to the topic of the feedback session.",
    "If the user speaks in another language or asks for another language, reply in English and redirect back to the feedback session.",
    "Do not answer unrelated questions in detail.",
    "Do not behave like a generic assistant.",
    "",
    "Full question document:",
    fullQuestionDocument,
    "",
    respondentContext,
  ].join("\n");
}

function loadQuestions() {
  return loadQuestionSections()
    .filter((question) => !question.isIgnored)
    .map((question) => question.text);
}

function loadQuestionSections() {
  try {
    const rawQuestions = fs.readFileSync(questionsFilePath, "utf8");

    return parseQuestionSections(rawQuestions);
  } catch (error) {
    console.warn(
      `Unable to load questions from ${questionsFilePath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return [];
  }
}

function loadQuestionDocument() {
  try {
    return fs.readFileSync(questionsFilePath, "utf8").trim();
  } catch (error) {
    console.warn(
      `Unable to load raw question document from ${questionsFilePath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return "";
  }
}

function parseQuestionSections(rawQuestions) {
  const normalizedText = rawQuestions.replace(/\r\n/g, "\n");
  const sections = normalizedText.split(/(?=^Q\d+\))/gm);

  return sections
    .filter((section) => /^Q\d+\)/m.test(section))
    .map((section) => section.trim())
    .filter(Boolean)
    .map((questionText) => ({
      questionNumber: getQuestionNumber(questionText),
      text: questionText,
      isIgnored: /ignore/i.test(questionText),
    }))
    .filter((question) => question.questionNumber !== null);
}

function parseRowId(value) {
  const parsedValue = Number.parseInt(String(value ?? ""), 10);

  if (!Number.isInteger(parsedValue) || parsedValue < 2) {
    return null;
  }

  return parsedValue;
}

function loadRespondentByRowId(rowId) {
  try {
    const workbook = xlsx.readFile(responsesFilePath);
    const [firstSheetName] = workbook.SheetNames;

    if (!firstSheetName) {
      return null;
    }

    const worksheet = workbook.Sheets[firstSheetName];
    const rows = xlsx.utils.sheet_to_json(worksheet, {
      defval: "",
    });
    const rowIndex = rowId - 2;
    const row = rows[rowIndex];

    if (!row) {
      return null;
    }

    const questionSections = loadQuestionSections();
    const responseEntries = Object.keys(row)
      .filter((key) => /^Response \d+$/i.test(String(key)))
      .sort(
        (left, right) =>
          getResponseColumnNumber(left) - getResponseColumnNumber(right),
      )
      .map((columnName) => {
        const questionNumber = getResponseColumnNumber(columnName);
        const matchingQuestion = questionSections.find(
          (question) => question.questionNumber === questionNumber,
        );

        return {
          questionNumber,
          questionLabel: matchingQuestion?.text ?? columnName,
          isIgnored: matchingQuestion?.isIgnored ?? false,
          responseText: String(row[columnName] ?? "").trim(),
        };
      });

    return {
      rowId,
      state: String(row.State ?? "").trim(),
      startedOn: String(row["Started on"] ?? "").trim(),
      completed: String(row.Completed ?? "").trim(),
      timeTaken: String(row["Time taken"] ?? "").trim(),
      grade: String(row["Grade/8.00"] ?? "").trim(),
      answeredCount: responseEntries.filter((entry) => entry.responseText).length,
      questionCount: responseEntries.length,
      responses: responseEntries.map(({ isIgnored, ...entry }) => entry),
    };
  } catch (error) {
    console.warn(
      `Unable to load responses from ${responsesFilePath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return null;
  }
}

function buildReviewPairs(respondent) {
  return respondent.responses.map((response) => ({
    questionNumber: response.questionNumber,
    questionText: response.questionLabel,
    responseText: response.responseText,
  }));
}

function buildQuestionDocumentContext() {
  const questionDocument = loadQuestionDocument();

  return [
    "The following text is the full contents of questions.txt.",
    "These are the exact questions asked in the task.",
    "Use this file as the source of truth for the question wording and numbering.",
    "",
    questionDocument || "[questions.txt could not be loaded]",
  ].join("\n");
}

function buildStudentResponseContext(respondent) {
  return [
    `The following responses belong to the student currently in the call.`,
    `This current caller is worksheet row ID ${respondent.rowId}.`,
    "These are the student's own submitted responses for this feedback session.",
    "",
    respondent.responses
      .map(
        ({ questionNumber, questionLabel, responseText }) =>
          `Question ${questionNumber}\nExact question from task:\n${questionLabel}\nStudent's response in this row:\n${responseText || "[No response recorded]"}`,
      )
      .join("\n\n"),
  ].join("\n");
}

function getQuestionNumber(questionText) {
  const match = String(questionText).match(/^Q(\d+)\)/m);

  return match ? Number.parseInt(match[1], 10) : null;
}

function getResponseColumnNumber(columnName) {
  const match = String(columnName).match(/\d+/);

  return match ? Number.parseInt(match[0], 10) : Number.MAX_SAFE_INTEGER;
}
