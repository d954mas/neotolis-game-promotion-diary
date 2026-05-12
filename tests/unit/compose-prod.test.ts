import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import yaml from "js-yaml";

// Tests for docker-compose.prod.yml structural invariants.

const composePath = "docker-compose.prod.yml";

interface ComposeService {
  image?: string;
  build?: unknown;
  restart?: string;
  ports?: string[];
  volumes?: string[];
  environment?: Record<string, string>;
  logging?: { driver?: string; options?: Record<string, string> };
}

interface Compose {
  services: Record<string, ComposeService>;
  volumes: Record<string, unknown>;
}

describe("docker-compose.prod.yml structural invariants", () => {
  it("docker-compose.prod.yml is a parseable YAML file", () => {
    const content = readFileSync(composePath, "utf-8");
    expect(() => yaml.load(content)).not.toThrow();
  });

  it("every service in docker-compose.prod.yml has restart: unless-stopped", () => {
    const content = readFileSync(composePath, "utf-8");
    const compose = yaml.load(content) as Compose;
    expect(Object.keys(compose.services).length).toBeGreaterThanOrEqual(5);
    for (const [name, service] of Object.entries(compose.services)) {
      expect(service.restart, `service '${name}' must have restart: unless-stopped`).toBe(
        "unless-stopped",
      );
    }
  });

  it("postgres / app / worker / scheduler / nginx services exist", () => {
    const content = readFileSync(composePath, "utf-8");
    const compose = yaml.load(content) as Compose;
    expect(compose.services).toHaveProperty("postgres");
    expect(compose.services).toHaveProperty("app");
    expect(compose.services).toHaveProperty("worker");
    expect(compose.services).toHaveProperty("scheduler");
    expect(compose.services).toHaveProperty("nginx");
  });

  it("every service has logging.driver: json-file with max-size 10m / max-file 3", () => {
    const content = readFileSync(composePath, "utf-8");
    const compose = yaml.load(content) as Compose;
    for (const [name, service] of Object.entries(compose.services)) {
      expect(service.logging?.driver, `service '${name}' logging.driver`).toBe("json-file");
      expect(service.logging?.options?.["max-size"], `service '${name}' max-size`).toBe("10m");
      expect(service.logging?.options?.["max-file"], `service '${name}' max-file`).toBe("3");
    }
  });

  it("app/worker/scheduler use image ghcr.io/d954mas/neotolis-diary:${IMAGE_TAG:-latest} (NOT build:.)", () => {
    const content = readFileSync(composePath, "utf-8");
    const compose = yaml.load(content) as Compose;
    for (const name of ["app", "worker", "scheduler"] as const) {
      const svc = compose.services[name];
      expect(svc?.image, `${name} should have image`).toMatch(
        /^ghcr\.io\/d954mas\/neotolis-diary:/,
      );
      expect(svc?.build, `${name} must NOT have build:.`).toBeUndefined();
    }
  });

  it("postgres uses named volume pg_data (not bind mount)", () => {
    const content = readFileSync(composePath, "utf-8");
    const compose = yaml.load(content) as Compose;
    expect(compose.services.postgres?.volumes ?? []).toContain("pg_data:/var/lib/postgresql/data");
    expect(compose.volumes).toHaveProperty("pg_data");
  });

  // The production image does NOT bundle pino-pretty (dev dependency).
  // When NODE_ENV is unset or set to 'development', logger.ts loads
  // pino-pretty and the container crash-loops. Hard-pin NODE_ENV:
  // production in the environment block of every service that runs the
  // app image so operator-side .env mistakes don't surface.
  it("app/worker/scheduler hard-pin NODE_ENV: production in environment block", () => {
    const content = readFileSync(composePath, "utf-8");
    const compose = yaml.load(content) as Compose;
    for (const name of ["app", "worker", "scheduler"] as const) {
      const env = compose.services[name]?.environment ?? {};
      expect(env.NODE_ENV, `${name} should hard-pin NODE_ENV: production`).toBe("production");
    }
  });

  // nginx exposes only 443 (Cloudflare Full Strict mode connects via HTTPS
  // only). Origin port 80 is closed at every layer — UFW (§1 Step 2),
  // compose ports (this assertion), and nginx.conf.template (no
  // `listen 80`). HTTP→HTTPS redirect is delegated to Cloudflare's
  // "Always Use HTTPS" rule at the edge (§2 Step 4.4).
  //
  // Strict reading of constraint "plain HTTP only behind a TLS-terminating
  // proxy" interpreted as "origin never participates in plaintext HTTP,
  // even just to redirect".
  it("nginx exposes ONLY port 443 (no port 80) with cert volume mounted", () => {
    const content = readFileSync(composePath, "utf-8");
    const compose = yaml.load(content) as Compose;
    const nginx = compose.services.nginx;
    const ports = nginx?.ports ?? [];
    expect(ports, "nginx must expose 443").toEqual(expect.arrayContaining(["443:443"]));
    expect(ports, "nginx must NOT expose port 80 — CF handles HTTP→HTTPS redirect").not.toEqual(
      expect.arrayContaining(["80:80"]),
    );
    expect(ports, "nginx must NOT expose port 80 in any form").not.toContain("80");
    expect(nginx?.volumes ?? [], "nginx volumes").toEqual(
      expect.arrayContaining(["./nginx/certs:/etc/nginx/certs:ro"]),
    );
  });
});
