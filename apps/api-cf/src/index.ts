import { Hono } from "hono";

const app = new Hono();

app.get("/", (c) => c.json({ status: "ok", service: "manga-api" }));

export default app;
