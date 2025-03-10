import dotenv from "dotenv";
import { App } from "octokit";
import { createNodeMiddleware } from "@octokit/webhooks";
import fs from "fs";
import http from "http";
import axios from "axios";
import { GoogleGenerativeAI } from "@google/generative-ai";

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

import fpath from "path";
import csvParser from "csv-parser";

// ✅ Main function to chunk a file
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

// ✅ Function to check if a file is a code file
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

// ✅ Chunking for Code Files (Functions, Classes & Logical Blocks)
function chunkCode(content) {
  const functionRegex =
    /(def |function |const |let |var |class |public |private |protected )\s+\w+\s*\(.*?\)\s*{?/g;
  let matches = content.split(functionRegex).filter(Boolean);

  if (matches.length === 1) {
    matches = chunkByTokens(content, 300); // Fallback to token-based chunking
  }

  return mergeSmallChunks(matches, 300);
}

// ✅ Chunking for `.txt` and `.md` files (by paragraph but ensuring size)
function chunkText(content) {
  const paragraphs = content.split(/\n{2,}/); // Split by double new lines
  return mergeSmallChunks(paragraphs, 300);
}

// ✅ Chunking for `.json` files (convert key-value pairs into meaningful chunks)
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

// ✅ Chunking for `.csv` files
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

// ✅ Merge small chunks together to ensure optimal size (~300-500 tokens)
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

// ✅ Token-based fallback chunking
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

import { ChromaClient } from "chromadb";

// Connect to ChromaDB (local persistent storage)
const client = new ChromaClient({ host: "http://127.0.0.1:8000" });
async function run(chunks) {
  try {
    const heartbeat = await client.heartbeat();
    console.log("ChromaDB heartbeat:", heartbeat);

    // Create or retrieve a collection
    const collection = await client.getOrCreateCollection({
      name: "my_collection",
    });

    console.log("Collection created or retrieved:", collection.name);

    // Filter out empty content
    const validChunks = chunks.filter((chunk) => chunk.content.trim() !== "");
    console.log("Valid chunks:", validChunks);

    if (validChunks.length === 0) {
      console.log("No valid chunks to add.");
      return;
    }

    // Prepare data for ChromaDB
    const documents = validChunks.map((chunk) => chunk.content);
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

    console.log("Chunks added successfully!");
  } catch (error) {
    console.error("Error:", error);
  }
}
// async function run(chunks) {
//   const heartbeat = await client.heartbeat();
//   console.log("ChromaDB heartbeat:", heartbeat);
//   // Create or retrieve a collection
//   const collection = await client.getOrCreateCollection({
//     name: "my_collection",
//   });

//   console.log("Collection created or retrieved:", collection.name);

//   // Filter out empty content
//   const validChunks = chunks.filter((chunk) => chunk.content.trim() !== "");

//   if (validChunks.length === 0) {
//     console.log("No valid chunks to add.");
//     return;
//   }

//   // Prepare data for ChromaDB
//   const documents = validChunks.map((chunk) => chunk.content);
//   const ids = validChunks.map(
//     (chunk) => `doc_${chunk.file_path}_${chunk.chunk_index}`
//   );
//   const metadatas = validChunks.map((chunk) => ({
//     file_path: chunk.file_path,
//     chunk_index: chunk.chunk_index,
//   }));

//   // Add chunks to ChromaDB
//   await collection.add({ documents, ids, metadatas });

//   console.log("Chunks added successfully!");
// }

async function query(issueBody) {
  // Create or retrieve a collection
  const collection = await client.getOrCreateCollection({
    name: "my_collection",
  });

  // Perform the query to get relevant context for solving the issue
  const results = await collection.query({
    queryTexts: [issueBody], // Query the collection with the issue body
    nResults: 3, // You can adjust this number depending on how many results you want to retrieve
  });

  // Process the results (in this case, log them)
  //console.log("Relevant context retrieved for the issue:", results);

  // You can use the results to help resolve the issue
  // For example, extracting relevant code snippets or documentation sections
  return results;
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
      //console.log("Code files with contents:", repoFiles);

      for (const [filePath, content] of Object.entries(repoFiles)) {
        const currentchunk = await chunkFile(filePath, content);
        chunks.push(...currentchunk);
      }
      //console.log("Chunks:", chunks);
      await run(chunks);
      const context = await query(payload.issue.body);
      console.log("Context:", context.documents);

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

async function generateFix(issueBody, context = "") {
  const genAI = new GoogleGenerativeAI(geminiApiKey);
  const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

  const prompt = `Fix the following issue in the code and give only code and ignore irrelavant info: ${issueBody} and with the context ${context.ids} ${context.documents} `; // Update the prompt as needed

  console.log("Sending request to Gemini API with prompt:", prompt);
  try {
    const result = await model.generateContent(prompt);
    console.log("Gemini API response:", result);
    return result.response.text();
  } catch (error) {
    console.error("Error generating fix:", error);
    return "";
  }
}

async function createPR(octokit, payload, fix) {
  const branchName = `auto-fix-${payload.issue.number}`;
  const filePath = "rahul.js"; // Update this with the actual file path

  try {
    const {
      data: { default_branch },
    } = await octokit.request("GET /repos/{owner}/{repo}", {
      owner: payload.repository.owner.login,
      repo: payload.repository.name,
    });

    console.log("Default branch:", default_branch);

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

    const {
      data: { sha: newBranchSha },
    } = await octokit.request("POST /repos/{owner}/{repo}/git/refs", {
      owner: payload.repository.owner.login,
      repo: payload.repository.name,
      ref: `refs/heads/${branchName}`,
      sha: baseSha,
    });

    console.log("New branch SHA:", newBranchSha);

    const { data: fileData } = await octokit.request(
      "GET /repos/{owner}/{repo}/contents/{path}",
      {
        owner: payload.repository.owner.login,
        repo: payload.repository.name,
        path: filePath,
      }
    );

    console.log("Existing file SHA:", fileData.sha);

    await octokit.request("PUT /repos/{owner}/{repo}/contents/{path}", {
      owner: payload.repository.owner.login,
      repo: payload.repository.name,
      path: filePath,
      message: `Fix issue #${payload.issue.number}`,
      content: Buffer.from(fix).toString("base64"),
      sha: fileData.sha,
      branch: branchName,
    });

    console.log("File updated on branch:", branchName);

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
