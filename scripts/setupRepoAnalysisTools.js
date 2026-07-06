import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO_TOOLS_MARKER_DIR = path.join(PROJECT_ROOT, ".tools");
const TOOLS_DIR = path.resolve(
  process.env.REPOSITORY_ANALYSIS_TOOLS_DIR || getDefaultToolsDirectory(),
);
const DOWNLOAD_DIR = path.join(TOOLS_DIR, ".downloads");
const MARKER_PATH = path.join(REPO_TOOLS_MARKER_DIR, "repo-analysis-tools.json");
const REFACTORING_MINER_VERSION = process.env.REFACTORING_MINER_VERSION || "3.1.4";
const JAVA_FEATURE_VERSION = process.env.REFACTORING_MINER_JAVA_VERSION || "21";
const REFACTORING_MINER_DIR = path.join(
  TOOLS_DIR,
  `RefactoringMiner-${REFACTORING_MINER_VERSION}`,
);
const JAVA_DIR = path.join(TOOLS_DIR, `java-${JAVA_FEATURE_VERSION}`);

async function main() {
  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });

  const javaHome = await ensureJavaRuntime();
  const refactoringMinerCommand = await ensureRefactoringMiner();
  writeToolsMarker({ javaHome, refactoringMinerCommand });

  console.log("");
  console.log("Repository analysis tools are ready.");
  console.log(`Tools directory: ${TOOLS_DIR}`);
  console.log(`RefactoringMiner: ${refactoringMinerCommand}`);
  console.log(`Java home: ${javaHome}`);
  console.log("");
  console.log("Next test:");
  console.log("  npm run inspect:submission -- 2");
}

function getDefaultToolsDirectory() {
  if (process.platform === "win32") {
    return path.join(process.env.PUBLIC || "C:\\Users\\Public", "co-thinker-repo-analysis");
  }

  return path.join(PROJECT_ROOT, ".tools");
}

function writeToolsMarker({ javaHome, refactoringMinerCommand }) {
  fs.mkdirSync(REPO_TOOLS_MARKER_DIR, { recursive: true });
  fs.writeFileSync(
    MARKER_PATH,
    `${JSON.stringify(
      {
        toolsDir: TOOLS_DIR,
        refactoringMinerVersion: REFACTORING_MINER_VERSION,
        javaFeatureVersion: JAVA_FEATURE_VERSION,
        refactoringMinerCommand,
        javaHome,
      },
      null,
      2,
    )}\n`,
  );
}

async function ensureJavaRuntime() {
  const existingJavaHome = findJavaHome(JAVA_DIR);

  if (existingJavaHome) {
    console.log(`Using existing Java runtime: ${existingJavaHome}`);
    return existingJavaHome;
  }

  const platform = mapAdoptiumPlatform(process.platform);
  const architecture = mapAdoptiumArchitecture(process.arch);
  const archiveExtension = process.platform === "win32" ? "zip" : "tar.gz";
  const archivePath = path.join(
    DOWNLOAD_DIR,
    `temurin-${JAVA_FEATURE_VERSION}-${platform}-${architecture}.${archiveExtension}`,
  );
  const downloadUrl = `https://api.adoptium.net/v3/binary/latest/${JAVA_FEATURE_VERSION}/ga/${platform}/${architecture}/jre/hotspot/normal/eclipse?project=jdk`;

  console.log(`Downloading Temurin Java ${JAVA_FEATURE_VERSION} runtime...`);
  await downloadFile(downloadUrl, archivePath);

  recreateDirectory(JAVA_DIR);
  extractArchive(archivePath, JAVA_DIR);

  const javaHome = findJavaHome(JAVA_DIR);

  if (!javaHome) {
    throw new Error(`Downloaded Java runtime, but no bin/java executable was found in ${JAVA_DIR}.`);
  }

  return javaHome;
}

async function ensureRefactoringMiner() {
  const existingCommand = findRefactoringMinerCommand(REFACTORING_MINER_DIR);

  if (existingCommand) {
    console.log(`Using existing RefactoringMiner: ${existingCommand}`);
    return existingCommand;
  }

  const archivePath = path.join(
    DOWNLOAD_DIR,
    `RefactoringMiner-${REFACTORING_MINER_VERSION}.zip`,
  );
  const asset = await findRefactoringMinerReleaseAsset(REFACTORING_MINER_VERSION);

  console.log(`Downloading RefactoringMiner ${REFACTORING_MINER_VERSION}...`);
  await downloadFile(asset.browser_download_url, archivePath);

  const extractDir = path.join(DOWNLOAD_DIR, `refactoringminer-${Date.now()}`);
  recreateDirectory(extractDir);
  extractArchive(archivePath, extractDir);

  const extractedRoot = findDirectoryContainingRefactoringMiner(extractDir);

  if (!extractedRoot) {
    throw new Error(`Downloaded RefactoringMiner, but no bin/RefactoringMiner executable was found.`);
  }

  removeInsideTools(REFACTORING_MINER_DIR);
  fs.cpSync(extractedRoot, REFACTORING_MINER_DIR, { recursive: true });
  removeInsideTools(extractDir);

  const command = findRefactoringMinerCommand(REFACTORING_MINER_DIR);

  if (!command) {
    throw new Error(`RefactoringMiner was extracted, but no executable was found in ${REFACTORING_MINER_DIR}.`);
  }

  if (process.platform !== "win32") {
    fs.chmodSync(command, 0o755);
  }

  return command;
}

async function findRefactoringMinerReleaseAsset(version) {
  const release = await fetchJson(
    `https://api.github.com/repos/tsantalis/RefactoringMiner/releases/tags/${version}`,
  );
  const assets = Array.isArray(release.assets) ? release.assets : [];
  const asset = assets.find((candidate) => /RefactoringMiner.*\.zip$/i.test(candidate.name));

  if (!asset?.browser_download_url) {
    throw new Error(`No RefactoringMiner zip asset was found for release ${version}.`);
  }

  return asset;
}

function extractArchive(archivePath, destinationPath) {
  if (/\.zip$/i.test(archivePath)) {
    if (process.platform === "win32") {
      const escapedArchivePath = archivePath.replace(/'/g, "''");
      const escapedDestinationPath = destinationPath.replace(/'/g, "''");

      execFileSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-ExecutionPolicy",
          "Bypass",
          "-Command",
          `Expand-Archive -LiteralPath '${escapedArchivePath}' -DestinationPath '${escapedDestinationPath}' -Force`,
        ],
        { stdio: "inherit" },
      );
    } else {
      execFileSync("unzip", ["-q", archivePath, "-d", destinationPath], { stdio: "inherit" });
    }

    return;
  }

  execFileSync("tar", ["-xzf", archivePath, "-C", destinationPath], { stdio: "inherit" });
}

function findRefactoringMinerCommand(rootDirectory) {
  const executable = process.platform === "win32" ? "RefactoringMiner.bat" : "RefactoringMiner";
  const directPath = path.join(rootDirectory, "bin", executable);

  if (fs.existsSync(directPath)) {
    return directPath;
  }

  return findFile(rootDirectory, executable, 4);
}

function findDirectoryContainingRefactoringMiner(rootDirectory) {
  const command = findRefactoringMinerCommand(rootDirectory);

  if (!command) {
    return "";
  }

  return path.dirname(path.dirname(command));
}

function findJavaHome(rootDirectory) {
  const executable = process.platform === "win32" ? "java.exe" : "java";
  const command = findFile(rootDirectory, executable, 5);

  if (!command || path.basename(path.dirname(command)) !== "bin") {
    return "";
  }

  return path.dirname(path.dirname(command));
}

function findFile(rootDirectory, fileName, maxDepth) {
  if (!fs.existsSync(rootDirectory) || maxDepth < 0) {
    return "";
  }

  const entries = fs.readdirSync(rootDirectory, { withFileTypes: true });

  for (const entry of entries) {
    const entryPath = path.join(rootDirectory, entry.name);

    if (entry.isFile() && entry.name === fileName) {
      return entryPath;
    }
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const found = findFile(path.join(rootDirectory, entry.name), fileName, maxDepth - 1);

    if (found) {
      return found;
    }
  }

  return "";
}

function recreateDirectory(directoryPath) {
  removeInsideTools(directoryPath);
  fs.mkdirSync(directoryPath, { recursive: true });
}

function removeInsideTools(targetPath) {
  const resolvedTarget = path.resolve(targetPath);
  const resolvedTools = path.resolve(TOOLS_DIR);
  const relative = path.relative(resolvedTools, resolvedTarget);

  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Refusing to remove path outside the tools directory: ${targetPath}`);
  }

  fs.rmSync(resolvedTarget, { recursive: true, force: true });
}

function mapAdoptiumPlatform(platform) {
  if (platform === "win32") {
    return "windows";
  }

  if (platform === "darwin") {
    return "mac";
  }

  if (platform === "linux") {
    return "linux";
  }

  throw new Error(`Unsupported platform for automatic Java download: ${platform}`);
}

function mapAdoptiumArchitecture(architecture) {
  if (architecture === "x64") {
    return "x64";
  }

  if (architecture === "arm64") {
    return "aarch64";
  }

  throw new Error(`Unsupported CPU architecture for automatic Java download: ${architecture}`);
}

function fetchJson(url) {
  return requestBuffer(url, {
    Accept: "application/vnd.github+json",
    "User-Agent": "co-thinker-repo-analysis-setup",
  }).then((buffer) => JSON.parse(buffer.toString("utf8")));
}

async function downloadFile(url, destinationPath) {
  const buffer = await requestBuffer(url, {
    Accept: "application/octet-stream",
    "User-Agent": "co-thinker-repo-analysis-setup",
  });

  fs.writeFileSync(destinationPath, buffer);
}

function requestBuffer(url, headers, redirectCount = 0) {
  if (redirectCount > 8) {
    return Promise.reject(new Error(`Too many redirects while downloading ${url}.`));
  }

  return new Promise((resolve, reject) => {
    const client = url.startsWith("https:") ? https : http;
    const request = client.get(url, { headers }, (response) => {
      if (
        response.statusCode &&
        response.statusCode >= 300 &&
        response.statusCode < 400 &&
        response.headers.location
      ) {
        response.resume();
        const redirectedUrl = new URL(response.headers.location, url).toString();
        requestBuffer(redirectedUrl, headers, redirectCount + 1).then(resolve, reject);
        return;
      }

      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`Download failed with HTTP ${response.statusCode}: ${url}`));
        return;
      }

      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve(Buffer.concat(chunks)));
    });

    request.on("error", reject);
    request.setTimeout(120000, () => {
      request.destroy(new Error(`Download timed out: ${url}`));
    });
  });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
