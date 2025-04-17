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
    chunks = chunkCode(filePath, content);
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

function chunkCode(filePath, content) {
  // const functionRegex =
  //   /(def |function |const |let |var |class |public |private |protected )\s+\w+\s*\(.*?\)\s*{?/g;
  // let matches = content.split(functionRegex).filter(Boolean);

  // if (matches.length === 1) {
  //   matches = chunkByTokens(content, 300); // Fallback to token-based chunking
  // }

  // return mergeSmallChunks(matches, 300);
  return [content.trim()];
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
//     const filepaths = validChunks.map((chunk) => `${chunk.file_path}`);
//     const metadatas = validChunks.map((chunk) => ({
//       file_path: chunk.file_path,
//       chunk_index: chunk.chunk_index,
//     }));

//     // Add chunks to ChromaDB
//     await collection.add({ documents, ids, filepaths, metadatas });
//   } catch (error) {
//     console.error("Error:", error);
//   }
// }

// import { pipeline, env } from "@xenova/transformers";

// // --- Transformers.js Setup ---
// env.allowLocalModels = false; // Set to false to use remote models only

// // Define the embedding model
// const modelName = "Xenova/bge-base-en-v1.5"; // BGE is good for retrieval tasks
// const distanceMetric = "cosine"; // 'cosine' works best for normalized embeddings

// // Singleton instance of the embedding model
// let extractorPromise = null;
// async function getExtractor() {
//   if (!extractorPromise) {
//     console.log(`Loading embedding model: ${modelName}...`);
//     extractorPromise = pipeline("feature-extraction", modelName, {
//       quantized: true, // Use smaller quantized models for efficiency
//     });
//   }
//   return await extractorPromise;
// }

// // Define the embedding function compatible with ChromaDB
// class TransformersJsEmbeddingFunction {
//   async generate(texts) {
//     const extractorInstance = await getExtractor(); // Ensure model is loaded
//     console.log(`Generating embeddings for ${texts.length} text(s)...`);

//     const output = await extractorInstance(texts, {
//       pooling: "mean", // Use 'mean' pooling to get a fixed-size embedding
//       normalize: true, // Normalize embeddings for cosine similarity
//     });

//     console.log("Embeddings generated.");
//     console.log(output.tolist());
//     return output.tolist(); // Convert tensor to JavaScript array
//   }
// }
// // --- ChromaDB Client Setup ---

// const client = new ChromaClient({ host: "http://127.0.0.1:8000" }); // Adjust host if needed
// const embeddingFunction = new TransformersJsEmbeddingFunction();

// // --- Core Logic Functions (from your original code, adapted) ---

// /**
//  * Adds or updates chunks in the ChromaDB collection using client-side embeddings.
//  * @param {Array<object>} chunks - Array of chunk objects { file_path: string, chunk_index: number, content: string }
//  */

// const collectionName = "my_collection_bge_base";

// async function run(chunks) {
//   try {
//     const heartbeat = await client.heartbeat();
//     console.log("ChromaDB heartbeat:", heartbeat); // Good for debugging connection

//     // Get or create the collection, providing the embedding function
//     console.log(`Getting or creating collection: ${collectionName}`);
//     const collection = await client.getOrCreateCollection({
//       name: collectionName,
//       embeddingFunction: embeddingFunction, // Crucial: Pass the function instance
//       metadata: {
//         "hnsw:space": distanceMetric,
//         "hnsw:search_ef": 100, // Specify the distance metric
//       },
//     });
//     console.log("Collection obtained:", collection.name);

//     // Filter out chunks with empty or whitespace-only content
//     const validChunks = chunks.filter(
//       (chunk) => chunk && chunk.content && chunk.content.trim() !== ""
//     );
//     console.log(
//       `Processing ${validChunks.length} valid chunks out of ${chunks.length} total.`
//     );

//     if (validChunks.length === 0) {
//       console.log("No valid chunks with content to process.");
//       return;
//     }

//     // Generate unique IDs for each chunk based on file path and index
//     const ids = validChunks.map(
//       (chunk) => `doc_${chunk.file_path}_${chunk.chunk_index}`
//     );

//     // --- Check existing documents to avoid duplicates and handle updates ---
//     console.log("Checking for existing documents in the collection...");
//     const existingDocs = await collection.get({
//       ids: ids,
//       include: ["documents"], // Only need documents to compare content
//     });
//     console.log(
//       `Found ${existingDocs.ids.length} existing document IDs matching the current batch.`
//     );

//     const existingData = new Map();
//     if (existingDocs && existingDocs.ids && existingDocs.documents) {
//       existingDocs.ids.forEach((id, index) => {
//         existingData.set(id, existingDocs.documents[index]);
//       });
//     }

//     const chunksToAdd = []; // Chunks that are new or have modified content
//     const idsToDelete = []; // IDs of chunks whose content has changed (will be re-added)
//     const finalIds = []; // All IDs corresponding to chunksToAdd
//     const finalMetadatas = []; // All metadatas corresponding to chunksToAdd
//     const finalDocuments = []; // All document contents corresponding to chunksToAdd

//     validChunks.forEach((chunk, idx) => {
//       const id = ids[idx];
//       // Prepend file_path to content for potential context during retrieval
//       const newContent = `${chunk.file_path}: ${chunk.content}`;
//       const metadata = {
//         file_path: chunk.file_path,
//         chunk_index: chunk.chunk_index,
//       };

//       if (!existingData.has(id)) {
//         // This is a completely new chunk
//         chunksToAdd.push({ id, content: newContent, metadata });
//         finalIds.push(id);
//         finalMetadatas.push(metadata);
//         finalDocuments.push(newContent);
//         // console.log(`Marked chunk ${id} for addition (new).`);
//       } else if (existingData.get(id) !== newContent) {
//         // This chunk exists but its content has changed
//         idsToDelete.push(id); // Mark the old version for deletion
//         chunksToAdd.push({ id, content: newContent, metadata }); // Mark the new version for addition
//         finalIds.push(id);
//         finalMetadatas.push(metadata);
//         finalDocuments.push(newContent);
//         // console.log(`Marked chunk ${id} for update (delete/add).`);
//       } else {
//         // Chunk exists and content is the same, do nothing.
//         // console.log(`Chunk ${id} already exists and is up-to-date.`);
//       }
//     });

//     // Delete outdated chunks first
//     if (idsToDelete.length > 0) {
//       console.log(`Deleting ${idsToDelete.length} outdated chunks...`);
//       await collection.delete({ ids: idsToDelete });
//       console.log("Deletion complete.");
//     } else {
//       console.log("No chunks marked for deletion.");
//     }

//     // Add new or updated chunks (Embeddings are generated by Transformers.js via embeddingFunction)
//     if (chunksToAdd.length > 0) {
//       console.log(
//         `Adding ${chunksToAdd.length} new/updated chunks... This will trigger embedding generation.`
//       );
//       // The embeddingFunction will automatically be called by collection.add here
//       await collection.add({
//         ids: finalIds,
//         metadatas: finalMetadatas,
//         documents: finalDocuments,
//       });
//       console.log(`Successfully added/updated ${chunksToAdd.length} chunks.`);
//     } else {
//       console.log("No new or modified chunks require addition.");
//     }

//     console.log("Run process finished.");
//   } catch (error) {
//     console.error("Error during run process:", error);
//     if (error.message && error.message.includes("Failed to fetch")) {
//       console.error(
//         "Fetch error: Is the ChromaDB server running and accessible at the specified host?"
//       );
//     } else if (error.message && error.message.includes("Embedding model")) {
//       console.error(
//         "Model error: Could not load or use the embedding model. Check model name and network connection."
//       );
//     }
//     // Add more specific error handling if needed
//   }
// }

// google embeddings

// import { GoogleGenerativeAiEmbeddingFunction } from "chromadb";

// const client = new ChromaClient({ host: "http://127.0.0.1:8000" });
// const embedder = new GoogleGenerativeAiEmbeddingFunction({
//   googleApiKey: geminiApiKey,
// });

// async function run(chunks) {
//   try {
//     const heartbeat = await client.heartbeat();
//     console.log("ChromaDB heartbeat:", heartbeat);

//     const collection = await client.getOrCreateCollection({
//       name: "my_collection",
//       //embeddingFunction: embedder,
//     });

//     console.log("Collection retrieved:", collection.name);

//     // Group chunks by file_path
//     const fileMap = new Map();
//     for (const chunk of chunks) {
//       if (!chunk.content.trim()) continue;
//       if (!fileMap.has(chunk.file_path)) {
//         fileMap.set(chunk.file_path, []);
//       }
//       fileMap.get(chunk.file_path).push(chunk.content);
//     }

//     if (fileMap.size === 0) {
//       console.log("No valid files to add.");
//       return;
//     }

//     // Prepare documents: one per file
//     const documents = [];
//     const ids = [];
//     const metadatas = [];

//     for (const [filePath, contents] of fileMap.entries()) {
//       const fullContent = contents.join("\n");
//       documents.push(`${filePath}:\n${fullContent}`);
//       ids.push(`doc_${filePath}`);
//       metadatas.push({ file_path: filePath });
//     }

//     // Add all at once (or batch if needed)
//     const batchSize = 100;
//     for (let i = 0; i < documents.length; i += batchSize) {
//       const batchDocuments = documents.slice(i, i + batchSize);
//       const batchIds = ids.slice(i, i + batchSize);
//       const batchMetadatas = metadatas.slice(i, i + batchSize);

//       console.log(`Processing batch ${i / batchSize + 1}`);

//       await collection.add({
//         documents: batchDocuments,
//         ids: batchIds,
//         metadatas: batchMetadatas,
//       });
//     }

//     console.log("All files added successfully.");
//   } catch (error) {
//     console.error("Error:", error);
//   }
// }

// async function query(issueBody) {
//   const collection = await client.getOrCreateCollection({
//     name: "my_collection",
//     //embeddingFunction: embedder,
//   });

//   const results = await collection.query({
//     queryTexts: [issueBody],
//     nResults: 20,
//   });

//   console.log("Results:", results);
//   return results;
// }

//truncated output
// import { GoogleGenerativeAiEmbeddingFunction } from "chromadb";

// const client = new ChromaClient({ host: "http://127.0.0.1:8000" });
// const embedder = new GoogleGenerativeAiEmbeddingFunction({
//   googleApiKey: geminiApiKey,
// });
// // const embedder = new HuggingFaceEmbeddingServerFunction({
// //   url: "http://localhost:8001/embed",
// // });
// async function run(chunks) {
//   try {
//     const heartbeat = await client.heartbeat();
//     console.log("ChromaDB heartbeat:", heartbeat);

//     const collection = await client.getOrCreateCollection({
//       name: "my_collection",
//       embeddingFunction: embedder, // Ensure embedding function is used
//     });

//     console.log("Collection retrieved:", collection.name);

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
//     const ids = validChunks.map(
//       (chunk) => `doc_${chunk.file_path}_${chunk.chunk_index}`
//     );
//     const metadatas = validChunks.map((chunk) => ({
//       file_path: chunk.file_path,
//       chunk_index: chunk.chunk_index,
//     }));

//     // **Batch processing (Split into chunks of 100)**
//     const batchSize = 100;
//     for (let i = 0; i < documents.length; i += batchSize) {
//       const batchDocuments = documents.slice(i, i + batchSize);
//       const batchIds = ids.slice(i, i + batchSize);
//       const batchMetadatas = metadatas.slice(i, i + batchSize);

//       console.log(`Processing batch ${i / batchSize + 1}`);

//       await collection.add({
//         documents: batchDocuments,
//         ids: batchIds,
//         metadatas: batchMetadatas,
//       });
//     }

//     console.log("All batches added successfully.");
//   } catch (error) {
//     console.error("Error:", error);
//   }
// }

const BATCH_SIZE = 10;
const MAX_PARALLEL = 5;

async function getCodeBERTEmbeddingsInParallel(texts) {
  const batches = [];
  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    batches.push(texts.slice(i, i + BATCH_SIZE));
  }

  const results = [];
  for (let i = 0; i < batches.length; i += MAX_PARALLEL) {
    const parallel = batches.slice(i, i + MAX_PARALLEL);

    const embeddings = await Promise.all(
      parallel.map(async (batch) => {
        try {
          const res = await fetch("http://localhost:5000/embed", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ texts: batch }),
          });

          if (!res.ok) {
            const errText = await res.text();
            console.error(
              `❌ Embedding API returned ${res.status}: ${errText}`
            );
            throw new Error(`Embedding API error: ${res.status}`);
          }

          const json = await res.json();

          if (!json.embeddings) {
            console.error("❌ Missing 'embeddings' in response JSON:", json);
            throw new Error("Invalid response: Missing 'embeddings'");
          }

          return json;
        } catch (err) {
          console.error("❌ Error fetching embeddings:", err.message);
          throw err;
        }
      })
    );

    embeddings.forEach((e) => results.push(...e.embeddings));
  }

  return results;
}

// import { DefaultEmbeddingFunction } from "chromadb";
// const embedder = new DefaultEmbeddingFunction();
// const embedder = {
//   generate: async (texts) => {
//     const res = await Promise.all(
//       texts.map(async (text) => {
//         const response = await fetch("http://localhost:5000/embed", {
//           method: "POST",
//           headers: { "Content-Type": "application/json" },
//           body: JSON.stringify({ text }),
//         });
//         const json = await response.json();
//         return json.embedding;
//       })
//     );
//     return res;
//   },
// };

const client = new ChromaClient({ host: "http://127.0.0.1:8000" });
async function run(chunks) {
  try {
    const heartbeat = await client.heartbeat();
    console.log("ChromaDB heartbeat:", heartbeat);

    const collection = await client.getOrCreateCollection({
      name: "my_collection",
      //embeddingFunction: embedder,
    });

    console.log("Collection retrieved:", collection.name);

    const validChunks = chunks.filter((chunk) => chunk.content.trim());
    if (validChunks.length === 0) {
      console.log("No valid chunks to add.");
      return;
    }

    const texts = validChunks.map(
      (chunk) => `${chunk.file_path}:\n${chunk.content}`
    );
    const ids = validChunks.map(
      (chunk) => `doc_${chunk.file_path}_${chunk.chunk_index}`
    );
    const metadatas = validChunks.map((chunk) => ({
      file_path: chunk.file_path,
      chunk_index: chunk.chunk_index,
    }));

    console.log("Generating embeddings in parallel...");
    //const embeddings = await getCodeBERTEmbeddingsInParallel(texts);

    console.log("Adding to ChromaDB...");
    await collection.add({
      //embeddings: embeddings, // ✅ Fixed
      ids: ids,
      metadatas: metadatas,
      documents: texts, // ✅ Fixed
    });

    console.log("All chunks added successfully.");
  } catch (error) {
    console.error("Error:", error);
  }
}

async function query(issueBody) {
  const collection = await client.getOrCreateCollection({
    name: "my_collection",
    //embeddingFunction: embedder, // Uncomment if you're using a custom embedder
  });
  //const embeddings = await getCodeBERTEmbeddingsInParallel([issueBody]);
  //console.log("issueemb", embeddings);
  const results = await collection.query({
    //queryEmbeddings: embeddings,
    queryTexts: [issueBody],
    nResults: 10,
  });

  //console.log("Results:", results);
  return results;
}

// /**
//  * Queries the collection for documents relevant to the issueBody.
//  * @param {string} issueBody - The text to query with.
//  * @returns {Promise<object|null>} The query results or null if an error occurs.
//  */
// async function query(issueBody) {
//   if (!issueBody || issueBody.trim() === "") {
//     console.log("Query text is empty, skipping query.");
//     return null;
//   }
//   try {
//     // Get the collection, ensuring embedding function is provided for query embedding generation
//     console.log(`Getting collection ${collectionName} for query...`);
//     const collection = await client.getOrCreateCollection({
//       name: collectionName,
//       embeddingFunction: embeddingFunction, // Required to embed the queryText
//       metadata: { "hnsw:space": distanceMetric },
//     });
//     console.log("Collection obtained. Performing query...");

//     // Perform the query. The embeddingFunction embeds the queryTexts automatically.
//     const results = await collection.query({
//       queryTexts: [issueBody], // The text(s) to find relevant documents for
//       nResults: 20, // Number of results to return
//       include: ["metadatas", "documents", "distances"], // Include useful information
//     });

//     console.log(`Query returned ${results?.ids?.[0]?.length ?? 0} results.`);
//     // console.log("Query Results:", results); // Optional: Log raw results
//     return results;
//   } catch (error) {
//     console.error("Error during query process:", error);
//     if (error.message && error.message.includes("Failed to fetch")) {
//       console.error(
//         "Fetch error: Is the ChromaDB server running and accessible?"
//       );
//     } else if (
//       error.message &&
//       error.message.includes("Collection") &&
//       error.message.includes("does not exist")
//     ) {
//       console.error(
//         `Collection Error: The collection "${collectionName}" might not have been created yet. Ensure 'run' was executed successfully first.`
//       );
//     }
//     return null; // Indicate failure
//   }
// }

// Example usage:
// (Assume `chunks` is an array of chunk objects with properties: content, file_path, and chunk_index)
// run(chunks).then(() => console.log("Run complete."));
// query("example issue text").then(results => console.log(results));

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

// **Part 2 - Create a Step-by-Step Checklist:**
// 1. Parse the entire issue thoroughly before identifying the required tasks.
// 2. Create a detailed **checklist** outlining each step necessary to address the issue.
// 3. **Do not attempt to solve the issue**—only provide the checklist.
// 4. Ensure that the checklist is clear, sequential, and directly related to the issue.
async function fixContext(
  issueBody,
  context = "",
  repoTree,
  conversationHistory = "",
  codeDiff = "",
  commentText = ""
) {
  const genAI = new GoogleGenerativeAI(geminiApiKey);
  const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
  const prompt = `
  You are a JSON-only response agent. DO NOT explain your reasoning. DO NOT include any preamble or analysis.

  Your task is twofold:
  Respond ONLY in the exact JSON format provided at the end.

  ---

  **Part 1 - Identify Files to be Modified:**

  1. Analyze the unfiltered context provided by the vector database.
  2. Based on the given issue and the full context, determine which files are likely to be:
     - Modified
     - Added (if a required file or module does not exist, create a new path for it)
     - Deleted (only if explicitly necessary)
  3. Do NOT modify or rewrite any code at this stage.
  4. Return only a JSON array of file paths (using the help of repoTree) that are relevant to solving the issue.
  **IMPORTANT:** Use ONLY the valid file paths from the list provided be the repoTree. DO NOT invent or guess file paths.
  5. Only include files that must be directly edited or created to resolve the issue.
  6. If a necessary file does not exist based on the issue and context, include the appropriate new filepath.

  **Part 2 - Create a Step-by-Step Checklist:**

  1. Thoroughly analyze the provided issue.
  2. Review the contents of all the files listed in Part 1 to understand:
     - What logic or structure already exists
     - What is missing, broken, or needs to be added/updated
  3. Create a detailed checklist of steps needed to fully resolve the issue.
  4. The checklist should be accurate, actionable, and reflect how to implement or fix the code properly.
  5. **Preserve all existing code wherever possible.**
  6. **Only add new logic or enhancements—do not overwrite or delete existing logic unless explicitly instructed.**
  7. Do not include or write any code in this step.
  8. The checklist must reference the exact file and purpose of the change.

  ---

  📌 YOU MUST RETURN YOUR OUTPUT IN THE FOLLOWING STRICT JSON FORMAT ONLY.
  NO COMMENTS. NO EXPLANATIONS. JUST THE JSON BLOCK.
  EXAMPLE JSON BLOCK:
  \`\`\`json
  {
    "filePathsToBeChanged": ["rahul2.js", "mani.js", "file1.java", "file2.java"],
    "checklist": {
      "rahul2.js": [
        "Step 1: Rename 'rahul.js' to 'rahul2.js'.",
        "Step 2: Implement a function to find the smallest and largest elements in an array."
      ],
      "mani.js": [
        "Step 1: Update imports if needed based on changes to rahul2.js.",
        "Step 2: Refactor any references to the renamed file if applicable."
      ],
      "file1.java": [
        "Step 1: Verify that class File1 is not affected by the changes.",
        "Step 2: Ensure any dependencies needed for file2.java still function correctly."
      ],
      "file2.java": [
        "Step 1: Retain existing logic that uses File1 object.",
        "Step 2: Import or reference the new number guessing logic.",
        "Step 3: Print the guessed number alongside existing outputs."
      ]
    }
  }
  \`\`\`

  ONLY return output in that format. Do not return anything else.

  **Issue:** ${issueBody}
  **repoTree:** ${repoTree}
  **ConversationHistory:** ${conversationHistory}
  **CodeDiff:** ${codeDiff}
  **CommentText** ${commentText}
  **Unrefined Context:** ${context}`;

  //   const prompt = `
  // Your task is to refine the unfiltered context provided by the vector database for RAG and Create a checklist. Follow these rules:

  // 1. Include only context that is directly relevant to the given issue and dont try to solve that issue.
  // 2. Exclude any unrelated information.
  // 3. If relevant code segments that may be used elsewhere are found, include them.
  // 4. Format your output as a string containing key-value pairs in this format:
  //    filepath1: "content1", filepath2: "content2", ...
  //    If any additional code segments are included, format them as:
  //    filepath1: some other text
  // 5. Do not include any extra text beyond the refined context.

  //   **Create a Detailed And Correct Step-by-Step Checklist:**
  // 1. Parse the entire issue thoroughly before identifying the required tasks.
  // 2. Create a detailed **checklist** outlining each step necessary to address the issue.
  // 3. **Do not attempt to solve the issue**—only provide the checklist.
  // 4. Ensure that the checklist is clear, sequential, and directly related to the issue.

  // Issue: ${issueBody}
  // Unrefined Context: ${context};

  // **Return your output strictly in the following JSON format:**
  // \`\`\`json
  // {
  //   "refinedContext": "filepath1: \\"content1\\", filepath2: \\"content2\\"",
  //   "checklist": [
  //     "Step 1: ...",
  //     "Step 2: ...",
  //     "... etc."
  //   ]
  // }
  // \`\`\` `

  // const prompt = `
  // You are an AI code assistant. Your task is to identify *only the parts of the code that need to be modified* to solve the issue, without solving them yet.
  // ---
  // **Your Responsibilities:**
  // 1. **Parse the issue carefully.**
  // 2. Using the provided unrefined context (retrieved via vector search), identify which files and code snippets are relevant to the issue.
  // 3. Create a detailed step-by-step **modification checklist** describing what needs to be done, based on the issue and the code.
  //   - Be specific about what function/line/block should be edited.
  //   - Mention the *type* of change (add, delete, replace).
  //   - Do not return the final code yet — just the *plan of action*.
  // NOTE: IDENTIFY ALL FILES THAT NEEDS MODICATION AND TELL THE LLM IN DETAIL IN YOUR STEPS.
  // ---
  // **Output Format** (Strictly return valid JSON, no explanations outside it):
  // {
  //   "checklist": [
  //     "Step 1: In file 'filepath1', locate function 'xyz' and replace the deprecated method with the new one.",
  //     "Step 2: In file 'filepath2', add error handling logic after line 42 to catch missing values.",
  //     "Step 3: In file 'filepath3', delete the unused import 'abc'."
  //   ]
  // }

  // **Issue:** ${issueBody}
  // **Unrefined Context:** ${context}`;

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

// - For example, if the issue involves renaming a file, your checklist might be:
//       1. Create a new file with the target name.
//       2. Copy content from the original file.
//       3. Verify and adjust if necessary.
//       4. Delete or empty the original file if required.

async function generateFix(
  issueBody,
  context = "",
  checklist = [],
  conversationHistory = "",
  codeDiff = "",
  commentText = ""
) {
  const genAI = new GoogleGenerativeAI(geminiApiKey2);
  const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

  //   const prompt = `You are a GitHub Bot that outputs code modifications as a JSON diff.
  // For each file that needs a change, output an array of changes. Each change must be a JSON object with the following keys:
  // - "action": one of "modify", "add", "delete", or "empty".
  // - "original": the exact snippet from the original file that is being modified or deleted. (For "add" actions, use an empty string.)
  // - "new": the new code that should replace the original snippet, or the code to be added.
  // - "contextBefore": (optional) a snippet of code from the file immediately preceding the change, to help locate the insertion point. If not applicable, use an empty string.
  // NOTE: Dont delete exisiting code, and thorghly analyse all the files for updates.
  // NOTE: Use all the files in your context throughly.
  // NOTE: Dont modify original code(CAUTION: VERY SENSISTIVE TO EXTRA CHARACTERS AND FORMATING, NEEDS TO BE THE SAME AS INPUT) in your changes array.
  // **Example Output (strictly JSON):**
  // {
  //   "File1.java": {
  //     "changes": [
  //       {
  //         "action": "modify",
  //         "original": "public int add(int a, int b) { return a + b; }",
  //         "new": "public int add(int a, int b) { return a + b + 1; }",
  //         "contextBefore": "public class File1 {"
  //       },
  //       {
  //         "action": "delete",
  //         "original": "private int unused = 0;",
  //         "new": "",
  //         "contextBefore": "public class File1 {"
  //       }
  //     ]
  //   },
  //   "utils/helpers.js": {
  //     "changes": [
  //       {
  //         "action": "add",
  //         "original": "",
  //         "new": "console.log('New functionality added');",
  //         "contextBefore": "function helper() {"
  //       }
  //     ]
  //   }
  // }

  // Your task is to generate a JSON diff strictly in this format based on the following inputs. Only output the JSON diff with no additional text, explanations, or markdown formatting. Do not wrap the JSON output in any backticks.

  // Issue: ${issueBody}
  // Feedback: ${feedback}
  // Checklist: ${checklist}
  // Context: ${context}`;

  //   - If there are any mistakes in the checklist given, rectify it and use the corrected checklist.
  const prompt = `You are a GitHub Bot designed to help developers by precisely fixing or enhancing their code according to the provided issue, feedback, and context by giving only a JSON object like mentioned without changing the filepaths(even the case of the filepath, needs to be the exact same).

Requirements:

1. **Issue Analysis:**
   - Read and understand the issue, feedback, and context completely.
   - Identify the specific areas or files that need modifications.

2. **Step-by-Step Process:**
   - STRICTLY USE the given detailed checklist to solve the issue.
   - Dont even change the filepaths case.
   - Execute the checklist sequentially and backtrack if any step is incorrect.

3. **Code Modification Guidelines:**
   - Think twice before modifying. Only update lines/sections directly related to the issue.
   - DO NOT fix bugs unrelated to the issue unless instructed; instead, add a comment noting it.
   - DO NOT remove existing code unless instructed.
   - If new functionality is needed, integrate it carefully without breaking existing logic.
   - Maintain a clean, modular, and well-structured code style that separates logic from implementation.

4. **Handling Feedback:**
   - Incorporate any provided feedback into your solution.

5. **File Deletion:**
   - If a file must be deleted, do not remove the file. Instead, empty its content.

6. **STRICT Output Format:**
   - Return output as a raw JSON object with the structure: { "filepath1": "updated full content1", "filepath2": "updated full content2", ... }
   - PLEASE DONT CHANGE THE "filepath1" case to "Filepath1", PLEASE STICK TO THE FILEPATH CASE LIKE IN THE CHECKLIST PROVIDED.
   - OUPUT ONLY THE ENTIRE FILE CONTENT.
   - DO NOT include any explanation, markdown formatting, or extra text.
   - DO NOT wrap the output in backticks or code blocks.
   - ONLY return the VALID JSON object and nothing else.

Issue: ${issueBody}
Checklist: ${JSON.stringify(checklist)}
**ConversationHistory:** ${conversationHistory}
**CodeDiff:** ${codeDiff}
**CommentText** ${commentText}
Context: ${JSON.stringify(context)}`;

  //   const prompt = `You are a GitHub Bot designed to help developers by precisely fixing or enhancing their code according to the provided issue, feedback, and context.
  //   ---

  //   🧠 **Goal:**
  //   Make only the minimal necessary changes to the codebase to address the issue. Do not modify unrelated code.

  //   ---

  //   ### 🔍 1. Issue Analysis
  //   - Carefully understand the issue, checklist, and code context before attempting any change.
  //   - Identify exactly which files and line-level changes are required.

  //   ---

  //   ### 🛠️ 2. Checklist Execution
  //   - Use the checklist to guide your fix.
  //   - If the checklist is incorrect or missing steps, fix it silently and follow the corrected version.

  //   ---

  //   ### ✍️ 3. Code Modification Rules
  //   - Only return the **minimal diff** required to fix the issue.
  //   - **DO NOT** return the entire file contents.
  //   - Each file should only contain:
  //     - Lines that were **added**
  //     - Lines that were **modified**
  //     - Lines that were **removed** (return as empty string or a "DELETE" marker)
  //   - Keep unrelated code **unchanged and unreturned**.

  //   ---

  //   ### 🗃️ 4. Output Format (Strict) only use double quotes.
  //   - Only return a valid JSON object in this format:
  //   \`\`\`json
  //     {
  //       "filepath1": {
  //         "changes": [
  //           {
  //             "action": "modify",
  //             "line": 42,
  //             "original": "let x = 1;",
  //             "new": "let x = 2;"
  //           },
  //           {
  //             "action": "add",
  //             "line": 45,
  //             "new": "console.log('Debug info');"
  //           }
  //         ]
  //       },
  //       "filepath2": {
  //         "changes": [
  //           {
  //             "action": "delete",
  //             "line": 10,
  //             "original": "const unused = true;"
  //           }
  //         ]
  //       }
  //     }
  //  \`\`\`
  //   ---

  //   ### 🧹 5. Extra Notes
  //   - If the file must be emptied (e.g., deletion is requested), return:
  //     { "file_path": { "changes": [{ "action": "empty" }] } }
  //   - Do not return extra text, markdown, explanations, or logs.

  //   ---

  //   ### Inputs:
  //   Issue: ${issueBody}
  //   Feedback: ${feedback}
  //   Checklist: ${checklist}
  //   Context: ${context}`;

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
    //console.log("rossie:0", result.response.text());
    const processedresult = extractJson(result.response.text());
    //console.log("Generated fix:", processedresult);
    return processedresult;
  } catch (error) {
    console.error("Error generating fix:", error);
    return "";
  }
}

// // Helper functions for fuzzy matching
// function normalizeString(str) {
//   return str
//     .replace(/\s+/g, "")
//     .replace(/[^a-zA-Z0-9]/g, "")
//     .toLowerCase();
// }

// function levenshteinDistance(a, b) {
//   const matrix = [];
//   // increment along the first column of each row
//   for (let i = 0; i <= b.length; i++) {
//     matrix[i] = [i];
//   }
//   // increment each column in the first row
//   for (let j = 0; j <= a.length; j++) {
//     matrix[0][j] = j;
//   }
//   // Fill in the rest of the matrix
//   for (let i = 1; i <= b.length; i++) {
//     for (let j = 1; j <= a.length; j++) {
//       if (b.charAt(i - 1) === a.charAt(j - 1)) {
//         matrix[i][j] = matrix[i - 1][j - 1];
//       } else {
//         matrix[i][j] = Math.min(
//           matrix[i - 1][j - 1] + 1, // substitution
//           matrix[i][j - 1] + 1, // insertion
//           matrix[i - 1][j] + 1 // deletion
//         );
//       }
//     }
//   }
//   return matrix[b.length][a.length];
// }

// function similarityScore(s1, s2) {
//   const normA = normalizeString(s1);
//   const normB = normalizeString(s2);
//   const distance = levenshteinDistance(normA, normB);
//   const maxLen = Math.max(normA.length, normB.length);
//   return maxLen === 0 ? 1 : (maxLen - distance) / maxLen;
// }

// // Check if two strings are mostly similar based on a threshold
// function isMostlyMatch(a, b, threshold = 0.8) {
//   return similarityScore(a, b) >= threshold;
// }

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

    // const treeItems = await Promise.all(
    //   Object.entries(fix).map(async ([filePath, newContent]) => {
    //     try {
    //       const { data: fileData } = await octokit.request(
    //         "GET /repos/{owner}/{repo}/contents/{path}",
    //         {
    //           owner: payload.repository.owner.login,
    //           repo: payload.repository.name,
    //           path: filePath,
    //         }
    //       );

    //       const existingContent = Buffer.from(
    //         fileData.content,
    //         "base64"
    //       ).toString("utf-8");

    //       // Skip if nearly identical (no-op)
    //       const similarity = fuzz.ratio(existingContent, newContent);
    //       if (similarity > 97) {
    //         console.log(`Skipping ${filePath} (similarity: ${similarity}%)`);
    //         return null;
    //       }

    //       // Mark as deletion if content is empty
    //       if (!newContent || newContent.trim() === "") {
    //         console.log(`Marking ${filePath} for deletion.`);
    //         return {
    //           path: filePath,
    //           mode: "100644",
    //           type: "blob",
    //           sha: null,
    //         };
    //       }

    //       return {
    //         path: filePath,
    //         mode: "100644",
    //         type: "blob",
    //         content: newContent,
    //       };
    //     } catch {
    //       console.log(`Creating new file: ${filePath}`);
    //       return {
    //         path: filePath,
    //         mode: "100644",
    //         type: "blob",
    //         content: newContent,
    //       };
    //     }
    //   })
    // );

    // const filteredTree = treeItems.filter(Boolean);

    // const { data: newTree } = await octokit.request(
    //   "POST /repos/{owner}/{repo}/git/trees",
    //   {
    //     owner: payload.repository.owner.login,
    //     repo: payload.repository.name,
    //     base_tree: treeSha,
    //     tree: filteredTree,
    //   }
    // );

    // console.log("New tree created:", newTree.sha);

    // const treeItems = await Promise.all(
    //   Object.entries(fix).map(async ([filePath, diffObject]) => {
    //     try {
    //       const { data: fileData } = await octokit.request(
    //         "GET /repos/{owner}/{repo}/contents/{path}",
    //         {
    //           owner: payload.repository.owner.login,
    //           repo: payload.repository.name,
    //           path: filePath,
    //         }
    //       );

    //       console.log(`Existing file SHA for ${filePath}:`, fileData.sha);

    //       let originalContent = Buffer.from(
    //         fileData.content,
    //         "base64"
    //       ).toString("utf-8");
    //       const lines = originalContent.split("\n");

    //       // Apply diff to lines
    //       if (diffObject?.changes?.[0]?.action === "empty") {
    //         console.log(`Emptying file: ${filePath}`);
    //         return {
    //           path: filePath,
    //           mode: "100644",
    //           type: "blob",
    //           content: "",
    //         };
    //       }

    //       for (const change of diffObject.changes) {
    //         const { action, line, original, new: newLine } = change;

    //         if (action === "modify") {
    //           if (lines[line - 1] !== original) {
    //             console.warn(
    //               `Mismatch at ${filePath}:${line}: expected '${original}', found '${
    //                 lines[line - 1]
    //               }'`
    //             );
    //           }
    //           lines[line - 1] = newLine;
    //         } else if (action === "add") {
    //           lines.splice(line - 1, 0, newLine);
    //         } else if (action === "delete") {
    //           if (lines[line - 1] !== original) {
    //             console.warn(
    //               `Mismatch at ${filePath}:${line}: expected to delete '${original}', found '${
    //                 lines[line - 1]
    //               }'`
    //             );
    //           }
    //           lines.splice(line - 1, 1);
    //         }
    //       }

    //       const updatedContent = lines.join("\n");

    //       return {
    //         path: filePath,
    //         mode: "100644",
    //         type: "blob",
    //         content: updatedContent,
    //       };
    //     } catch (error) {
    //       console.log(`File ${filePath} does not exist. Creating new file.`);

    //       // If new file with diff content (assume all lines are additions)
    //       const lines = [];
    //       for (const change of diffObject.changes || []) {
    //         if (change.action === "add") {
    //           lines[change.line - 1] = change.new;
    //         }
    //       }

    //       return {
    //         path: filePath,
    //         mode: "100644",
    //         type: "blob",
    //         content: lines.join("\n"),
    //       };
    //     }
    //   })
    // );

    // const { data: newTree } = await octokit.request(
    //   "POST /repos/{owner}/{repo}/git/trees",
    //   {
    //     owner: payload.repository.owner.login,
    //     repo: payload.repository.name,
    //     base_tree: treeSha,
    //     tree: treeItems,
    //   }
    // );

    // console.log("New tree created:", newTree.sha);

    // not working

    // const treeItems = await Promise.all(
    //   Object.entries(fix).map(async ([filePath, diffObject]) => {
    //     try {
    //       // Get file's existing SHA and content (if it exists)
    //       const { data: fileData } = await octokit.request(
    //         "GET /repos/{owner}/{repo}/contents/{path}",
    //         {
    //           owner: payload.repository.owner.login,
    //           repo: payload.repository.name,
    //           path: filePath,
    //         }
    //       );
    //       console.log(`Existing file SHA for ${filePath}:`, fileData.sha);
    //       let originalContent = Buffer.from(
    //         fileData.content,
    //         "base64"
    //       ).toString("utf-8");

    //       // If diff instructs to empty the file, return an empty content.
    //       if (diffObject?.changes?.[0]?.action === "empty") {
    //         console.log(`Emptying file: ${filePath}`);
    //         return {
    //           path: filePath,
    //           mode: "100644",
    //           type: "blob",
    //           content: "",
    //         };
    //       }

    //       // Apply each change based on fuzzy substring matching
    //       for (const change of diffObject.changes) {
    //         const { action, original, new: newLine, contextBefore } = change;

    //         if (action === "modify") {
    //           let index = originalContent.indexOf(original);
    //           // If an exact match is not found, try fuzzy matching:
    //           if (index === -1) {
    //             // Slide through the content with a window similar in size to the original snippet.
    //             for (
    //               let i = 0;
    //               i <= originalContent.length - original.length;
    //               i++
    //             ) {
    //               const segment = originalContent.slice(i, i + original.length);
    //               if (isMostlyMatch(segment, original)) {
    //                 index = i;
    //                 break;
    //               }
    //             }
    //           }
    //           if (index !== -1) {
    //             console.log(
    //               `Modifying snippet in ${filePath} at index ${index}`
    //             );
    //             // Replace the found segment (using the length of the original snippet) with the new line.
    //             originalContent =
    //               originalContent.slice(0, index) +
    //               newLine +
    //               originalContent.slice(index + original.length);
    //           } else {
    //             console.warn(
    //               `Could not find snippet to modify in ${filePath}: "${original}"`
    //             );
    //           }
    //         } else if (action === "delete") {
    //           let index = originalContent.indexOf(original);
    //           if (index === -1) {
    //             for (
    //               let i = 0;
    //               i <= originalContent.length - original.length;
    //               i++
    //             ) {
    //               const segment = originalContent.slice(i, i + original.length);
    //               if (isMostlyMatch(segment, original)) {
    //                 index = i;
    //                 break;
    //               }
    //             }
    //           }
    //           if (index !== -1) {
    //             console.log(
    //               `Deleting snippet in ${filePath} at index ${index}`
    //             );
    //             originalContent =
    //               originalContent.slice(0, index) +
    //               originalContent.slice(index + original.length);
    //           } else {
    //             console.warn(
    //               `Could not find snippet to delete in ${filePath}: "${original}"`
    //             );
    //           }
    //         } else if (action === "add") {
    //           // For additions, if a contextBefore is provided, insert after it.
    //           if (contextBefore) {
    //             const idx = originalContent.indexOf(contextBefore);
    //             if (idx !== -1) {
    //               const insertionIndex = idx + contextBefore.length;
    //               originalContent =
    //                 originalContent.slice(0, insertionIndex) +
    //                 "\n" +
    //                 newLine +
    //                 originalContent.slice(insertionIndex);
    //             } else {
    //               console.warn(
    //                 `Context marker not found for addition in ${filePath}: "${contextBefore}"`
    //               );
    //               // Optionally append if context marker isn't found:
    //               originalContent += "\n" + newLine;
    //             }
    //           } else {
    //             // If no context is provided, append the new line at the end.
    //             originalContent += "\n" + newLine;
    //           }
    //         }
    //       }

    //       return {
    //         path: filePath,
    //         mode: "100644",
    //         type: "blob",
    //         content: originalContent,
    //       };
    //     } catch (error) {
    //       console.log(`File ${filePath} does not exist. Creating new file.`);
    //       // For new files, assume all changes are "add" actions.
    //       let newContent = "";
    //       for (const change of diffObject.changes || []) {
    //         if (change.action === "add") {
    //           newContent += change.new + "\n";
    //         }
    //       }
    //       return {
    //         path: filePath,
    //         mode: "100644",
    //         type: "blob",
    //         content: newContent.trim(),
    //       };
    //     }
    //   })
    // );

    // const filteredTree = treeItems.filter(Boolean);

    // const { data: newTree } = await octokit.request(
    //   "POST /repos/{owner}/{repo}/git/trees",
    //   {
    //     owner: payload.repository.owner.login,
    //     repo: payload.repository.name,
    //     base_tree: treeSha,
    //     tree: filteredTree,
    //   }
    // );

    // console.log("New tree created:", newTree.sha);
    // working but bad search

    // const treeItems = await Promise.all(
    //   Object.entries(fix).map(async ([filePath, diffObject]) => {
    //     try {
    //       // Get file's existing SHA and content (if it exists)
    //       const { data: fileData } = await octokit.request(
    //         "GET /repos/{owner}/{repo}/contents/{path}",
    //         {
    //           owner: payload.repository.owner.login,
    //           repo: payload.repository.name,
    //           path: filePath,
    //         }
    //       );
    //       console.log(`Existing file SHA for ${filePath}:`, fileData.sha);
    //       let originalContent = Buffer.from(
    //         fileData.content,
    //         "base64"
    //       ).toString("utf-8");

    //       // If diff instructs to empty the file, return an empty content.
    //       if (diffObject?.changes?.[0]?.action === "empty") {
    //         console.log(`Emptying file: ${filePath}`);
    //         return {
    //           path: filePath,
    //           mode: "100644",
    //           type: "blob",
    //           content: "",
    //         };
    //       }

    //       // Apply each change based on substring matching
    //       for (const change of diffObject.changes) {
    //         const { action, original, new: newLine, contextBefore } = change;

    //         if (action === "modify") {
    //           const index = originalContent.indexOf(original);
    //           if (index !== -1) {
    //             // Replace the first occurrence of the original snippet
    //             originalContent = originalContent.replace(original, newLine);
    //           } else {
    //             console.warn(
    //               `Could not find snippet to modify in ${filePath}: "${original}"`
    //             );
    //           }
    //         } else if (action === "delete") {
    //           const index = originalContent.indexOf(original);
    //           if (index !== -1) {
    //             // Remove the snippet by replacing it with an empty string
    //             originalContent = originalContent.replace(original, "");
    //           } else {
    //             console.warn(
    //               `Could not find snippet to delete in ${filePath}: "${original}"`
    //             );
    //           }
    //         } else if (action === "add") {
    //           // For additions, if a contextBefore is provided, insert after it.
    //           if (contextBefore) {
    //             const idx = originalContent.indexOf(contextBefore);
    //             if (idx !== -1) {
    //               const insertionIndex = idx + contextBefore.length;
    //               originalContent =
    //                 originalContent.slice(0, insertionIndex) +
    //                 "\n" +
    //                 newLine +
    //                 originalContent.slice(insertionIndex);
    //             } else {
    //               console.warn(
    //                 `Context marker not found for addition in ${filePath}: "${contextBefore}"`
    //               );
    //               // Optionally append if context marker isn't found:
    //               originalContent += "\n" + newLine;
    //             }
    //           } else {
    //             // If no context is provided, append the new line at the end.
    //             originalContent += "\n" + newLine;
    //           }
    //         }
    //       }

    //       return {
    //         path: filePath,
    //         mode: "100644",
    //         type: "blob",
    //         content: originalContent,
    //       };
    //     } catch (error) {
    //       console.log(`File ${filePath} does not exist. Creating new file.`);
    //       // For new files, assume all changes are "add" actions.
    //       let newContent = "";
    //       for (const change of diffObject.changes || []) {
    //         if (change.action === "add") {
    //           newContent += change.new + "\n";
    //         }
    //       }
    //       return {
    //         path: filePath,
    //         mode: "100644",
    //         type: "blob",
    //         content: newContent.trim(),
    //       };
    //     }
    //   })
    // );

    // const filteredTree = treeItems.filter(Boolean);

    // const { data: newTree } = await octokit.request(
    //   "POST /repos/{owner}/{repo}/git/trees",
    //   {
    //     owner: payload.repository.owner.login,
    //     repo: payload.repository.name,
    //     base_tree: treeSha,
    //     tree: filteredTree,
    //   }
    // );

    // console.log("New tree created:", newTree.sha);

    //working

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

async function handleIssueOpened(
  { octokit, payload },
  conversationHistory = "",
  codeDiff = "",
  commentText = ""
) {
  console.log(`Received an issue event for #${payload.issue.number}`);

  try {
    if (!commentText || !conversationHistory || !codeDiff) {
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
      //console.log("Context:", context);

      const structure = [];
      // Corrected getRepoFileStructure function
      async function getRepoFileStructure(owner, repo, path = "") {
        try {
          const { data } = await octokit.request(
            "GET /repos/{owner}/{repo}/contents/{path}",
            {
              owner,
              repo,
              path,
            }
          );

          const items = Array.isArray(data) ? data : [data];

          for (const item of items) {
            const node = {
              path: item.path,
            };

            if (item.type === "dir") {
              node.children = await getRepoFileStructure(
                owner,
                repo,
                item.path
              );
            }
            const ext = fpath.extname(item.path).toLowerCase();
            if (
              isCodeFile(ext) ||
              [".txt", ".md", ".json", ".csv"].includes(ext)
            )
              structure.push(node);
          }
          return structure;
        } catch (err) {
          console.error(`Failed at path "${path}":`, err.message);
          return [];
        }
      }

      // Corrected call for getRepoFileStructure
      const repoTree = await getRepoFileStructure(
        payload.repository.owner.login,
        payload.repository.name
      );
      console.warn("structure:", repoTree);
      const processedContext = await fixContext(
        payload.issue.body,
        context.documents,
        repoTree,
        conversationHistory,
        codeDiff,
        commentText
      );

      //console.log("docs", context.documents[0]);
      const rawDocs = context.documents[0]; // unwrap the inner array
      console.log("Context Docs:", rawDocs);
      function extractDocObject(docString) {
        const separatorIndex = docString.indexOf(":");
        if (separatorIndex === -1) return null;
        const path = docString.slice(0, separatorIndex).trim();
        const content = docString.slice(separatorIndex + 1).trim();
        return { path, content };
      }

      const parsedDocs = rawDocs.map(extractDocObject);
      //console.log("parsedDocs", parsedDocs);

      const contextObj = extractJson(processedContext);

      function correctFilePaths(outputJson, repoTree) {
        const flatPaths = repoTree.map((obj) => obj.path);
        const correctedOutput = {
          filePathsToBeChanged: [],
          checklist: {},
        };

        function findPathForFile(filename) {
          const matches = flatPaths.filter(
            (path) => path.endsWith(`/${filename}`) || path === filename
          );
          return matches.length > 0 ? matches[0] : null;
        }

        for (const incorrectPath of outputJson.filePathsToBeChanged) {
          const filename = incorrectPath.split("/").pop();
          const correctedPath = findPathForFile(filename) || incorrectPath;

          // Add to corrected file list
          correctedOutput.filePathsToBeChanged.push(correctedPath);

          // Update checklist mapping
          if (outputJson.checklist[incorrectPath]) {
            correctedOutput.checklist[correctedPath] =
              outputJson.checklist[incorrectPath];
          } else {
            // Try fuzzy match by filename in checklist keys
            const matchingKey = Object.keys(outputJson.checklist).find((k) =>
              k.endsWith(`/${filename}`)
            );
            if (matchingKey) {
              correctedOutput.checklist[correctedPath] =
                outputJson.checklist[matchingKey];
            }
          }
        }

        return correctedOutput;
      }

      const correctedContextObj = correctFilePaths(contextObj, repoTree);
      const filePathsToBeChanged = correctedContextObj.filePathsToBeChanged;
      console.log("filePathsToBeChanged", filePathsToBeChanged);

      //get all files acc to filepathstobechanged from the git repo and append it to parsed docs
      // Function to fetch a single file from the repo
      async function fetchFile(filePath) {
        try {
          const { data: fileData } = await octokit.request(
            "GET /repos/{owner}/{repo}/contents/{path}",
            {
              owner: payload.repository.owner.login,
              repo: payload.repository.name,
              path: filePath,
            }
          );
          // Decode content from Base64
          const content = Buffer.from(fileData.content, "base64").toString(
            "utf-8"
          );
          console.log(`File found: ${filePath}. Fetching file.`);
          return { path: filePath, content };
        } catch (error) {
          if (error.status === 404) {
            console.warn(`File not found: ${filePath}. Skipping this file.`);
            return null;
          } else {
            // For other errors, rethrow or handle appropriately
            throw error;
          }
        }
      }

      // Example: fetch all files from filePathsToBeChanged and update parsedDocs
      async function updateParsedDocs(filePathsToBeChanged) {
        const fetchedDocs = await Promise.all(
          filePathsToBeChanged.map(
            async (filePath) => await fetchFile(filePath)
          )
        );
        // Filter out any files that returned null (not found)
        const validDocs = fetchedDocs.filter((doc) => doc !== null);
        // Append these to your existing parsedDocs (or replace, depending on your use case)
        parsedDocs.push(...validDocs);
        //console.log("Updated parsedDocs:", parsedDocs);
      }

      // Then, call the function before further processing:
      await updateParsedDocs(filePathsToBeChanged);

      const allFixes = {};

      for (const filePath of filePathsToBeChanged) {
        // Find the document for the current file
        const fileDoc = parsedDocs.find((doc) => doc?.path === filePath);
        //console.log("fileDoc:", fileDoc);
        if (!fileDoc) {
          console.warn(`No document found for ${filePath}`);
          continue;
        }

        // Get the checklist for this file
        const checklistSteps = correctedContextObj.checklist[filePath] || [];

        // Log file content (for debugging)
        const docContent = fileDoc?.content || "";
        //console.log("docContent for", filePath, ":", docContent);

        // (Optional) Compute token count if needed
        // const checklistText = checklistSteps.join("\n");
        // const totalTokens = getTokenCount(docContent) + getTokenCount(checklistText);

        // For each file, create a group that contains only this file
        const groupDocs = [fileDoc];
        const groupChecklist = { [filePath]: checklistSteps };

        // Call generateFix for the single file group
        const fixPart = await generateFix(
          payload.issue.body,
          groupDocs,
          groupChecklist,
          conversationHistory,
          codeDiff,
          commentText
        );
        //console.warn("Fix Part for", filePath, ":", fixPart);

        // Merge fixPart into the overall object; if fixPart has changes for a file, merge their changes arrays
        for (const file in fixPart) {
          if (allFixes[file]) {
            allFixes[file].changes = allFixes[file].changes.concat(
              fixPart[file].changes
            );
          } else {
            allFixes[file] = fixPart[file];
          }
        }
      }

      // Convert the final fix object to a JSON string for further use
      // const fix = JSON.stringify(allFixes, null, 2);
      //console.log("Final Fix:", allFixes);

      // const processedContext = await fixContext(
      //   payload.issue.body,
      //   context.documents
      // );

      // const contextObj = extractJson(processedContext);
      // const filePathsToBeChanged = contextObj.filePathsToBeChanged;

      // const fix = await generateFix(
      //   payload.issue.body,
      //   context.documents,
      //   contextObj.checklist,
      //   reply
      // );
      if (allFixes) {
        await createPR(octokit, payload, allFixes);
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
        { octokit, payload },
        conversationHistory,
        codeDiff,
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
