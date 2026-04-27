// Manually authored against Better Auth 1.6 default schema. Plan 05 verifies
// via `@better-auth/cli generate --diff` and patches only if the CLI output
// drifts from this hand-written shape.
//
// Better Auth's canonical core schema covers four tables: `user`, `session`,
// `account`, `verification`. All primary keys are TEXT but we override the
// default-fn so the value is a UUIDv7 string (D-06 — time-sortable,
// enumeration-safe).
//
// Source of truth: https://better-auth.com/docs/concepts/database

import { pgTable, text, timestamp, boolean } from "drizzle-orm/pg-core";
import { uuidv7 } from "../../ids.js";

export const user = pgTable("user", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => uuidv7()),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  name: text("name").notNull(),
  image: text("image"),
  // Phase 2 D-40: cookie + DB persisted theme preference. Default 'system'
  // honors prefers-color-scheme; explicit 'light' / 'dark' overrides.
  themePreference: text("theme_preference").notNull().default("system"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const session = pgTable("session", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => uuidv7()),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  token: text("token").notNull().unique(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const account = pgTable("account", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => uuidv7()),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  // accountId == google_sub for the Google provider (the stable Google user identifier).
  accountId: text("account_id").notNull(),
  // providerId == 'google' for our Google OAuth provider.
  providerId: text("provider_id").notNull(),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: timestamp("access_token_expires_at", {
    withTimezone: true,
  }),
  refreshTokenExpiresAt: timestamp("refresh_token_expires_at", {
    withTimezone: true,
  }),
  scope: text("scope"),
  // Unused — we only ship Google OAuth in MVP (no email/password). Better
  // Auth's core schema reserves the column; we keep it for adapter parity.
  password: text("password"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const verification = pgTable("verification", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => uuidv7()),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
});
