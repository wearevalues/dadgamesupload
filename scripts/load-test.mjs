#!/usr/bin/env node
// Simulates many people uploading at once, using the same flow as the browser.
//
//   node scripts/load-test.mjs --url https://your-site.vercel.app --users 50 --files 5 --project "Load Test"
//
// Options: --size-kb (default 1500), --concurrency per user (default 3, same as the page),
//          --code (access code, if UPLOAD_ACCESS_CODE is set), --ramp-ms (spread user start times).
//
// Every file really lands in Google Drive under the chosen project, so point --project at a
// throwaway project (with "Other" allowed or added in admin) and delete that folder afterwards.

import { upload as blobUpload } from "@vercel/blob/client";
import { randomBytes } from "node:crypto";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, arg, i, all) => {
    if (arg.startsWith("--")) pairs.push([arg.slice(2), all[i + 1]?.startsWith("--") ? "true" : all[i + 1]]);
    return pairs;
  }, [])
);

const baseUrl = (args.url || "http://localhost:4173").replace(/\/$/, "");
const users = Number(args.users || 10);
const filesPerUser = Number(args.files || 3);
const sizeKb = Number(args["size-kb"] || 1500);
const concurrency = Number(args.concurrency || 3);
const rampMs = Number(args["ramp-ms"] || 2000);
const project = args.project || "Load Test";
const accessCode = args.code || "";

async function postJson(path, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${path} ${res.status}: ${text.slice(0, 160)}`);
  return JSON.parse(text);
}

async function uploadViaBlob(name, batchId, index, file) {
  const blob = await blobUpload(`media-uploader/incoming/${batchId}/${index}-${file.name}`, file, {
    access: "public",
    handleUploadUrl: `${baseUrl}/api/media/blob-client`,
    clientPayload: JSON.stringify({ name, project, originalFilename: file.name, fileIndex: index, accessCode }),
    multipart: file.size > 6 * 1024 * 1024
  });
  await postJson("/api/media/blob-commit", {
    name,
    project,
    uploadBatchId: batchId,
    accessCode,
    files: [{ url: blob.url, originalFilename: file.name, fileIndex: index }]
  });
}

async function uploadViaServer(name, _batchId, _index, file) {
  const form = new FormData();
  form.append("name", name);
  form.append("project", project);
  form.append("accessCode", accessCode);
  form.append("media", file, file.name);
  const res = await fetch(`${baseUrl}/api/upload`, { method: "POST", body: form });
  if (!res.ok) throw new Error(`/api/upload ${res.status}: ${(await res.text()).slice(0, 160)}`);
}

const results = [];

async function runUser(userNumber, uploadOne) {
  await new Promise((r) => setTimeout(r, Math.random() * rampMs));
  const name = `LoadTest ${userNumber}`;
  const batchId = `${Date.now()}-${randomBytes(6).toString("hex")}`;
  const files = Array.from(
    { length: filesPerUser },
    (_, i) => new File([randomBytes(sizeKb * 1024)], `user${userNumber}_photo${i + 1}.jpg`, { type: "image/jpeg" })
  );

  const timeOne = async (file, i) => {
    const started = performance.now();
    try {
      await uploadOne(name, batchId, i + 1, file);
      results.push({ ok: true, ms: performance.now() - started });
    } catch (err) {
      results.push({ ok: false, ms: performance.now() - started, error: err.message });
    }
  };

  // Same pattern as the page: first file alone, then the rest a few at a time.
  await timeOne(files[0], 0);
  let next = 1;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, files.length - 1) }, async () => {
      while (next < files.length) {
        const i = next++;
        await timeOne(files[i], i);
      }
    })
  );
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

const settings = await (await fetch(`${baseUrl}/api/settings`)).json();
const mode = settings.client?.blobDriveUpload ? "blob" : "server";
const uploadOne = mode === "blob" ? uploadViaBlob : uploadViaServer;

console.log(
  `${users} users × ${filesPerUser} files × ${sizeKb} KB → ${baseUrl} (${mode} mode, project "${project}")`
);
const started = performance.now();
await Promise.all(Array.from({ length: users }, (_, i) => runUser(i + 1, uploadOne)));
const totalSec = (performance.now() - started) / 1000;

const ok = results.filter((r) => r.ok);
const failed = results.filter((r) => !r.ok);
const times = ok.map((r) => r.ms).sort((a, b) => a - b);
const fmt = (ms) => `${(ms / 1000).toFixed(1)}s`;

console.log(`\nDone in ${totalSec.toFixed(1)}s`);
console.log(`Succeeded: ${ok.length}/${results.length}`);
if (times.length) {
  console.log(`Per file: median ${fmt(percentile(times, 50))}, p95 ${fmt(percentile(times, 95))}, max ${fmt(times[times.length - 1])}`);
}
if (failed.length) {
  const counts = {};
  for (const f of failed) counts[f.error] = (counts[f.error] || 0) + 1;
  console.log("Failures:");
  for (const [msg, n] of Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 10)) {
    console.log(`  ${n}× ${msg}`);
  }
  process.exitCode = 1;
}
