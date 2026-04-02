# Self-Hosting Dolos with Docker

Guide to deploy the customized Dolos (based on the LMS (class zip -> student folder -> code zip -> code), TheoryExam (class zip -> student's code zip -> code), and OJ Bulk Download file structures (class zip -> student folder -> problem folder -> code)) on a server with existing nginx and MySQL, making it accessible over the network.

## Custom Features

- **"Only consider correct answer" checkbox**: When enabled during upload, the system filters files per problem subfolder inside each student folder. If any file in a subfolder has "correct" (case-insensitive) in its filename, only those files are considered for similarity analysis. If no file matches, all files in that subfolder are included as usual.

## Step 0: Clone the Repository

This repo uses git submodules for tree-sitter parsers. Clone recursively:

```bash
git clone --recursive https://github.com/Luche/dolos.git
cd dolos
```

If you already cloned without `--recursive`, initialize submodules manually:

```bash
git submodule update --init --recursive
```

## Prerequisites

- Docker and Docker Compose installed on the server
- nginx already running (will be used as reverse proxy)
- MySQL 5.7+ already running (optional - can use the bundled MariaDB instead)

## Architecture Overview

```
Browser ──► nginx (reverse proxy)
              ├── /dolos/     ──► web container (:8080)
              └── /dolos/api/ ──► api container (:3000)
                                    ├── db container (MariaDB)
                                    └── worker container
                                          └── spawns CLI containers
```

## How User Data Works

- Each user's analysis history is stored in their **browser's localStorage** (key: `dolos:reports`)
- No login/account system - switching browser or clearing data resets the history
- The same browser will always show previous results as long as localStorage is intact
- Reports and datasets are **automatically purged after 30 days** (files deleted, record marked as `purged`)

## Step 1: Configure Environment

Copy and edit the environment file:

```bash
cp .env.example .env
```

Edit `.env` for your server. Example for a server at `domjudge.example.com`:

```bash
# Protocol
WEB_PROTOCOL=http

# Database (used by the bundled MariaDB container)
DATABASE_ROOT_PASSWORD=<strong-root-password>
DATABASE_USER=dolos
DATABASE_PASSWORD=<strong-password>

# Frontend - as seen by the user's browser
FRONTEND_EXTERNAL_HOST=domjudge.example.com
FRONTEND_EXTERNAL_PORT=80
FRONTEND_EXTERNAL_PATH=/dolos

# Frontend - internal binding (nginx will proxy to this)
FRONTEND_INTERNAL_HOST=127.0.0.1
FRONTEND_INTERNAL_PORT=8080

# API - as seen by the user's browser
API_EXTERNAL_HOST=domjudge.example.com
API_EXTERNAL_PORT=80
API_EXTERNAL_PATH=/dolos/api

# API - internal binding (nginx will proxy to this)
API_INTERNAL_HOST=127.0.0.1
API_INTERNAL_PORT=3000

# Worker needs Docker socket to spawn CLI containers
DOCKER_SOCKET=/var/run/docker.sock
```

If using HTTPS, set `WEB_PROTOCOL=https` and `*_EXTERNAL_PORT=443`.

## Step 2: Build All Docker Images

All three images must be built from local source to include the custom features. The `docker-compose.yml` already has `build` directives enabled for `web`, `api`, and `worker`.

```bash
# Build the CLI image (worker spawns this to analyze uploads)
docker build -f Dockerfile.cli -t ghcr.io/dodona-edu/dolos-cli:latest .

# Build the web, api, and worker images
docker compose build
```

## Step 3: Start Services

```bash
docker compose up -d
```

This starts: `db` (MariaDB), `api` (Rails + runs migrations automatically), `web` (Vue frontend), `worker` (background jobs).

Verify all services are healthy:

```bash
docker compose ps
```

## Step 4: Configure nginx Reverse Proxy

Add to your nginx server block (e.g., `/etc/nginx/sites-available/default`):

```nginx
# Dolos Web UI
location /dolos/ {
    proxy_pass http://127.0.0.1:8080/;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}

# Dolos API
location /dolos/api/ {
    proxy_pass http://127.0.0.1:3000/;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;

    # Allow large zip uploads
    client_max_body_size 100M;
}
```

Test and reload nginx:

```bash
sudo nginx -t
sudo systemctl reload nginx
```

## Step 5: Verify

1. Open `http://domjudge.example.com/dolos/` in browser
2. Upload a test zip file
3. Wait for analysis to complete
4. Confirm the report appears in the list

## Auto-Cleanup (30 Days)

Enabled by default. When a report is created, a delayed job is scheduled to run 30 days later. It:

1. Purges all attached result CSV files (metadata, files, kgrams, pairs)
2. Purges the uploaded zip file from the dataset
3. Sets the report status to `purged`

The database records remain (for auditing) but all file data is deleted. The worker service processes these cleanup jobs automatically.

## Using Existing MySQL Instead of Bundled MariaDB

If you prefer using your existing MySQL 5.7:

1. Create the database and user:

```sql
CREATE DATABASE dolos CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'dolos'@'%' IDENTIFIED BY '<password>';
GRANT ALL PRIVILEGES ON dolos.* TO 'dolos'@'%';
FLUSH PRIVILEGES;
```

2. In `docker-compose.yml`, remove the `db` service and `dolos-db-data` volume.

3. Update the `api` and `worker` services environment:

```yaml
environment:
  DOLOS_API_DATABASE_HOST: host.docker.internal  # or your MySQL host IP
  DOLOS_API_DATABASE_USERNAME: dolos
  DOLOS_API_DATABASE_PASSWORD: <password>
```

4. Remove `depends_on: db` from the `api` service.

## Troubleshooting

**"out of memory" errors**: The CLI container has a 4GB memory limit (configured in `api/app/jobs/analyze_dataset_job.rb`). Increase `MEMORY_LIMIT` if needed.

**"Could not detect language"**: Make sure the CLI image was built from local source (Step 2). The fix filters zip contents to code files only.

**Worker can't spawn containers**: Check that `DOCKER_SOCKET` points to the correct Docker socket and the worker container has access.

**Upload fails with 413**: Increase `client_max_body_size` in nginx config. The API accepts up to 100MB zips.

**Reports stuck in "queued"**: Check worker logs: `docker compose logs worker`. Ensure the CLI image exists locally.
