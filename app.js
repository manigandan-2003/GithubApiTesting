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
const geminiApiKey2 = process.env.GEMINI_API_KEY_2;
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
    ".jsx",
    ".html",
    ".css",
    ".scss",
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

// const client = new ChromaClient({ host: "http://127.0.0.1:8000" });
// async function run(chunks) {
//   try {
//     const heartbeat = await client.heartbeat();
//     console.log("ChromaDB heartbeat:", heartbeat);

//     const collection = await client.getOrCreateCollection({
//       name: "my_collection",
//     });

//     console.log("Collection created or retrieved:", collection.name);

//     // Filter out empty content
//     const validChunks = chunks.filter((chunk) => chunk.content.trim() !== "");

//     if (validChunks.length === 0) {
//       console.log("No valid chunks to add.");
//       return;
//     }

//     // Prepare data for ChromaDB
//     const documents = validChunks.map(
//       (chunk) => `${chunk.file_path}: ${chunk.content}`
//     );
//     //console.log("Documents:", documents);

//     const ids = validChunks.map(
//       (chunk) => `doc_${chunk.file_path}_${chunk.chunk_index}`
//     );
//     const metadatas = validChunks.map((chunk) => ({
//       file_path: chunk.file_path,
//       chunk_index: chunk.chunk_index,
//     }));

//     // Add chunks to ChromaDB
//     await collection.add({ documents, ids, metadatas });
//   } catch (error) {
//     console.error("Error:", error);
//   }
// }

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

    // Generate unique IDs for each chunk
    const ids = validChunks.map(
      (chunk) => `doc_${chunk.file_path}_${chunk.chunk_index}`
    );

    // Get existing document IDs & content
    const existingDocs = await collection.get({ ids });

    const existingData = new Map();
    if (existingDocs.documents) {
      existingDocs.ids.forEach((id, index) => {
        existingData.set(id, existingDocs.documents[index]);
      });
    }

    const chunksToAdd = [];
    const chunksToDelete = [];

    validChunks.forEach((chunk, idx) => {
      const id = ids[idx];
      const newContent = `${chunk.file_path}: ${chunk.content}`;

      if (!existingData.has(id)) {
        // New chunk - add it
        chunksToAdd.push({ id, content: newContent, metadata: chunk });
      } else if (existingData.get(id) !== newContent) {
        // Modified chunk - delete old and re-add
        chunksToDelete.push(id);
        chunksToAdd.push({ id, content: newContent, metadata: chunk });
      }
    });

    // Delete outdated chunks
    if (chunksToDelete.length > 0) {
      await collection.delete({ ids: chunksToDelete });
      console.log(`Deleted ${chunksToDelete.length} outdated chunks.`);
    }

    // Add new/updated chunks
    if (chunksToAdd.length > 0) {
      await collection.add({
        documents: chunksToAdd.map((c) => c.content),
        ids: chunksToAdd.map((c) => c.id),
        metadatas: chunksToAdd.map((c) => ({
          file_path: c.metadata.file_path,
          chunk_index: c.metadata.chunk_index,
        })),
      });
      console.log(`Added ${chunksToAdd.length} new/updated chunks.`);
    } else {
      console.log("No new or modified chunks to add.");
    }
  } catch (error) {
    console.error("Error:", error);
  }
}

async function query(issueBody) {
  const collection = await client.getOrCreateCollection({
    name: "my_collection",
  });

  // Perform the query to get relevant context for solving the issue
  const results = await collection.query({
    queryTexts: [issueBody], // Query the collection with the issue body
    nResults: 20, // You can adjust this number depending on how many results you want to retrieve
  });
  // console.log("Relevant context paths:", results.documents);
  //console.log("Results:", results);
  return results;
}

// Function to determine how much context is needed

// function decideContextSize(
//   avgDistance,
//   matchedKeywords,
//   maxPossibleResults = 10
// ) {
//   // Decay exponent controls how fast context shrinks as avgDistance increases.
//   const decayExponent = 3.5;
//   // A modest boost per keyword to slightly increase context when matches exist.
//   const keywordBoost = 0.2;

//   // Compute a base size that decreases with higher avgDistance.
//   let baseSize = maxPossibleResults / Math.pow(avgDistance, decayExponent);
//   // Add a bonus based on matched keywords.
//   let dynamicContextSize = baseSize + matchedKeywords * keywordBoost;

//   // Round and ensure the result is between 1 and maxPossibleResults.
//   return Math.max(
//     1,
//     Math.min(Math.round(dynamicContextSize), maxPossibleResults)
//   );
// }

// // Function to check if issue mentions existing keywords in retrieved code
// function checkKeywordOverlap(issueBody, documents) {
//   let issueWords = new Set(issueBody.toLowerCase().split(/\W+/));
//   let matchedKeywords = 0;

//   for (let doc of documents) {
//     let docWords = new Set(doc.toLowerCase().split(/\W+/));
//     for (let word of issueWords) {
//       if (docWords.has(word)) {
//         matchedKeywords++;
//       }
//     }
//   }
//   return matchedKeywords;
// }

// // Rough estimation of tokens in a document
// function estimateTokens(text) {
//   return Math.ceil(text.split(/\s+/).length * 1.5);
// }

// async function query(issueBody, maxTokens = 4096, bufferTokens = 1000) {
//   const collection = await client.getOrCreateCollection({
//     name: "my_collection",
//   });

//   let initialResults = await collection.query({
//     queryTexts: [issueBody],
//     nResults: 10, // Fetch more initially to analyze relevance
//   });

//   let relevantDocuments = [];
//   let totalTokens = 0;
//   let avgDistance = 0;

//   if (initialResults.distances[0]) {
//     avgDistance =
//       initialResults.distances[0].reduce((a, b) => a + b, 0) /
//       initialResults.distances[0].length;
//   }

//   let matchedKeywords = checkKeywordOverlap(
//     issueBody,
//     initialResults.documents[0]
//   );

//   let nResults = decideContextSize(avgDistance, matchedKeywords);
//   console.log("Number of results to fetch:", nResults);

//   let finalResults = await collection.query({
//     queryTexts: [issueBody],
//     nResults: nResults,
//   });

//   for (let doc of finalResults.documents[0]) {
//     let docTokens = estimateTokens(doc);
//     if (totalTokens + docTokens > maxTokens - bufferTokens) break;
//     totalTokens += docTokens;
//     relevantDocuments.push(doc);
//   }

//   console.log("Final context selected:", relevantDocuments);
//   return relevantDocuments;
// }

// async function query(issueBody) {
//   const collection = await client.getOrCreateCollection({
//     name: "my_collection",
//   });

//   // Retrieve a generous candidate set.
//   const candidateResults = await collection.query({
//     queryTexts: [issueBody],
//     nResults: 10, // Retrieve more candidates than you might need.
//   });

//   // Dynamically select the best context chunks.
//   const selectedChunks = selectContextChunks(candidateResults.documents, 1, 10);

//   console.log("No of Selected Context Chunks:", selectedChunks[0].length);
//   return selectedChunks;
// }

// Compute a dynamic threshold using both median and percentile logic.
function computeDynamicThreshold(scores) {
  if (scores.length === 0) return 0;

  // Sort scores in ascending order.
  const sorted = [...scores].sort((a, b) => a - b);

  // Compute median.
  const mid = Math.floor(sorted.length / 2);
  const medianScore =
    sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];

  // Compute approximate 60th percentile.
  const percentileIndex = Math.floor(0.6 * sorted.length);
  const percentileScore = sorted[percentileIndex];

  // Use a stricter cutoff: choose the higher value.
  return Math.max(medianScore, percentileScore);
}

// Select context chunks based on dynamic thresholding and similarity spread.
function selectContextChunks(documents, minChunks = 1, maxChunks = 10) {
  if (!documents || documents.length === 0) return [];

  // Sort documents by descending score.
  const sortedDocs = documents.sort((a, b) => b.score - a.score);

  // Extract scores.
  const scores = sortedDocs.map((doc) => doc.score);
  const maxScore = scores[0];
  const minScore = scores[scores.length - 1];
  const epsilon = 0.01; // If the spread is less than epsilon, consider them similar.

  // If all scores are almost identical, return only the minimum number of chunks.
  if (maxScore - minScore < epsilon) {
    return sortedDocs.slice(0, minChunks);
  }

  // Otherwise, compute the dynamic threshold.
  const threshold = computeDynamicThreshold(scores);

  // Filter out documents with scores below the threshold.
  let selected = sortedDocs.filter((doc) => doc.score >= threshold);

  // Enforce minimum and maximum limits.
  if (selected.length < minChunks) {
    selected = sortedDocs.slice(0, minChunks); // Ensure at least minChunks.
  } else if (selected.length > maxChunks) {
    selected = selected.slice(0, maxChunks); // Cap at maxChunks.
  }

  return selected;
}

function extractJson(text) {
  const match = text.match(/\{[\s\S]*\}/); // Match everything between the first and last curly brace
  return match ? JSON.parse(match[0]) : null;
}

async function fixContext(issueBody, context) {
  const genAI = new GoogleGenerativeAI(geminiApiKey);
  const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
  //   const prompt = `
  // Your task is to refine the unfiltered context provided by the vector database for RAG. Follow these rules:

  // 1. Include only context that is directly relevant to the given issue and dont try to solve that issue.
  // 2. Exclude any unrelated information.
  // 3. If relevant code segments that may be used elsewhere are found, include them.
  // 4. Format your output as a string containing key-value pairs in this format:
  //    filepath1: "content1", filepath2: "content2", ...
  //    If any additional code segments are included, format them as:
  //    filepath1: some other text
  // 5. Do not include any extra text beyond the refined context.

  // Issue: ${issueBody}
  // Unrefined Context: ${context}`;

  const prompt = `
  Your task is twofold:

  **Part 1 - Pick Relevant Context (Without Modification):**  
  1. Analyze the unfiltered context provided by the vector database.   
  2. **Most Important:** Do **not** modify or alter any file/chunk content—preserve them exactly as they are.
  3. **PICK AS MANY CHUNKS AS POSSIBLE AND BE GENEROUS**. 
  4. If relevant code segments that may be used elsewhere are found, include them without modification.  
  5. Format the refined context as a string containing key-value pairs in this format:  
    \`filepath1: "content1", filepath2: "content2", ...\`  
    If additional relevant code segments exist, format them as:  
    \`filepath1: some other text\`  
  6. **Ensure that all included chunks remain fully intact.** Do not shorten, summarize, or modify them in any way.  

  **Part 2 - Create a Step-by-Step Checklist:**  
  1. Parse the entire issue thoroughly before identifying the required tasks.  
  2. Create a detailed **checklist** outlining each step necessary to address the issue.  
  3. **Do not attempt to solve the issue**—only provide the checklist.  
  4. Ensure that the checklist is clear, sequential, and directly related to the issue.  

  **Return your output strictly in the following JSON format:**  
  \`\`\`json
  {
    "refinedContext": "filepath1: \\"content1\\", filepath2: \\"content2\\"",
    "checklist": [
      "Step 1: ...",
      "Step 2: ...",
      "... etc."
    ]
  }
  \`\`\`

  **Issue:** ${issueBody}  
  **Unrefined Context:** ${context}`;

  //console.log("refining context:", prompt);
  try {
    const result = await model.generateContent(prompt);
    console.log("refined context nowwww:", result.response.text());
    return result.response.text();
  } catch (error) {
    console.error("Error generating fix:", error);
    return "";
  }
}
async function generateFix(
  issueBody,
  context = "",
  checklist = [],
  feedback = ""
) {
  const genAI = new GoogleGenerativeAI(geminiApiKey2);
  const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

  const prompt = `You are a GitHub Bot designed to help developers by precisely fixing or enhancing their code according to the provided issue, feedback, and context.
  Requirements:
  1. **Issue Analysis:**  
    - Read and understand the issue, feedback, and context completely.
    - Identify the specific areas or files that need modifications.

  2. **Step-by-Step Process:**  
    - USE a detailed checklist of steps to solve the issue.
    - If there is any mistakes in the checklist given, Rectify it and use the checklist.  
    - For example, if the issue involves renaming a file, your checklist might be:  
      1. Create a new file with the target name.  
      2. Copy content from the original file.  
      3. Verify and adjust if necessary.  
      4. Delete or empty the original file if required.
    - Execute the checklist sequentially and backtrack if any step is incorrect.

  3. **Code Modification Guidelines:**  
    - Modify only the specific sections directly related to the issue.  
    - Preserve all unrelated working code intact.  
    - If new functionality is needed, integrate it without overwriting existing code that might be used elsewhere.  
    - Maintain a clean, modular, and well-structured code style that separates logic from implementation.

  4. **Handling Feedback:**  
    - Incorporate any provided feedback into your solution.
    
  5. **File Deletion:**  
    - If instructed to delete a file, ensure the file remains but its content is empty.

  6. **Output Format:**  
    - Return the final result as a JSON object mapping file paths to their content, for example:
      {"filepath1": "content1", "filepath2": "content2"}  
    - Do not wrap the output in any additional backticks or formatting.

  Issue: ${issueBody}
  Feedback: ${feedback}
  Checklist: ${checklist}
  Context: ${context}`;

  // const prompt = `You're a GitHub bot that helps developers by fixing or enhancing their code.
  // Fix the following issue by modifying necessary files, adding new files if required, or appending new code where appropriate.
  // *Important*: Make Sure Do everything that is said in the issue correctly.
  // Do not remove or overwrite any existing working code that may be used elsewhere, but if the issue needs it, you must add to it.
  // Only modify the specific section(s) of the file that are directly related to the issue.
  // *Important*: If a file contains working code, preserve it and add the new functionality in a way that integrates with the existing code and preserve unrelated existing sections but most imporantly add to the file if the issue demands it directly or indirectly.
  // *THINK STEP BY STEP BEFORE YOU COME UP WITH THE SOLUTION* : Create a step by step checklist and do everything accordingly. Do not delete or add lines of code or text without a good reason.
  // *STRICTLY CROSS CHECK AND BACKTRACK IF NEEDED* : Make sure that the code or text you are adding/deleting/modifying is correct and, does not change the intended behaviour of the code or text, strictly as specifyed by the issue.
  // For eg: if the issue states renaming A.txt to B.txt, step 1: create a new file with the name B.txt, step 2: copy contents from C.txt, Step 3: Oh, we need to copy from B.txt not C.txt, so backtrack and copy from B.txt, step 4: delete A.txt. Generalize this thinking for all the issues.
  // Make your code clean, modular, CORRECT and structured like a professional developer and separate the logic from the implementation as much as possible.
  // Make sure not miss any of the given steps required to solve the issue.
  // If there is any feedback, write your code according to the feedback.
  // If the file needs to be deleted, content must be empty.
  // The output should strictly follow the format of a JSON object {filepath1: "content1", filepath2: "content2", ...} without being wrapped in backticks.
  // Issue: ${issueBody}
  // Feedback: ${feedback}
  // Context: ${context}`;

  //   const prompt = `
  // You are a GitHub bot that assists developers by fixing or enhancing code. Your task is to resolve the issue described below by modifying necessary files, adding new files if required, or appending new code. Follow these rules strictly:

  // 1. **Preserve Existing Code:**
  //    - Do not remove or overwrite any existing working code that may be used elsewhere, but you may add to it.
  //    - If a file contains working code, preserve it and add the new functionality in a way that integrates with the existing code.
  //    - Only modify the specific section(s) of the file that are directly related to the issue.

  // 2. **Step-by-Step Reasoning:**
  //    - *THINK STEP BY STEP BEFORE YOU COME UP WITH THE SOLUTION:* Analyze the issue and context thoroughly before making any modifications.
  //    - *VALIDATE CHANGES:* Ensure that any modifications or additions do not change the intended behavior of the existing code.

  // 3. **Modification Guidelines:**
  //    - If the issue requires adding a new function, locate the appropriate section within the file and append the new function, leaving existing code intact.
  //    - Make your code clean, modular, and structured.
  //    - For file modifications, integrate changes incrementally and preserve unrelated sections.
  //    - If a file should be deleted as part of the issue, set its content to an empty string.

  // 4. **Feedback Integration:**
  //    - Incorporate any provided feedback accurately and modify your solution accordingly.

  // 5. **Output Format:**
  //    - Return your solution as a JSON object in the following format (without extra formatting):
  //      { "filepath1": "content1", "filepath2": "content2", ... }

  // Issue: ${issueBody}
  // Feedback: ${feedback}
  // Context: ${context}
  // `;

  //console.log("Sending request to Gemini API with prompt:", prompt);
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
  const branchName = `auto-fix-${payload.issue.number}-${Date.now()}`;

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

          // If file content is null or empty, mark it for deletion
          if (!fileContent) {
            console.log(`Marking ${filePath} for deletion.`);
            return {
              path: filePath,
              mode: "100644",
              type: "blob",
              sha: null, // Deleting the file
            };
          }

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

async function handleIssueOpened({ octokit, payload }, reply = "") {
  console.log(`Received an issue event for #${payload.issue.number}`);

  try {
    if (!reply) {
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
    }

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

      const processedContext = await fixContext(
        payload.issue.body,
        context.documents
      );

      const contextObj = extractJson(processedContext);

      const fix = await generateFix(
        payload.issue.body,
        contextObj.refinedContext,
        contextObj.checklist,
        reply
      );
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

// async function generateResponse(commentText) {
//   const genAI = new GoogleGenerativeAI(geminiApiKey);
//   const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

//   const prompt = `You are assigned a job to come up with the response to a comment on a PR.
//   If the comment does not require a response, then label must be 0, reply must be "".
//   If the comment requires a response to the comment but no change in the code is required, then label must be 1 and reply must have an approriate response to the comment text.
//   If the comment does not require a response and the issue is not resolved or any change in the code is suggested, then label must be 2 and reply must be "".
//   If the comment requires a response and the issue is not resolved or any change in the code is suggested, then label must be 3 and reply must have an approriate comment.
//   The output should strictly follow the format, where 1st line is the label (0, 1 , 2 or 3) and 2nd line is the reply.
//   Comment: ${commentText}`;

//   console.log("generateResponse prompt:", prompt);
//   try {
//     const result = await model.generateContent(prompt);
//     const processedresult = result.response.text().split("\n");
//     console.log("Generated response:", processedresult);
//     return processedresult;
//   } catch (error) {
//     console.error("Error generating response:", error);
//     return [];
//   }
// }

async function generateResponse(commentText, conversationHistory, codeDiff) {
  const genAI = new GoogleGenerativeAI(geminiApiKey);
  const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

  // Format conversation history
  const formattedHistory = conversationHistory
    .map(
      (comment, index) =>
        `Comment ${index + 1} by ${comment.user} at ${comment.created_at}: ${
          comment.body
        }`
    )
    .join("\n");

  // Format code diff
  const formattedDiff = codeDiff
    .map((file) => `File: ${file.filename}\nChanges:\n${file.changes}`)
    .join("\n\n");

  const prompt = `You are assigned a job to come up with a response to a comment on a PR.

  Below is the PR conversation history:
  ${formattedHistory}

  Below are the code changes (diffs):
  ${formattedDiff}

  You will receive a new comment at the end of this conversation. Based on the context, generate an appropriate response.

  Rules:
  - If the comment does not require a response, then label must be 0, reply must be "".
  - If the comment requires a response but no code change is needed, then label must be 1 and reply must have an appropriate response.
  - If the comment does not require a response but suggests a code change, then label must be 2 and reply must be "".
  - If the comment requires a response and suggests a code change, then label must be 3 and reply must have an appropriate response.

  The output should strictly follow this format:
  - The first line is the label (0, 1, 2, or 3).
  - The second line is the reply (if applicable).

  New Comment: ${commentText}`;

  console.log("generateResponse prompt:", prompt);
  try {
    const result = await model.generateContent(prompt);
    const processedResult = [
      result.response.text().split("\n")[0],
      result.response.text().split("\n").slice(1).join("\n"),
    ];
    console.log("Generated response:", processedResult);
    return processedResult;
  } catch (error) {
    console.error("Error generating response:", error);
    return [];
  }
}

// async function handleBotPRComment({ octokit, payload }) {
//   const commentText = payload.comment.body;
//   try {
//     const response = await generateResponse(commentText);
//     if (response[0] == "1" || response[0] == "3") {
//       await octokit.request(
//         "POST /repos/{owner}/{repo}/issues/{issue_number}/comments",
//         {
//           owner: payload.repository.owner.login,
//           repo: payload.repository.name,
//           issue_number: payload.issue.number,
//           body: response[1],
//           headers: {
//             "x-github-api-version": "2022-11-28",
//           },
//         }
//       );
//     }
//     if (response[0] == "2" || response[0] == "3") {
//       await handleIssueOpened({ octokit, payload }, commentText);
//     }
//   } catch (error) {
//     console.error("Error handling bot PR comment:", error);
//     if (error.response) {
//       console.error(
//         `Status: ${error.response.status}, Message: ${JSON.stringify(
//           error.response.data
//         )}`
//       );
//     }
//   }
// }

async function handleBotPRComment({ octokit, payload }) {
  const commentText = payload.comment.body;
  const owner = payload.repository.owner.login;
  const repo = payload.repository.name;
  const issue_number = payload.issue.number; // PRs are also treated as issues
  const pull_number = issue_number; // Since PRs are issues, we can use the same number

  try {
    // Fetch all comments in the PR conversation
    const { data: comments } = await octokit.request(
      "GET /repos/{owner}/{repo}/issues/{issue_number}/comments",
      {
        owner,
        repo,
        issue_number,
        headers: {
          "x-github-api-version": "2022-11-28",
        },
      }
    );

    // Extract relevant text from comments
    const conversationHistory = comments.map((comment) => ({
      user: comment.user.login,
      body: comment.body,
      created_at: comment.created_at,
    }));

    // Fetch code diff for the PR
    const { data: prFiles } = await octokit.request(
      "GET /repos/{owner}/{repo}/pulls/{pull_number}/files",
      {
        owner,
        repo,
        pull_number,
        headers: {
          "x-github-api-version": "2022-11-28",
        },
      }
    );

    // Extract changed files and diffs
    const codeDiff = prFiles.map((file) => ({
      filename: file.filename,
      changes: file.patch, // This contains the actual code diff
    }));

    // Pass conversation history and code diff to generateResponse
    const response = await generateResponse(
      commentText,
      conversationHistory,
      codeDiff
    );

    if (response[0] == "1" || response[0] == "3") {
      await octokit.request(
        "POST /repos/{owner}/{repo}/issues/{issue_number}/comments",
        {
          owner,
          repo,
          issue_number,
          body: response[1],
          headers: {
            "x-github-api-version": "2022-11-28",
          },
        }
      );
    }

    if (response[0] == "2" || response[0] == "3") {
      await handleIssueOpened(
        { octokit, payload, conversationHistory, codeDiff },
        commentText
      );
    }
  } catch (error) {
    console.error("Error handling bot PR comment:", error);
    if (error.response) {
      console.error(
        `Status: ${error.response.status}, Message: ${JSON.stringify(
          error.response.data
        )}`
      );
    }
  }
}

// app.webhooks.on(
//   ["issues.opened", "issues.edited", "issues.reopened"],
//   async (context) => {
//     const issue = context.payload.issue;
//     const labels = issue.labels.map((label) => label.name);

//     if (labels.includes("RepoBot")) {
//       console.log("Bot label detected, calling handleIssueOpened...");
//       await handleIssueOpened(context);
//     }
//   }
// );

app.webhooks.on(["issues.reopened", "issues.labeled"], async (context) => {
  const issue = context.payload.issue;
  const labels = issue.labels ? issue.labels.map((label) => label.name) : []; // Prevent undefined error

  if (labels.includes("RepoBot")) {
    console.log("Bot label detected, calling handleIssueOpened...");
    await handleIssueOpened(context);
  }
});

app.webhooks.on("issue_comment.created", async (context) => {
  const comment = context.payload.comment;
  const issue = context.payload.issue;
  const repository = context.payload.repository;

  // Ignore comments made by the bot itself
  if (comment.user.type === "Bot" || comment.user.type === "bot") {
    return;
  }

  // Check if the issue is actually a PR
  if (!issue.pull_request) {
    return;
  }

  console.log("octokit.user: ", context.octokit.rest.pulls);
  // Fetch PR details to check if it was created by the bot
  const pr = await context.octokit.rest.pulls.get({
    owner: repository.owner.login,
    repo: repository.name,
    pull_number: issue.number,
  });

  if (pr.data.user.type === "Bot" || pr.data.user.type === "bot") {
    console.log(
      "Comment detected on a bot-created PR, calling handleBotPRComment..."
    );
    await handleBotPRComment({
      octokit: context.octokit,
      payload: context.payload,
    });
  }
});

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
