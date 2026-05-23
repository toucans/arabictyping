# Arabic Audio Worker

Cloudflare Worker that serves and uploads audio files for the Arabic typing trainer, backed by the R2 bucket `arabic-audio`.

## Setup

1. **Fill in your account ID** in `wrangler.toml`:

   ```toml
   account_id = "<YOUR_ACCOUNT_ID>"
   ```

   Find it at https://dash.cloudflare.com → right sidebar → *Account ID*.

2. **Set the upload password** (you'll be prompted to paste it):

   ```sh
   cd worker
   wrangler secret put UPLOAD_PASSWORD
   ```

3. **Deploy**:

   ```sh
   wrangler deploy
   ```

   Wrangler will print the deployed worker URL, e.g.:

   ```
   Published arabic-audio (1.23 sec)
     https://arabic-audio.<your-subdomain>.workers.dev
   ```

4. **Wire it into the site**: open `../index.html` and set the `WORKER_URL` constant near the top of the `<script>` block to that URL (no trailing slash):

   ```js
   const WORKER_URL = 'https://arabic-audio.<your-subdomain>.workers.dev';
   ```

5. Open the Word List tab on the site, paste the password into the *upload password* field, hit *save* — the per-row upload buttons appear.

## Endpoints

| Method | Path                  | Auth | Notes                                                    |
| ------ | --------------------- | ---- | -------------------------------------------------------- |
| GET    | `/audio/<filename>`   | no   | Returns audio bytes with the right `Content-Type`.       |
| POST   | `/upload`             | yes  | Multipart form: fields `file` and `filename`. Returns `{ ok, url, filename }`. |
| GET    | `/list`               | yes  | Returns `{ files: [string, ...] }`.                      |
| DELETE | `/audio/<filename>`   | yes  | Returns `{ ok, filename }`.                              |
| OPTIONS| `*`                   | n/a  | CORS preflight.                                          |

Auth: send `Authorization: Bearer <UPLOAD_PASSWORD>`.

## CORS

`ALLOWED_ORIGINS` in `src/index.js` lists the origins permitted to call the worker. By default:

- `https://toucans.github.io` (your GitHub Pages site)
- `http://localhost:8765` and `http://127.0.0.1:8765` (local dev)

Edit and redeploy to add more.

## Local development

```sh
cd worker
wrangler dev
```

`wrangler dev` uses your local secrets — if you haven't run `wrangler secret put UPLOAD_PASSWORD` yet, create a `.dev.vars` file in the `worker/` directory:

```
UPLOAD_PASSWORD=devpassword
```

`.dev.vars` is ignored by git and only used by the local dev server.
