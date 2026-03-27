import express from "express";
import { createServer } from "http";
import path from "path";
import { fileURLToPath } from "url";
import { schedulingRouter } from "./routes/scheduling.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startServer() {
  const app = express();
  const server = createServer(app);

  // Parse JSON bodies for API routes
  app.use(express.json());

  // CORS for development (Vite dev server on 3005 calls this server on 3000)
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    const allowed = [
      "http://localhost:3005",
      "http://localhost:3006",
      "http://127.0.0.1:3005",
    ];
    if (origin && allowed.includes(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization,X-Clinic-Num,X-Source");
    }
    if (req.method === "OPTIONS") {
      res.sendStatus(204);
      return;
    }
    next();
  });

  // Mount scheduling API routes
  app.use("/api/scheduling", schedulingRouter);

  // Serve static files from dist/public in production
  const staticPath =
    process.env.NODE_ENV === "production"
      ? path.resolve(__dirname, "public")
      : path.resolve(__dirname, "..", "dist", "public");

  app.use(express.static(staticPath));

  // Handle client-side routing - serve index.html for all routes
  app.get("*", (_req, res) => {
    res.sendFile(path.join(staticPath, "index.html"));
  });

  const port = process.env.PORT || 3000;

  server.listen(port, () => {
    console.log(`Server running on http://localhost:${port}/`);
    console.log(`Scheduling API available at http://localhost:${port}/api/scheduling`);
  });
}

startServer().catch(console.error);
