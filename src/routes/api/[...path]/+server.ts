import type { RequestHandler } from "./$types";
import { createApp } from "$lib/server/http/app.js";

let app: ReturnType<typeof createApp> | null = null;

const handler: RequestHandler = ({ request }) => {
  if (!app) app = createApp();
  return app.fetch(request);
};

export const GET = handler;
export const POST = handler;
export const PUT = handler;
export const PATCH = handler;
export const DELETE = handler;
