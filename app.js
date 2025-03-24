import dotenv from "dotenv";
import { App } from "octokit";
import { createNodeMiddleware } from "@octokit/webhooks";
import fs from "fs";
import http from "http";
import { GoogleGenerativeAI } from "@google/generative-ai";
import fpath from "path";
import csvParser from "csv-parser";
import { ChromaClient } from "chromadb";

dotenv.config();

const appId = process.env.APP_ID;
const webhookSecret = process.env.WEBHOOK_SECRET;
const privateKeyPath = process.env.PRIVATE_KEY_PATH;
const geminiApiKey = process.env.GEMINI_API_KEY;

if (!appId || !webhookSecret || !privateKeyPath || !geminiApiKey) {
  console.error(
    "Missing required environment variables. Check your .env file."
  );
  process.exit(1);
}

const privateKey = fs.readFileSync(privateKeyPath, "utf8");

const app = new App({
  appId: appId,
  privateKey: privateKey,
  webhooks: {
    secret: webhookSecret,
  },
});

async function getAllFilesWithContents(octokit, owner, repo, path = "") {
  try {
    const { data: files } = await octokit.request(
      "GET /repos/{owner}/{repo}/contents/{path}",
      {
        owner,
        repo,
        path,
      }
    );

    let allFiles = {};

    for (const file of files) {
      if (file.type === "file") {
        const { data: fileData } = await octokit.request(
          "GET /repos/{owner}/{repo}/contents/{path}",
          {
            owner,
            repo,
            path: file.path,
          }
        );
        allFiles[file.path] = Buffer.from(fileData.content, "base64").toString(
          "utf8"
        );
      } else if (file.type === "dir") {
        Object.assign(
          allFiles,
          await getAllFilesWithContents(octokit, owner, repo, file.path)
        );
      }
    }

    return allFiles;
  } catch (error) {
    console.error("Error fetching files:", error);
    return {};
  }
}

function isCodeFile(ext) {
  return [
    ".js",
    ".ts",
    ".py",
    ".java",
    ".cpp",
    ".c",
    ".cs",
    ".go",
    ".rb",
    ".php",
    ".swift",
    ".rs",
  ].includes(ext);
}

async function chunkFile(filePath, content) {
  const ext = fpath.extname(filePath).toLowerCase();
  let chunks = [];

  if (isCodeFile(ext)) {
    chunks = chunkCode(content);
  } else if ([".txt", ".md"].includes(ext)) {
    chunks = chunkText(content);
  } else if (ext === ".json") {
    chunks = chunkJSON(content);
  } else if (ext === ".csv") {
    chunks = await chunkCSV(content);
  } else {
    console.log(`Skipping unsupported file: ${filePath}`);
    return []; // Ignore assets and unsupported files
  }

  return chunks.map((chunk, index) => ({
    content: chunk.trim(),
    file_path: filePath,
    chunk_index: index,
  }));
}

function chunkCode(content) {
  const functionRegex =
    /(def |function |const |let |var |class |public |private |protected )\s+\w+\s*\(.*?\)\s*{?/g;
  let matches = content.split(functionRegex).filter(Boolean);

  if (matches.length === 1) {
    matches = chunkByTokens(content, 300); // Fallback to token-based chunking
  }

  return mergeSmallChunks(matches, 300);
}

function chunkText(content) {
  const paragraphs = content.split(/\n{2,}/); // Split by double new lines
  return mergeSmallChunks(paragraphs, 300);
}

function chunkJSON(content) {
  try {
    const jsonData = JSON.parse(content);
    const keyValueChunks = Object.entries(jsonData).map(
      ([key, value]) => `${key}: ${JSON.stringify(value)}`
    );
    return mergeSmallChunks(keyValueChunks, 300);
  } catch (err) {
    console.error("Error parsing JSON:", err);
    return [content]; // Store whole file if parsing fails
  }
}

function chunkCSV(content) {
  return new Promise((resolve) => {
    const results = [];
    const stream = require("stream");
    const readableStream = new stream.Readable();
    readableStream._read = () => {};
    readableStream.push(content);
    readableStream.push(null);

    readableStream
      .pipe(csvParser())
      .on("data", (row) => {
        results.push(Object.values(row).join(" | "));
      })
      .on("end", () => {
        resolve(mergeSmallChunks(results, 300));
      });
  });
}

function mergeSmallChunks(chunks, minTokenSize) {
  let mergedChunks = [];
  let buffer = "";

  for (let chunk of chunks) {
    if (buffer.length + chunk.length < minTokenSize) {
      buffer += chunk + "\n\n";
    } else {
      if (buffer) mergedChunks.push(buffer.trim());
      buffer = chunk;
    }
  }

  if (buffer) mergedChunks.push(buffer.trim());

  return mergedChunks;
}

function chunkByTokens(content, tokenSize) {
  const words = content.split(/\s+/);
  let chunks = [];
  let buffer = [];

  for (let word of words) {
    buffer.push(word);
    if (buffer.length >= tokenSize) {
      chunks.push(buffer.join(" "));
      buffer = [];
    }
  }

  if (buffer.length > 0) {
    chunks.push(buffer.join(" "));
  }

  return chunks;
}

const client = new ChromaClient({ host: "http://127.0.0.1:8000" });
async function run(chunks) {
  try {
    const heartbeat = await client.heartbeat();
    console.log("ChromaDB heartbeat:", heartbeat);

    const collection = await client.getOrCreateCollection({
      name: "my_collection",
    });

    console.log("Collection created or retrieved:", collection.name);

    // Filter out empty content
    const validChunks = chunks.filter((chunk) => chunk.content.trim() !== "");

    if (validChunks.length === 0) {
      console.log("No valid chunks to add.");
      return;
    }

    // Prepare data for ChromaDB
    const documents = validChunks.map(
      (chunk) => `${chunk.file_path}: ${chunk.content}`
    );
    console.log("Documents:", documents);

    const ids = validChunks.map(
      (chunk) => `doc_${chunk.file_path}_${chunk.chunk_index}`
    );
    const metadatas = validChunks.map((chunk) => ({
      file_path: chunk.file_path,
      chunk_index: chunk.chunk_index,
    }));

    // Add chunks to ChromaDB
    await collection.add({ documents, ids, metadatas });
  } catch (error) {
    console.error("Error:", error);
  }
}

// async function query(issueBody) {
//   const collection = await client.getOrCreateCollection({
//     name: "my_collection",
//   });

//   // Perform the query to get relevant context for solving the issue
//   const results = await collection.query({
//     queryTexts: [issueBody], // Query the collection with the issue body
//     nResults: 3, // You can adjust this number depending on how many results you want to retrieve
//   });
//   // console.log("Relevant context paths:", results.documents);
//   console.log("Results:", results);
//   return results;
// }

// Function to determine how much context is needed

function decideContextSize(
  avgDistance,
  matchedKeywords,
  maxPossibleResults = 10
) {
  // Decay exponent controls how fast context shrinks as avgDistance increases.
  const decayExponent = 3.5;
  // A modest boost per keyword to slightly increase context when matches exist.
  const keywordBoost = 0.2;

  // Compute a base size that decreases with higher avgDistance.
  let baseSize = maxPossibleResults / Math.pow(avgDistance, decayExponent);
  // Add a bonus based on matched keywords.
  let dynamicContextSize = baseSize + matchedKeywords * keywordBoost;

  // Round and ensure the result is between 1 and maxPossibleResults.
  return Math.max(
    1,
    Math.min(Math.round(dynamicContextSize), maxPossibleResults)
  );
}

// Function to check if issue mentions existing keywords in retrieved code
function checkKeywordOverlap(issueBody, documents) {
  let issueWords = new Set(issueBody.toLowerCase().split(/\W+/));
  let matchedKeywords = 0;

  for (let doc of documents) {
    let docWords = new Set(doc.toLowerCase().split(/\W+/));
    for (let word of issueWords) {
      if (docWords.has(word)) {
        matchedKeywords++;
      }
    }
  }
  return matchedKeywords;
}

// Rough estimation of tokens in a document
function estimateTokens(text) {
  return Math.ceil(text.split(/\s+/).length * 1.5);
}

async function query(issueBody, maxTokens = 4096, bufferTokens = 1000) {
  const collection = await client.getOrCreateCollection({
    name: "my_collection",
  });

  let initialResults = await collection.query({
    queryTexts: [issueBody],
    nResults: 10, // Fetch more initially to analyze relevance
  });

  let relevantDocuments = [];
  let totalTokens = 0;
  let avgDistance = 0;

  if (initialResults.distances[0]) {
    avgDistance =
      initialResults.distances[0].reduce((a, b) => a + b, 0) /
      initialResults.distances[0].length;
  }

  let matchedKeywords = checkKeywordOverlap(
    issueBody,
    initialResults.documents[0]
  );

  let nResults = decideContextSize(avgDistance, matchedKeywords);
  console.log("Number of results to fetch:", nResults);

  let finalResults = await collection.query({
    queryTexts: [issueBody],
    nResults: nResults,
  });

  for (let doc of finalResults.documents[0]) {
    let docTokens = estimateTokens(doc);
    if (totalTokens + docTokens > maxTokens - bufferTokens) break;
    totalTokens += docTokens;
    relevantDocuments.push(doc);
  }

  console.log("Final context selected:", relevantDocuments);
  return relevantDocuments;
}

function extractJson(text) {
  const match = text.match(/\{[\s\S]*\}/); // Match everything between the first and last curly brace
  return match ? JSON.parse(match[0]) : null;
}

async function generateFix(issueBody, context = "") {
  const genAI = new GoogleGenerativeAI(geminiApiKey);
  const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

  // const prompt = `Your a github bot helping other coders/developers by fixing their code or by writing helpful code.
  // Fix the following issue in the code by modifying necessary files, adding or deleting files if required.
  // Even though you are a bot that is for helping others code, think before adding/modifying/deleting existing working code.
  // Don't overwrite working code that might be used in other files.
  // Stick to the intructions as much as possible.
  // Make your code as clean, modular and structured as possible.
  // Use only the relevant context and ignore all unnecessary information.
  // The output should strictly follow the format of a JSON object {filepath1: content1, filepath2: content2, ...} without being wrapped in backticks.
  // Issue: ${issueBody}
  // Context: ${context}`;

  const prompt = `You're a GitHub bot that helps developers by fixing or enhancing their code. 
  Fix the following issue by modifying necessary files, adding new files if required, or appending new code where appropriate. 
  Do not remove or overwrite any existing working code that may be used elsewhere, but you may add to it. 
  If a file contains working code, preserve it and add the new functionality in a way that integrates with the existing code.
  Make your code clean, modular, and structured.
  Use only the relevant context and ignore unnecessary information.
  The output should strictly follow the format of a JSON object {filepath1: content1, filepath2: content2, ...} without being wrapped in backticks.
  Issue: ${issueBody}  
  Context: ${context}`;

  console.log("Sending request to Gemini API with prompt:", prompt);
  try {
    const result = await model.generateContent(prompt);
    const processedresult = extractJson(result.response.text());
    console.log("Generated fix:", processedresult);
    return processedresult;
  } catch (error) {
    console.error("Error generating fix:", error);
    return "";
  }
}

async function createPR(octokit, payload, fix) {
  const branchName = `auto-fix-${payload.issue.number}`;

  try {
    const {
      data: { default_branch },
    } = await octokit.request("GET /repos/{owner}/{repo}", {
      owner: payload.repository.owner.login,
      repo: payload.repository.name,
    });

    console.log("Default branch:", default_branch);

    // Step 1: Get Base Commit SHA
    const {
      data: {
        object: { sha: baseSha },
      },
    } = await octokit.request("GET /repos/{owner}/{repo}/git/ref/{ref}", {
      owner: payload.repository.owner.login,
      repo: payload.repository.name,
      ref: `heads/${default_branch}`,
    });

    console.log("Base SHA:", baseSha);

    // Step 2: Create a new branch
    await octokit.request("POST /repos/{owner}/{repo}/git/refs", {
      owner: payload.repository.owner.login,
      repo: payload.repository.name,
      ref: `refs/heads/${branchName}`,
      sha: baseSha,
    });

    console.log("New branch created:", branchName);

    // Step 3: Fetch existing tree SHA
    const {
      data: { sha: treeSha },
    } = await octokit.request(
      "GET /repos/{owner}/{repo}/git/commits/{commit_sha}",
      {
        owner: payload.repository.owner.login,
        repo: payload.repository.name,
        commit_sha: baseSha,
      }
    );

    console.log("Tree SHA:", treeSha);

    // Step 4: Create a new tree with multiple file updates
    const treeItems = await Promise.all(
      Object.entries(fix).map(async ([filePath, fileContent]) => {
        try {
          // Get file's existing SHA (if it exists)
          const { data: fileData } = await octokit.request(
            "GET /repos/{owner}/{repo}/contents/{path}",
            {
              owner: payload.repository.owner.login,
              repo: payload.repository.name,
              path: filePath,
            }
          );
          console.log(`Existing file SHA for ${filePath}:`, fileData.sha);

          return {
            path: filePath,
            mode: "100644",
            type: "blob",
            content: fileContent,
          };
        } catch (error) {
          console.log(`File ${filePath} does not exist. Creating new file.`);
          return {
            path: filePath,
            mode: "100644",
            type: "blob",
            content: fileContent,
          };
        }
      })
    );

    const { data: newTree } = await octokit.request(
      "POST /repos/{owner}/{repo}/git/trees",
      {
        owner: payload.repository.owner.login,
        repo: payload.repository.name,
        base_tree: treeSha,
        tree: treeItems,
      }
    );

    console.log("New tree created:", newTree.sha);

    // Step 5: Create a new commit pointing to the new tree
    const { data: newCommit } = await octokit.request(
      "POST /repos/{owner}/{repo}/git/commits",
      {
        owner: payload.repository.owner.login,
        repo: payload.repository.name,
        message: `Fix issue #${payload.issue.number}`,
        tree: newTree.sha,
        parents: [baseSha],
      }
    );

    console.log("New commit created:", newCommit.sha);

    // Step 6: Update the branch to point to the new commit
    await octokit.request("PATCH /repos/{owner}/{repo}/git/refs/{ref}", {
      owner: payload.repository.owner.login,
      repo: payload.repository.name,
      ref: `heads/${branchName}`,
      sha: newCommit.sha,
    });

    console.log("Branch updated with new commit:", branchName);

    // Step 7: Create a pull request
    await octokit.request("POST /repos/{owner}/{repo}/pulls", {
      owner: payload.repository.owner.login,
      repo: payload.repository.name,
      title: `Fix issue #${payload.issue.number}`,
      body: "Automated fix for the issue using Gemini API",
      head: branchName,
      base: default_branch,
    });

    console.log("Pull request created.");
  } catch (error) {
    console.error("Error creating PR:", error);
    if (error.response) {
      console.error(
        `Status: ${error.response.status}, Message: ${JSON.stringify(
          error.response.data
        )}`
      );
    }
  }
}

const messageForNewIssues =
  "Thanks for opening a new issue! Our bot will attempt to fix it automatically.";

async function handleIssueOpened({ octokit, payload }) {
  console.log(`Received an issue event for #${payload.issue.number}`);

  try {
    await octokit.request(
      "POST /repos/{owner}/{repo}/issues/{issue_number}/comments",
      {
        owner: payload.repository.owner.login,
        repo: payload.repository.name,
        issue_number: payload.issue.number,
        body: messageForNewIssues,
        headers: {
          "x-github-api-version": "2022-11-28",
        },
      }
    );

    console.log("Comment added to issue.");

    // Usage
    (async () => {
      const chunks = [];
      const repoFiles = await getAllFilesWithContents(
        octokit,
        payload.repository.owner.login,
        payload.repository.name
      );

      for (const [filePath, content] of Object.entries(repoFiles)) {
        const currentchunk = await chunkFile(filePath, content);
        chunks.push(...currentchunk);
      }

      await run(chunks);
      const context = await query(payload.issue.body);
      console.log("Context:", context);

      const fix = await generateFix(payload.issue.body, context);
      if (fix) {
        await createPR(octokit, payload, fix);
      }
    })();
  } catch (error) {
    console.error("Error handling issue opened:", error);
    if (error.response) {
      console.error(
        `Status: ${error.response.status}, Message: ${JSON.stringify(
          error.response.data
        )}`
      );
    }
  }
}

app.webhooks.on("issues.opened", handleIssueOpened);

app.webhooks.onError((error) => {
  if (error.name === "AggregateError") {
    console.error(`Error processing request: ${error.event}`);
  } else {
    console.error(error);
  }
});

const port = 3000;
const host = "localhost";
const path = "/api/webhook";
const localWebhookUrl = `http://${host}:${port}${path}`;

const middleware = createNodeMiddleware(app.webhooks, { path });

http.createServer(middleware).listen(port, () => {
  console.log(`Server is listening for events at: ${localWebhookUrl}`);
  console.log("Press Ctrl + C to quit.");
});
