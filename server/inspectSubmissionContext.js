import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildRepositorySubmissionContext } from "./repositoryAnalysis.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const submissionsFilePath = path.resolve(__dirname, "../data/submissions.json");
const rowId = parseRowId(process.argv[2]);

if (rowId === null) {
  console.error("Usage: npm run inspect:submission -- <worksheet-row-id>");
  process.exit(1);
}

const submission = loadSubmissionByRowId(rowId);

if (!submission) {
  console.error(`No repository submission is configured for worksheet row ${rowId}.`);
  process.exit(1);
}

console.log(
  buildRepositorySubmissionContext(submission, {
    allowMissingRequiredRefactoringMiner: true,
  }),
);

function parseRowId(value) {
  const parsedValue = Number.parseInt(String(value ?? ""), 10);

  if (!Number.isInteger(parsedValue) || parsedValue < 2) {
    return null;
  }

  return parsedValue;
}

function loadSubmissionByRowId(rowId) {
  const config = JSON.parse(fs.readFileSync(submissionsFilePath, "utf8"));
  const submission = config[String(rowId)] || config.rows?.[String(rowId)];

  if (!submission || typeof submission !== "object") {
    return null;
  }

  return {
    ...submission,
    rowId,
    repoPath: resolveConfiguredPath(submission.repoPath),
  };
}

function resolveConfiguredPath(configuredPath) {
  if (!configuredPath || typeof configuredPath !== "string") {
    return "";
  }

  if (path.isAbsolute(configuredPath)) {
    return path.normalize(configuredPath);
  }

  return path.resolve(__dirname, "..", configuredPath);
}
