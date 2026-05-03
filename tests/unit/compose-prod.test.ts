import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import yaml from "js-yaml";

// Phase 02.2 Plan 02.2-06 — live tests for docker-compose.prod.yml.
// Plan 02.2-01 reserved 6 it.skip blocks; Plan 02.2-06 flipped them live.

const composePath = "docker-compose.prod.yml";

interface ComposeService {
  image?: string;
  build?: unknown;
  restart?: string;
  volumes?: string[];
  logging?: { driver?: string; options?: Record<string, string> };
}

interface Compose {
  services: Record<string, ComposeService>;
  volumes: Record<string, unknown>;
}

describe("docker-compose.prod.yml structural invariants (Phase 02.2)", () => {
  it("Plan 02.2-06: docker-compose.prod.yml is a parseable YAML file", () => {
    const content = readFileSync(composePath, "utf-8");
    expect(() => yaml.load(content)).not.toThrow();
  });

  it("Plan 02.2-06: every service in docker-compose.prod.yml has restart: unless-stopped (D-22a)", () => {
    const content = readFileSync(composePath, "utf-8");
    const compose = yaml.load(content) as Compose;
    expect(Object.keys(compose.services).length).toBeGreaterThanOrEqual(5);
    for (const [name, service] of Object.entries(compose.services)) {
      expect(service.restart, `service '${name}' must have restart: unless-stopped`).toBe(
        "unless-stopped",
      );
    }
  });

  it("Plan 02.2-06: postgres / app / worker / scheduler / nginx services exist", () => {
    const content = readFileSync(composePath, "utf-8");
    const compose = yaml.load(content) as Compose;
    expect(compose.services).toHaveProperty("postgres");
    expect(compose.services).toHaveProperty("app");
    expect(compose.services).toHaveProperty("worker");
    expect(compose.services).toHaveProperty("scheduler");
    expect(compose.services).toHaveProperty("nginx");
  });

  it("Plan 02.2-06: every service has logging.driver: json-file with max-size 10m / max-file 3", () => {
    const content = readFileSync(composePath, "utf-8");
    const compose = yaml.load(content) as Compose;
    for (const [name, service] of Object.entries(compose.services)) {
      expect(service.logging?.driver, `service '${name}' logging.driver`).toBe("json-file");
      expect(service.logging?.options?.["max-size"], `service '${name}' max-size`).toBe("10m");
      expect(service.logging?.options?.["max-file"], `service '${name}' max-file`).toBe("3");
    }
  });

  it("Plan 02.2-06: app/worker/scheduler use image ghcr.io/d954mas/neotolis-diary:${IMAGE_TAG:-latest} (NOT build:.)", () => {
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

  it("Plan 02.2-06: postgres uses named volume pg_data (not bind mount) per D-22a", () => {
    const content = readFileSync(composePath, "utf-8");
    const compose = yaml.load(content) as Compose;
    expect(compose.services.postgres?.volumes ?? []).toContain("pg_data:/var/lib/postgresql/data");
    expect(compose.volumes).toHaveProperty("pg_data");
  });
});
