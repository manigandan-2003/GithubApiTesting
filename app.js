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

    const fix = await generateFix(payload.issue.body);
    if (fix) {
      await createPR(octokit, payload, fix);
    }
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

async function generateFix(issueBody) {
  const genAI = new GoogleGenerativeAI(geminiApiKey);
  const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

  const prompt = `Fix the following issue in JavaScript and respond with only corrected code: ${issueBody}`;

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
