# KEK rotation (envelope encryption key)

Every stored secret (currently Steam Web API keys in `api_keys_steam`) is
envelope-encrypted: a random per-row DEK encrypts the secret, and the DEK is
wrapped by the KEK loaded from `APP_KEK_BASE64`. Rotating the KEK re-wraps every
DEK under a new key **without re-encrypting the secret itself** — `secret_ct`
stays byte-identical, so rotation is cheap and online.

This is the load-bearing trust property of self-host: a stolen database without
the server's env discloses nothing, and if you ever suspect the KEK leaked you
can rotate it with confidence because **the exact rotation code is CI-proven
every PR** (`tests/integration/kek-rotation.test.ts` runs the same
`rotateAllDeks` core this script calls — D-13). The drill is rehearsed, not
aspirational.

## When to rotate

- **Suspected KEK leak** — the env value was committed, logged, shared in a
  ticket, or exposed on a compromised host. Rotate, then retire the old KEK.
- **Periodic hygiene** — rotating on a schedule (e.g. yearly) bounds the blast
  radius of an undetected leak.
- **Operator handoff** — a new operator takes over the VPS; rotate so the
  departing operator's copy of the old KEK is worthless.

Rotation does NOT require downtime and does NOT touch the encrypted secrets
themselves — only the per-row DEK wrap changes.

## The 4-step rotation dance

You always keep BOTH KEKs loaded during rotation. New writes use the *current*
version; rotation re-wraps the old rows up to the new version; only after every
row is on the new version do you retire the old one.

### 1. Generate and load the new KEK (v2)

```bash
openssl rand -base64 32
```

Put the output in `.env` as `APP_KEK_V2_BASE64`, leave `KEK_CURRENT_VERSION=1`,
and restart the app:

```dotenv
APP_KEK_BASE64=<existing v1, unchanged>
APP_KEK_V2_BASE64=<the openssl output>
KEK_CURRENT_VERSION=1
```

```bash
cd /opt/diary && docker compose -f docker-compose.prod.yml up -d
```

После рестарта оба KEK загружены (v1 и v2). Новые записи всё ещё шифруются под
v1 — это правильно: сначала перешифровываем старые строки, и только потом
переключаем `KEK_CURRENT_VERSION`.

### 2. Dry-run first (verify, no writes)

```bash
pnpm tsx scripts/rotate-kek.ts --to 2 --dry-run
```

Dry-run расшифровывает каждую строку-кандидат под её текущим KEK (доказывает, что
строка целая) и считает кандидатов — НИ ОДНОГО UPDATE не делает. Ожидаемый вывод:

```
KEK rotation — DRY-RUN (no writes) → target v2
  api_keys_steam: candidates=<N> verified=<N> rotated=0 failures=0
```

Если `failures` не ноль — НЕ продолжай. В выводе будут id повреждённых строк;
разберись с ними (повреждение БД / неверный KEK) перед реальной ротацией.

### 3. Rotate (re-wrap every DEK to v2)

```bash
pnpm tsx scripts/rotate-kek.ts --to 2
```

Перешифровывает каждый `api_keys_steam` DEK под v2; `secret_ct` не трогается.
Команда **идемпотентна и возобновляема** — `kek_version` это чекпоинт (выбираются
только строки `WHERE kek_version < 2`), поэтому повторный запуск после обрыва
безопасен и просто до-ротирует оставшееся. Ожидаемый вывод:

```
KEK rotation — ROTATE → target v2
  api_keys_steam: candidates=<N> verified=<N> rotated=<N> failures=0
```

Exit code 0 = чисто; 1 = хотя бы одна строка не перешифровалась (id выведены в
stderr). Для больших таблиц можно задать `--batch-size <n>` (по умолчанию 500).

### 4. Promote v2 (new writes use v2)

Когда `rotated` покрыл всех кандидатов, переключи текущую версию и перезапусти:

```dotenv
KEK_CURRENT_VERSION=2
```

```bash
cd /opt/diary && docker compose -f docker-compose.prod.yml up -d
```

Теперь новые секреты пишутся под v2, а старые строки уже перешифрованы под v2.

## Rollback

Пока ОБА KEK загружены (v1 = `APP_KEK_BASE64`, v2 = `APP_KEK_V2_BASE64`),
ротация обратима — re-wrap откатывать НЕ нужно:

- **Откат текущей версии:** верни `KEK_CURRENT_VERSION=1` и перезапусти. Новые
  секреты снова пишутся под v1; строки, уже перешифрованные под v2, продолжают
  расшифровываться, пока v2 остаётся в `KEK_VERSIONS`. Этого достаточно для
  отката.
- **Обратного re-wrap (v2 → v1) у скрипта нет.** Курсор `rotateAllDeks` идёт
  только вперёд (`WHERE kek_version < to`), поэтому `--to 1` не возьмёт ни одной
  строки (все уже на v2) — это no-op, а не откат. Так и задумано: пока v2
  загружен, перешифровывать DEK обратно незачем.

Окно отката закрывается на retire (см. ниже): не удаляй v2, пока хоть одна
строка на v2, иначе эти строки перестанут расшифровываться.

## Retire v1

Перед удалением старого KEK убедись, что НИ ОДНОЙ строки на v1 не осталось:

```bash
docker compose -f docker-compose.prod.yml exec -T postgres \
  psql -U postgres -d neotolis -c \
  "SELECT count(*) FROM api_keys_steam WHERE kek_version < 2;"
```

Должно вернуть `0`. Только тогда retire v1:

1. **НЕ переноси нумерацию.** Оставь `KEK_CURRENT_VERSION=2` и НЕ удаляй
   `APP_KEK_V2_BASE64` — все строки имеют `kek_version=2` и расшифровываются
   ТОЛЬКО под этим ключом. `env.ts` грузит v2 исключительно из
   `APP_KEK_V2_BASE64` (см. `kekVersions.set(v, …)` для v2..v9).
   > ⚠️ Раньше здесь предлагалось «promote v2 в слот v1» (значение
   > `APP_KEK_V2_BASE64` → `APP_KEK_BASE64`, `KEK_CURRENT_VERSION=1`, убрать
   > `APP_KEK_V2_BASE64`). Это ЛОМАЕТ расшифровку: строки остаются помечены
   > version 2, а версии 2 в `KEK_VERSIONS` больше нет → `loadKek(2)` падает.
   > Никогда так не делай, пока хоть одна строка на v2.
2. **Уничтожь старый (возможно, утёкший) ключ v1:** перезапиши `APP_KEK_BASE64`
   свежим СЛУЧАЙНЫМ 32-байтным значением (`openssl rand -base64 32`). Слот v1
   обязателен в `env.ts`, но после ротации ни одна строка на него не ссылается,
   поэтому новое значение никогда не используется для расшифровки — оно лишь
   вытесняет старый ключ из конфигурации.
3. Перезапусти: `docker compose -f docker-compose.prod.yml up -d`.
4. Уничтожь старое значение v1 везде, где оно хранилось (менеджер паролей,
   бэкапы `.env`, тикеты).

После рестарта старый ключ v1 нигде не загружен — утёкший KEK бесполезен (он
оборачивал только прежние `wrapped_dek`, которых в БД уже нет; v2 остаётся
текущим и обслуживает все строки). Полностью убрать сам слот v1
(`APP_KEK_BASE64` сейчас обязателен в `env.ts`) можно только изменением
env-модели — это отдельная задача, см. backlog.

## Why this is safe (the CI rehearsal)

`rotateAllDeks` — единственный путь ротации; и этот скрипт, и постоянный
интеграционный тест `tests/integration/kek-rotation.test.ts` (реальный Postgres)
импортируют ОДИН И ТОТ ЖЕ код. Тест на каждом PR доказывает: seed под v1 →
rotate → все `wrapped_dek` на v2, `secret_ct` побайтово неизменен, расшифровка
даёт исходный plaintext, повторный прогон — no-op, v1 retire-абелен, повреждённая
строка всплывает в `failures` (не пропускается молча). Поэтому инструкция выше —
отрепетированная процедура, а не бумажный transcript, который тихо протухает.

---

*See also: `docs/self-host/backups.md` (back up the DB before any rotation),
`docs/deploy/install.md` (env setup). The encryption module is
`src/lib/server/crypto/envelope.ts`; the batch core is
`src/lib/server/crypto/rotate-kek-batch.ts`.*
