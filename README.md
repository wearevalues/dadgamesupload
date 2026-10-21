# Photo Uploader

A branded page where people upload photos and videos into a Google Drive folder, sorted by project. One codebase runs two sites (Values and Dad Games) as the Vercel projects `photo-uploader` and `valuesupload`.

Each project has its own environment variables, Blob store, Drive folder and branding. Code is shared.

## How an upload works

1. The browser uploads each file straight to **Vercel Blob** (`/api/media/blob-client` hands out a short-lived token). This avoids Vercel's ~4.5 MB request limit.
2. The browser calls `/api/media/blob-commit`, which streams the file from Blob into **Google Drive** (`<Drive folder>/<Project>/`) and deletes the Blob copy.
3. The first file goes alone (so the project folder is created once); the rest go 3 at a time. Network and 5xx errors are retried with backoff. Failed files stay selected so "Upload" only retries those.
4. Each submission is recorded in Blob (`media-uploader/submissions/`) and shown under **Recent Uploads** in `/admin`.

A daily cron (`/api/cron/cleanup-blobs`, see `vercel.json`) deletes Blob uploads older than 24 hours that never made it to Drive.

Without `BLOB_READ_WRITE_TOKEN`, uploads fall back to posting through the server, which only works for small files.

## Admin

`/admin` — edit branding, Drive folder, projects, and whether uploaders may type their own project name. Sign in with `ADMIN_PASSWORD`. On Vercel, admin login is disabled until that variable is set.

## Deploying

Pushing to `main` runs `.github/workflows/deploy-vercel-both.yml`, which deploys to **both** Vercel projects. It needs a `VERCEL_TOKEN` secret in each GitHub Environment.

If either project is also connected to this repo in Vercel → Settings → Git, each push builds twice. Disconnect Git there and let the workflow handle deploys.

Environment variable changes only take effect after a redeploy.

## Handling a crowd

- **Google Drive is the bottleneck.** Every file goes through one service account, and Drive only allows a few writes per second per account. The server retries rate-limit errors with backoff, and the browser retries on top of that, so a busy moment slows uploads down instead of failing them. Drive also caps each account at about 750 GB of uploads per day.
- **Add projects in admin before an event.** That creates the Drive folder ahead of time, so the first wave of uploads doesn't race to create it.
- The public page and `/api/settings` are cached at Vercel's edge for 60 seconds, so a crowd loading the page doesn't hit the server or Blob storage each time. Admin changes take about a minute to show.

Before a big event, load-test a deployment:

```bash
node scripts/load-test.mjs --url https://your-site.vercel.app --users 50 --files 5 --project "Load Test"
```

Real files land in Drive under that project, so delete the "Load Test" folder afterwards.

## Running locally

```bash
npm install
cp .env.example .env   # fill in at least the Google + Blob values
npm run dev            # http://localhost:4173, admin password "password" unless ADMIN_PASSWORD is set
```

`npm run build` re-bundles `public/vercel-blob-client.mjs` from `@vercel/blob`. Run it after upgrading that package.
