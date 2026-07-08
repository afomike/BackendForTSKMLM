# E-Learning API

This repository is a Node.js + TypeScript backend for an e-learning platform. It uses Express for HTTP routing, Drizzle ORM for PostgreSQL access, and Pino for logging.

## What this project does

- Serves API endpoints under `/api`
- Connects to a PostgreSQL database
- Uses JSON Web Tokens for authentication
- Supports file storage configuration through Cloudinary
- Builds a production bundle with `esbuild`

## Getting started for beginners

### 1. Install dependencies

```bash
npm install --ignore-scripts
```

### 2. Copy environment variables

Copy `.env.example` to `.env` and fill in the values.

### 3. Run locally

```bash
npm run dev
```

### 4. Build for production

```bash
npm run build
```

### 5. Run the production build

```bash
npm run start
```

### 6. Generate and apply database migrations

```bash
npm run db:generate
npm run db:migrate
```

If you prefer to sync the schema directly without generating SQL files, you can use:

```bash
npm run db:push
```

## Render deployment

This project includes a `render.yaml` manifest for Render.

- `buildCommand`: installs dependencies and builds the app
- `startCommand`: runs the built production server
- `envVars`: environment variables Render must provide

### Required Render environment variables

- `DATABASE_URL`
  - The PostgreSQL connection string for the database.
  - Required for the app to start.
- `SESSION_SECRET`
  - A long secret string used for signing authentication tokens.
  - Keep this private.
- `NODE_ENV`
  - Should be `production` in Render.
- `PORT`
  - The port used by the server.
  - Render can set this automatically, but the manifest uses `10000` as a standard value.
- `FRONTEND_URL`
  - Optional URL for your frontend application.
  - Used by CORS configuration.
- `CLOUDINARY_CLOUD_NAME`
  - Required for Cloudinary uploads.
- `CLOUDINARY_API_KEY`
  - Required for Cloudinary uploads.
- `CLOUDINARY_API_SECRET`
  - Required for Cloudinary uploads.
- `CLOUDINARY_UPLOAD_PRESET`
  - Optional but recommended for unsigned uploads.
- `CLOUDINARY_FOLDER`
  - Optional folder name for uploaded assets.

> If you are using Neon, you can also set `NEON_DATABASE_URL` instead of `DATABASE_URL`.

## Files and folders explained for beginners

### `src/index.ts`

This is the app entrypoint.
- It loads the Express app and logger.
- It reads `PORT` from environment variables.
- It starts the server.
- It prints a helpful error if startup fails.

### `src/app.ts`

This sets up the Express application.
- Adds logging middleware with Pino.
- Adds CORS so the API can be called from a frontend app.
- Parses JSON and URL-encoded requests.
- Mounts the router under `/api`.

### `src/lib/logger.ts`

This file configures the logger.
- Uses `pino`.
- Uses pretty output in development.
- Hides sensitive header values from logs.

### `src/lib/db.ts`

This file connects to PostgreSQL.
- Uses `DATABASE_URL` in development.
- Uses `NEON_DATABASE_URL` in production if set.
- Throws an error if neither is configured.

### `drizzle.config.ts`

This file configures Drizzle Kit for generating and applying migrations.
- Reads the database connection from `DATABASE_URL` or `NEON_DATABASE_URL`.
- Stores generated SQL files in the `drizzle/` folder.

### `src/routes/` folder

This folder contains the API route definitions.
- `auth.ts` handles authentication.
- `courses.ts`, `lessons.ts`, `progress.ts`, `quizzes.ts`, and `users.ts` handle related resources.
- `storage.ts` handles file uploads and downloads.
- `settings.ts` and `stats.ts` provide app settings and statistics.

### `build.mjs`

This file creates a production build.
- Uses `esbuild` to bundle the app into `dist/`.
- Outputs ESM files with `.mjs` extension.
- Keeps the production deploy command simple: `npm run build` and `npm run start`.

### `render.yaml`

This is the Render deployment manifest.
- Tells Render how to build and start the app.
- Declares required environment variables.

## Important notes for beginners

- The app relies on a PostgreSQL database, so `DATABASE_URL` must be valid.
- If you see an error like `No database connection string configured`, set `DATABASE_URL` or `NEON_DATABASE_URL` in `.env`.
- The server uses environment variables to control behavior, so the `.env` file is very important.
- Migrations are applied automatically on startup, but you can also run them manually with `npm run db:migrate`.

## Recommended next steps

- Read `src/index.ts` and `src/app.ts` to understand startup flow.
- Open `src/lib/db.ts` to see how the database connection is configured.
- Use `.env.example` as a template for your own environment file.
- Keep `SESSION_SECRET` secret and do not commit it to version control.
