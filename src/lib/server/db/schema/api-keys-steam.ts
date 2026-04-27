// api_keys_steam — KEYS-03..06, the typed-per-kind credential example (D-08).
//
// Envelope-encrypted at rest (D-12) — columns mirror EncryptedSecret from
// src/lib/server/crypto/envelope.ts. Plaintext NEVER returns to the
// client; toApiKeySteamDto in src/lib/server/dto.ts strips ciphertext at
// projection time even if a service-layer query returns the full row.
//
// last4 is INTENTIONALLY in the DB and IN the DTO (D-34) — last4 is a
// forensics aid for "which key was leaked", not a secret. Pino redact
// does not match `last4` (verified Phase 1 plan 01-01 redact paths).

import { pgTable, text, timestamp, smallint, customType, uniqueIndex, index } from "drizzle-orm/pg-core";
import { user } from "./auth.js";
import { uuidv7 } from "../../ids.js";

const bytea = customType<{ data: Buffer; default: false }>({ dataType: () => "bytea" });

export const apiKeysSteam = pgTable(
  "api_keys_steam",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    label: text("label").notNull(),
    last4: text("last4").notNull(),
    secretCt: bytea("secret_ct").notNull(),
    secretIv: bytea("secret_iv").notNull(),
    secretTag: bytea("secret_tag").notNull(),
    wrappedDek: bytea("wrapped_dek").notNull(),
    dekIv: bytea("dek_iv").notNull(),
    dekTag: bytea("dek_tag").notNull(),
    kekVersion: smallint("kek_version").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    rotatedAt: timestamp("rotated_at", { withTimezone: true }),
  },
  (t) => ({
    userIdx: index("api_keys_steam_user_id_idx").on(t.userId),
    // D-13 cardinality (Plan 02-05 multi-key choice): one row per labelled
    // Steamworks account. UNIQUE(user_id, label) prevents the same user from
    // re-using a label. There is currently no soft-delete column on this
    // table (D-14 hard-deletes via removeSteamKey), so the index is a plain
    // UNIQUE — no partial WHERE clause. If a later phase adds soft-delete
    // for keys, change this to a partial index in the same migration.
    userLabelUnique: uniqueIndex("api_keys_steam_user_label_unq").on(t.userId, t.label),
  }),
);
